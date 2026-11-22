/**
 * ADR 0344 — a calendar item that looks like the real version of an event
 * Chord made from an email is not allowed to remove that event on its own.
 * Removing a pushed event that has guests makes the calendar email them a
 * cancellation, so the user is asked in their personal chat: a `delete_event`
 * card on a `system` message (ADR 0281/0315 shape: no push, not bridged, out
 * of the model's history). Nothing changes until they tap.
 */
import type { Kysely, Selectable } from 'kysely';

import { SSE, type BotCard } from '@chord/kernel';

import { runAfterCommit } from '../../db/after-commit.js';
import type { DB, EventsTable, MessagesTable } from '../../db/schema.js';
import { logger } from '../../config/logging.js';
import { newId } from '../../utils/ids.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { rowToMessage } from '../messages.service.js';
import { createProposal } from '../proposals.service.js';
import { sseHub } from '../sse.hub.js';

export type EmailTwinHow = 'arrived' | 'declined' | 'accepted';

const MIN_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 14 * 86_400_000;

function whenText(iso: string, tz: string | null): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(tz ? { timeZone: tz } : {}),
  });
}

/** The question, in words. Exported for tests. */
export function emailTwinQuestionText(
  how: EmailTwinHow,
  incoming: { title: string; when: string },
  twin: { title: string; when: string; onCalendar: boolean },
): string {
  const ours = `"${twin.title}" (${twin.when}), which Chord added from your email`;
  const head =
    how === 'declined'
      ? `You declined "${incoming.title}" (${incoming.when}). If ${ours} was the same meeting, you can remove it too.`
      : how === 'accepted'
        ? `You accepted "${incoming.title}" (${incoming.when}). If it is the same meeting as ${ours}, you can remove Chord's.`
        : `"${incoming.title}" (${incoming.when}) just came onto your calendar. If it is the same meeting as ${ours}, you can remove Chord's.`;
  const tail = twin.onCalendar
    ? ' Removing it deletes it from your calendar, and anyone invited to it gets a cancellation. Nothing changes until you tap.'
    : ' Nothing changes until you tap.';
  return head + tail;
}

async function alreadyAsked(db: Kysely<DB>, userId: string, eventId: string): Promise<boolean> {
  const rows = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'delete_event')
    .where('status', '=', 'pending')
    .execute();
  return rows.some((r) => {
    try {
      return (JSON.parse(r.args_json) as { eventId?: unknown }).eventId === eventId;
    } catch {
      return false;
    }
  });
}

/**
 * Ask whether `twin` should go now that `incoming` is on the calendar. Once
 * per event while a card for it is waiting. Never throws: a question that
 * could not be asked leaves both events in place, which is the safe side.
 */
export async function askAboutEmailTwin(
  db: Kysely<DB>,
  opts: {
    userId: string;
    twin: Selectable<EventsTable>;
    incoming: { title: string; startsAt: string };
    how: EmailTwinHow;
  },
): Promise<string | null> {
  const { userId, twin } = opts;
  try {
    if (await alreadyAsked(db, userId, twin.id)) return null;
    const user = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
    const tz = user?.last_tz ?? null;
    const personal = await ensurePersonalGroup(db, userId);
    const now = new Date();
    const messageId = newId('m');
    const body = emailTwinQuestionText(
      opts.how,
      { title: opts.incoming.title || 'An event', when: whenText(opts.incoming.startsAt, tz) },
      {
        title: twin.title,
        when: whenText(twin.starts_at, tz),
        onCalendar: !!(twin.gcal_event_id && twin.chord_uid),
      },
    );
    const row: MessagesTable = {
      id: messageId,
      group_id: personal.id,
      sender_id: null,
      kind: 'system',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: now.toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 0,
      bot_persona_id: getDefaultPersona().id,
      is_proactive: 1,
    };
    const cards: BotCard[] = [
      {
        kind: 'event',
        title: twin.title,
        meta: whenText(twin.starts_at, tz),
        subtitle: 'Added by Chord from your email',
        href: `/calendar?event=${encodeURIComponent(twin.id)}`,
      },
    ];
    await db.insertInto('messages').values(row).execute();
    await db
      .insertInto('message_cards')
      .values({ message_id: messageId, cards_json: JSON.stringify(cards), created_at: row.created_at })
      .execute();
    const startMs = Date.parse(twin.starts_at);
    const ttlMs = Number.isFinite(startMs)
      ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, startMs - now.getTime()))
      : MAX_TTL_MS;
    const proposal = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: messageId,
      toolName: 'delete_event',
      args: {
        eventId: twin.id,
        ...(twin.series_id ? { scope: 'this' } : {}),
        eventTitle: twin.title,
        eventStartsAt: twin.starts_at,
        why: `"${opts.incoming.title}" may be the same meeting`,
      },
      provenance: twin.source_raw_context,
      ttlMs,
    });
    const message = rowToMessage(row, JSON.stringify(cards));
    runAfterCommit(
      db,
      async () => {
        sseHub.broadcast(personal.id, SSE.message, message);
        sseHub.broadcast(personal.id, SSE.botCard, { messageId, cards });
        sseHub.broadcast(personal.id, SSE.proposalCreated, proposal);
      },
      'email twin question broadcast',
    );
    logger.info('email twin question asked', { userId, eventId: twin.id, how: opts.how });
    return proposal.id;
  } catch (err) {
    logger.warn('email twin question failed', { err, userId, eventId: twin.id });
    return null;
  }
}
