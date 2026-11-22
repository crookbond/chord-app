/**
 * ADR 0343 — a booking confirmation from the same place for the same subject,
 * at a different time, may be a reschedule the email does not call one. The
 * card asks; this decides when to ask. No model call.
 */
import { sql, type Kysely } from 'kysely';

import type { ProposalReplaceOffer } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { instantInZoneMs } from '../../utils/tz.js';
import { readOnlyCalendars, sourceCalendarOf } from './read-only-calendars.js';

const WINDOW_MS = 90 * 86_400_000;

/** Words that say what kind of booking it is, not whose. */
const GENERIC = new Set([
  'appointment', 'appointments', 'appt', 'visit', 'meeting', 'reminder', 'confirmation', 'confirmed',
  'booking', 'booked', 'reservation', 'session', 'consult', 'consultation', 'exam', 'checkup', 'check',
  'follow', 'followup', 'annual', 'routine', 'new', 'call', 'class', 'lesson', 'service',
  'vet', 'veterinary', 'veterinarian', 'doctor', 'dentist', 'dental', 'clinic', 'office', 'center', 'centre',
  'with', 'for', 'the', 'and', 'your', 'from', 'about', 'at', 'on', 'of', 'to', 'in',
  'dr', 'mr', 'mrs', 'ms', 'am', 'pm',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
}

/**
 * The words two titles share that name the subject: three letters or more,
 * not a generic booking word, not part of the sender's own name or domain.
 */
export function sharedSubjectWords(a: string, b: string, senderWords: Iterable<string> = []): string[] {
  const skip = new Set([...GENERIC, ...senderWords]);
  const bs = new Set(words(b).filter((w) => !skip.has(w)));
  return [...new Set(words(a).filter((w) => !skip.has(w) && bs.has(w)))];
}

function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  if (!email || at < 0) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/** Labels of the domain and words of the sender's name, which every booking
 *  from them shares and so prove nothing about the subject. */
function senderWords(fromName: string | null, domain: string): string[] {
  return [...words(fromName ?? ''), ...words(domain)];
}

export interface ReplaceCandidateInput {
  id: string;
  tool_name: string;
  args_json: string;
  provenance: string | null;
  status?: string;
}

/**
 * The one event each pending email `create_event` may replace, keyed by
 * proposal id. A proposal with none, or with several, is left out.
 */
export async function replaceOffersFor(
  db: Kysely<DB>,
  userId: string,
  proposals: ReplaceCandidateInput[],
  nowMs = Date.now(),
): Promise<Map<string, ProposalReplaceOffer>> {
  const out = new Map<string, ProposalReplaceOffer>();
  const wanted: Array<{ id: string; threadId: string; title: string; startsAt: string }> = [];
  for (const p of proposals) {
    if (p.tool_name !== 'create_event' || (p.status && p.status !== 'pending')) continue;
    if (!p.provenance?.startsWith('gmail:')) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(p.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    // An invitation is answered, never moved onto something else (ADR 0104).
    if (args.alreadyInGoogle === true || args.repeat) continue;
    if (typeof args.title !== 'string' || typeof args.startsAt !== 'string') continue;
    wanted.push({ id: p.id, threadId: p.provenance.slice('gmail:'.length), title: args.title, startsAt: args.startsAt });
  }
  if (wanted.length === 0) return out;

  const [user, threads] = await Promise.all([
    db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst(),
    db
      .selectFrom('email_threads')
      .select(['gmail_thread_id', 'from_email', 'from_name'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', 'in', [...new Set(wanted.map((w) => w.threadId))])
      .execute(),
  ]);
  const tz = user?.last_tz ?? null;
  const senderOf = new Map(threads.map((t) => [t.gmail_thread_id, t]));
  let readOnly: Set<string> | null = null;
  const byDomain = new Map<string, Awaited<ReturnType<typeof eventsFromDomain>>>();

  for (const w of wanted) {
    const sender = senderOf.get(w.threadId);
    const domain = domainOf(sender?.from_email);
    if (!sender || !domain) continue;
    const newMs = instantInZoneMs(w.startsAt, tz);
    if (!Number.isFinite(newMs)) continue;

    let events = byDomain.get(domain);
    if (!events) {
      events = await eventsFromDomain(db, userId, domain);
      byDomain.set(domain, events);
    }
    readOnly ??= await readOnlyCalendars(db, userId);
    const skipWords = senderWords(sender.from_name, domain);
    const matches = events.filter((e) => {
      const ms = instantInZoneMs(e.starts_at, tz);
      if (!Number.isFinite(ms) || ms <= nowMs || ms === newMs) return false;
      if (Math.abs(ms - newMs) > WINDOW_MS) return false;
      const cal = sourceCalendarOf(e);
      if (cal && readOnly!.has(cal)) return false;
      return sharedSubjectWords(e.title, w.title, skipWords).length > 0;
    });
    if (matches.length !== 1) continue;
    const e = matches[0]!;
    out.set(w.id, { eventId: e.id, title: e.title, startsAt: e.starts_at });
  }
  return out;
}

/** The user's own live single events made from mail sent by `domain`. */
function eventsFromDomain(db: Kysely<DB>, userId: string, domain: string) {
  return db
    .selectFrom('events')
    .innerJoin('email_threads', (j) =>
      j
        .on('email_threads.user_id', '=', userId)
        .on(sql<boolean>`events.source_raw_context = 'gmail:' || email_threads.gmail_thread_id`),
    )
    .select([
      'events.id as id',
      'events.title as title',
      'events.starts_at as starts_at',
      'events.source_raw_context as source_raw_context',
      'events.google_calendar_id as google_calendar_id',
      'events.external_uid as external_uid',
    ])
    .where('events.owner_user_id', '=', userId)
    .where('events.deleted_at', 'is', null)
    .where('events.status', '!=', 'cancelled')
    .where('events.series_id', 'is', null)
    .where('email_threads.from_email', 'ilike', `%@${domain}`)
    .orderBy('events.created_at', 'desc')
    .limit(50)
    .execute();
}
