/**
 * ADR 0315 addendum — after an email-suggested meeting with guests is
 * confirmed, say in the user's personal chat what actually happened: the
 * event was added, who the calendar invited (or why nobody was), and a link
 * that opens the event in Chord's calendar so the time or guests can be
 * changed. The card that was tapped cannot say this: the invitations are
 * sent by the calendar during the confirm, and only its answer is the truth.
 *
 * A `system` message, like ADR 0281's personal memory notice: no push, not
 * mirrored to a bridge, kept out of the model's history.
 */
import type { Kysely } from 'kysely';

import { SSE, type BotCard } from '@chord/kernel';

import type { DB, MessagesTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { getDefaultPersona } from '../bot-personas.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { rowToMessage } from '../messages.service.js';
import { sseHub } from '../sse.hub.js';

/** What `create_event` reported about the guests (executor `applyGuestChange`). */
export interface MeetingInviteOutcome {
  eventId?: string;
  invited?: string[];
  alreadyInvited?: string[];
  guestChange?: string;
  /** ADR 0223 — the meeting was already on the calendar with these people. */
  merged?: string;
  existingTitle?: string;
  /** ADR 0348 — the user added the meeting and chose not to invite anyone. */
  notInvited?: boolean;
}

const WHY_NOT: Record<string, string> = {
  not_on_calendar: 'the event is only in Chord, not on a connected Google or Outlook calendar',
  not_organizer: 'someone else organizes this event, so only they can invite people',
  provider_error: 'your calendar refused the invitation or could not be reached',
  not_found: 'the event could not be found',
};

/** The message text, from the calendar's own answer. Exported for tests. */
export function meetingInviteNoticeText(
  title: string,
  when: string,
  asked: string[],
  outcome: MeetingInviteOutcome,
): string {
  const invited = outcome.invited ?? [];
  const already = outcome.alreadyInvited ?? [];
  if (outcome.merged === 'covered') {
    const name = outcome.existingTitle ?? title;
    return `"${name}" (${when}) is already on your calendar with ${asked.join(', ')}, so nothing new was added and no invitations went out.`;
  }
  const head = `Added "${title}" (${when}) to your calendar`;
  if (outcome.notInvited) {
    return `${head}. No invitations were sent. Open it to invite ${asked.join(', ')}, or ask me to.`;
  }
  if (invited.length === 0 && already.length === 0) {
    const why = WHY_NOT[outcome.guestChange ?? ''] ?? 'the calendar did not accept the guests';
    return `${head}, but no invitations went out: ${why}. Nobody on ${asked.join(', ')} has been invited.`;
  }
  const parts = [
    invited.length > 0 ? `invited ${invited.join(', ')}` : '',
    already.length > 0 ? `${already.join(', ')} ${already.length === 1 ? 'was' : 'were'} already invited` : '',
  ].filter(Boolean);
  return `${head} and ${parts.join('; ')}. Open it to change the time or who is invited.`;
}

export async function postMeetingInviteNotice(
  db: Kysely<DB>,
  opts: {
    userId: string;
    title: string;
    startsAt: string;
    tz: string | null;
    asked: string[];
    outcome: MeetingInviteOutcome;
  },
): Promise<string> {
  const when = new Date(opts.startsAt).toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(opts.tz ? { timeZone: opts.tz } : {}),
  });
  const cards: BotCard[] = opts.outcome.eventId
    ? [
        {
          kind: 'event',
          title: opts.title,
          meta: when,
          subtitle: 'Open in calendar',
          href: `/calendar?event=${encodeURIComponent(opts.outcome.eventId)}`,
        },
      ]
    : [];
  const personal = await ensurePersonalGroup(db, opts.userId);
  const row: MessagesTable = {
    id: newId('m'),
    group_id: personal.id,
    sender_id: null,
    kind: 'system',
    body: meetingInviteNoticeText(opts.title, when, opts.asked, opts.outcome),
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 0,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 1,
  };
  await db.insertInto('messages').values(row).execute();
  if (cards.length > 0) {
    await db
      .insertInto('message_cards')
      .values({ message_id: row.id, cards_json: JSON.stringify(cards), created_at: row.created_at })
      .execute();
  }
  sseHub.broadcast(personal.id, SSE.message, rowToMessage(row, cards.length ? JSON.stringify(cards) : undefined));
  if (cards.length > 0) sseHub.broadcast(personal.id, SSE.botCard, { messageId: row.id, cards });
  return row.id;
}
