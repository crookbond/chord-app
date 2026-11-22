/**
 * ADR 0163 — a meeting remembers why. Distinct from ADR 0162's context
 * excerpt (which only looks at the ONE message/thread that directly
 * triggered `create_event`): this searches the user's OWN mailbox broadly
 * for prior correspondence with an invited attendee — the negotiation that
 * produced the meeting is often a different thread than whatever chat
 * message told the bot to add it — and, only when something is found, spends
 * one small LLM call condensing it into a short "what this is about" phrase.
 *
 * No correspondence found → no LLM call, `null`. Computed ONCE at invite
 * time (see `executor.ts`'s create_event/update_event cases) and cached on
 * `events.meeting_context`; never recomputed at render/briefing time (no
 * model runs then — ADR 0087's rule).
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { sealField } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { bodyForModel, cleanSnippet } from '../../utils/email-text.js';
import { getLlmForUser } from '../llm/factory.js';
import { canUseAi, isAiRefusal } from '../llm/refusal.js';
import { queueAiWork } from '../ai-backlog.service.js';

const MAX_ATTENDEES = 3;
const WINDOW_DAYS = 60;
const MAX_MESSAGES = 2;
const MAX_EXCERPT_CHARS = 600;
const MAX_PROMPT_CHARS = 1500;
const MAX_PHRASE_CHARS = 100;

export interface MatchedMessage {
  subject: string;
  excerpt: string;
  internalDate: string;
}

/** Injectable so tests can pin a deterministic phrase instead of depending
 *  on the mock LLM's regex matching this module's exact prompt (mirrors
 *  `trip-extraction.ts`'s injectable `TravelClassifier`). Defaults to the
 *  real LLM call. */
export type CorrespondenceSummarizer = (
  db: Kysely<DB>,
  userId: string,
  withWhom: string,
  messages: MatchedMessage[],
) => Promise<string | null>;

/** Prior correspondence with `attendeeEmail`, either direction, in the
 *  user's own mailbox only (ADR 0065/0114's sender-scoped-only discipline —
 *  never a cross-user search), newest first. */
async function findCorrespondence(
  db: Kysely<DB>,
  userId: string,
  attendeeEmail: string,
  windowStart: string,
): Promise<MatchedMessage[]> {
  const { rows } = await sql<{
    subject: string;
    snippet: string;
    body_text: string | null;
    body_html: string | null;
    body_excerpt: string | null;
    internal_date: string;
  }>`
    select subject, snippet, body_text, body_html, body_excerpt, internal_date
    from email_messages
    where user_id = ${userId}
      and internal_date >= ${windowStart}
      and (
        lower(from_email) = lower(${attendeeEmail})
        or exists (select 1 from jsonb_array_elements_text(to_emails) e where lower(e) = lower(${attendeeEmail}))
        or exists (select 1 from jsonb_array_elements_text(cc_emails) e where lower(e) = lower(${attendeeEmail}))
      )
    order by internal_date desc
    limit ${MAX_MESSAGES}
  `.execute(db);
  return rows.map((r) => ({
    subject: cleanSnippet(r.subject) || '(no subject)',
    excerpt: (
      bodyForModel({ html: r.body_html, text: r.body_text, excerpt: r.body_excerpt }) || cleanSnippet(r.snippet)
    ).slice(0, MAX_EXCERPT_CHARS),
    internalDate: r.internal_date,
  }));
}

/** One bounded LLM call condensing the found correspondence into a short
 *  phrase. Deterministic parse: `NONE`/empty/oversized → null, never a
 *  guess. Never throws — a failed call just means no meeting context. */
const summarizeCorrespondence: CorrespondenceSummarizer = async (db, userId, withWhom, messages) => {
  const body = messages
    .map((m) => `Subject: ${m.subject}\n${m.excerpt}`)
    .join('\n---\n')
    .slice(0, MAX_PROMPT_CHARS);
  try {
    const llm = await getLlmForUser(db, userId, 'meeting_context');
    const raw = await llm.complete(
      [
        {
          role: 'system',
          content:
            `Below is an email exchange with ${withWhom}. In 3-8 words, name what it's about — ` +
            `e.g. "budget, timeline, and staffing". Reply with ONLY that phrase, nothing else, no ` +
            `quotes, no punctuation at the end. If you cannot tell what it's about, reply exactly NONE.`,
        },
        { role: 'user', content: body },
      ],
      { temperature: 0, maxTokens: 40 },
    );
    const phrase = raw.trim().replace(/^["']+|["']+$/g, '').replace(/\.$/, '');
    if (!phrase || phrase.toUpperCase() === 'NONE' || phrase.length > MAX_PHRASE_CHARS) return null;
    return phrase;
  } catch (err) {
    // A refusal (consent, allowance) is not "nothing to say": the caller queues it.
    if (isAiRefusal(err)) throw err;
    logger.warn('meeting-context: llm call failed', { err: (err as Error).message, userId });
    return null;
  }
};

/**
 * Build a short "what this meeting is about" from prior correspondence with
 * its invitee(s), or null when there's nothing to say (no attendees, no
 * correspondence found, the flag is off, or the LLM call failed).
 */
export async function buildMeetingContext(
  db: Kysely<DB>,
  userId: string,
  attendeeEmails: string[],
  around: string,
  summarize: CorrespondenceSummarizer = summarizeCorrespondence,
): Promise<string | null> {
  if (!env.MEETING_CONTEXT_ENABLED) return null;

  const caller = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', userId)
    .executeTakeFirst();
  const callerEmail = caller?.email?.toLowerCase().trim() ?? null;
  const attendees = [
    ...new Set(attendeeEmails.map((e) => e.toLowerCase().trim()).filter((e) => e.length > 0)),
  ]
    .filter((e) => e !== callerEmail)
    .slice(0, MAX_ATTENDEES);
  if (attendees.length === 0) return null;

  const windowStartMs = Date.parse(around);
  const windowStart = new Date(
    Number.isFinite(windowStartMs) ? windowStartMs - WINDOW_DAYS * 24 * 60 * 60 * 1000 : Date.now(),
  ).toISOString();

  // Bounded at MAX_ATTENDEES (3) — a plain Promise.all needs no concurrency
  // limit on top of that natural cap.
  const perAttendee = await Promise.all(
    attendees.map((attendee) => findCorrespondence(db, userId, attendee, windowStart)),
  );
  const allMatches = perAttendee.flat();
  if (allMatches.length === 0) return null;

  const top = allMatches.sort((a, b) => b.internalDate.localeCompare(a.internalDate)).slice(0, MAX_MESSAGES);
  return summarize(db, userId, attendees.join(', '), top);
}

/**
 * `buildMeetingContext` + persist. Meant to be called fire-and-forget
 * (`void buildAndStoreMeetingContext(...).catch(...)`) right after an
 * event's invitees are resolved — never blocks the tool call's reply, and a
 * failure here must never surface as a failed event creation.
 */
export async function buildAndStoreMeetingContext(
  db: Kysely<DB>,
  userId: string,
  eventId: string,
  attendeeEmails: string[],
  summarize: CorrespondenceSummarizer = summarizeCorrespondence,
): Promise<void> {
  // Reached from a confirmed email card as well as a chat turn; only the turn
  // had checked consent and allowance (ADR 0283/0079). Held back, it is built
  // once both are met (ai-backlog).
  if (!(await canUseAi(db, userId))) {
    await queueAiWork(db, { userId, kind: 'meeting_context', ref: eventId, payload: { attendeeEmails } });
    return;
  }
  const event = await db
    .selectFrom('events')
    .select(['starts_at'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  let context: string | null;
  try {
    context = await buildMeetingContext(
      db,
      userId,
      attendeeEmails,
      event?.starts_at ?? new Date().toISOString(),
      summarize,
    );
  } catch (err) {
    if (!isAiRefusal(err)) throw err;
    await queueAiWork(db, { userId, kind: 'meeting_context', ref: eventId, payload: { attendeeEmails } });
    return;
  }
  if (!context) return;
  // ADR 0201 - a summary of the user's own correspondence, sealed under them.
  await db
    .updateTable('events')
    .set({ meeting_context: await sealField(userId, 'events:meeting_context', context) })
    .where('id', '=', eventId)
    .execute();
}
