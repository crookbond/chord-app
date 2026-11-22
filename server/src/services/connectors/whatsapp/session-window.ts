/**
 * ADR 0089 — WhatsApp's 24-hour session window.
 *
 * WhatsApp only delivers free-form text within 24h of the *user's* last
 * message to the business. Chord's briefing is proactive and fires at the
 * user's `nudge_hour`, so for anyone who did not write yesterday it is
 * undeliverable as text — and undeliverable *silently*, because Twilio still
 * returns a message SID.
 *
 * Everything that decides what to do about that lives here: whether the window
 * is open, whether we may ask, and what the user's answer means. The publisher
 * and the callback handler call in; neither owns the policy.
 *
 * Only WhatsApp has a session window — Telegram, Slack and Discord do not — so
 * callers gate on platform before calling.
 */
import type { Kysely } from 'kysely';

import { env } from '../../../config/env';
import type { DB } from '../../../db/schema';
import { textInstant, validZone } from '../../../db/text-instant';
import { zonedDayStartUtc } from '../../../utils/tz';

/** Meta's window, minus a safety margin so a send that races the boundary
 *  is treated as closed rather than bouncing. */
const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;

/**
 * ADR 0089 §6 — an unanswered ask stops the asking. In production that read
 * as "forever": a user who never taps and never writes to the bot is silent
 * for good, which from their side is indistinguishable from a briefing that
 * broke. What §6 was actually protecting against is a *daily* unanswered
 * prompt, so the ask expires instead of being permanent — one billed
 * conversation per `WHATSAPP_NUDGE_REASK_DAYS`, not per morning.
 *
 * `days <= 0` restores the original ask-once-forever behaviour.
 */
export function askExpired(
  sentAt: string,
  now = Date.now(),
  days = env.WHATSAPP_NUDGE_REASK_DAYS,
): boolean {
  if (days <= 0) return false;
  const ts = Date.parse(sentAt);
  // An unparseable stamp is a corrupt write, not an ask we can date. Treat it
  // as expired so the next prompt overwrites it with something readable,
  // rather than muting the channel forever on a value nothing can interpret.
  if (!Number.isFinite(ts)) return true;
  return now - ts >= days * 24 * 60 * 60 * 1000;
}

export type ProactiveGate =
  /** Window is open — send the message as ordinary text. */
  | { action: 'send' }
  /** Window is closed and we have not asked lately. Send the template, park this. */
  | { action: 'prompt' }
  /** Muted, asked recently and unanswered, or not the briefing's ask to spend. */
  | {
      action: 'skip';
      reason: 'opted_out' | 'already_asked' | 'no_template' | 'window_closed';
    };

interface ChannelState {
  last_inbound_at: string | null;
  briefing_opted_out: number;
  nudge_prompt_sent_at: string | null;
}

async function loadChannel(
  db: Kysely<DB>,
  externalChannelId: string,
  groupId: string,
): Promise<ChannelState | undefined> {
  return await db
    .selectFrom('group_external_channels')
    .select(['last_inbound_at', 'briefing_opted_out', 'nudge_prompt_sent_at'])
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalChannelId)
    .where('group_id', '=', groupId)
    .executeTakeFirst();
}

export function windowOpen(lastInboundAt: string | null, now = Date.now()): boolean {
  if (!lastInboundAt) return false;
  const ts = Date.parse(lastInboundAt);
  return Number.isFinite(ts) && now - ts < WINDOW_MS;
}

/**
 * Decide how a *proactive* message may reach a WhatsApp binding. Replies are
 * never gated — the user just wrote, so the window is open by definition.
 *
 * `isBriefing` is what ADR 0137 added. The template is the BRIEFING's ask: it
 * opens "Good morning! Want your daily briefing?", carries the day's facts, and
 * parks the message behind a `Full briefing` button. Every other proactive kind
 * got the same treatment because the caller only knew `is_proactive`, so an
 * event-created echo at 9pm sent a good-morning briefing and parked an
 * unrelated conflict warning under that button. Those now `skip`: the ask is a
 * billed business-initiated conversation with a weekly cadence (ADR 0089 §6),
 * and spending it on an echo takes it from the briefing it belongs to.
 */
export async function gateProactiveSend(
  db: Kysely<DB>,
  opts: {
    externalChannelId: string;
    groupId: string;
    /** Whether an approved template SID is configured. */
    hasTemplate: boolean;
    /** Whether this message may spend the out-of-window template ask. */
    isBriefing: boolean;
  },
): Promise<ProactiveGate> {
  const row = await loadChannel(db, opts.externalChannelId, opts.groupId);
  // No binding row is not our call to make — let the send proceed and fail
  // loudly downstream rather than swallowing a message here.
  if (!row) return { action: 'send' };

  if (Number(row.briefing_opted_out) === 1) {
    return { action: 'skip', reason: 'opted_out' };
  }
  if (windowOpen(row.last_inbound_at)) return { action: 'send' };
  // Closed window, and this is not the briefing. Nothing goes out on WhatsApp;
  // the message is still in the app, in the other bindings, and in push.
  if (!opts.isBriefing) return { action: 'skip', reason: 'window_closed' };
  // Asked already and never answered — ADR 0089 §6, silence means stop. Only
  // until the ask expires, though: a stamp older than the re-ask interval is
  // treated as never asked at all.
  if (row.nudge_prompt_sent_at && !askExpired(row.nudge_prompt_sent_at)) {
    return { action: 'skip', reason: 'already_asked' };
  }
  if (!opts.hasTemplate) return { action: 'skip', reason: 'no_template' };
  return { action: 'prompt' };
}

/**
 * Stamp the window open. Called for EVERY inbound from the channel, including
 * button taps — a tap is a user-initiated event to Meta but is not a `messages`
 * row, which is why the window cannot be derived from message history.
 *
 * Writing also clears `nudge_prompt_sent_at`: the user re-engaged, so a future
 * closed-window morning is allowed to ask again.
 */
export async function recordInbound(
  db: Kysely<DB>,
  externalChannelId: string,
  at = new Date().toISOString(),
): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ last_inbound_at: at, nudge_prompt_sent_at: null })
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalChannelId)
    .execute();
}

/**
 * Record that the template went out, and park the briefing it replaced. A
 * re-ask overwrites the previous park on purpose: the briefing the user never
 * claimed is by then a week stale, and today's is the one they were promised.
 */
export async function markPrompted(
  db: Kysely<DB>,
  opts: { externalChannelId: string; groupId: string; messageId: string },
): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({
      nudge_prompt_sent_at: new Date().toISOString(),
      pending_briefing_message_id: opts.messageId,
    })
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', opts.externalChannelId)
    .where('group_id', '=', opts.groupId)
    .execute();
}

export interface ClaimedBriefing {
  groupId: string;
  /** What to deliver: the parked briefing, or today's when the parked one is old. */
  body: string;
  /**
   * Set when the parked briefing is from an earlier day and no briefing has
   * been posted today: the caller runs a fresh one for this user instead of
   * delivering `body`.
   */
  refreshForUserId?: string;
}

/** `iso`'s calendar day in `tz`, as YYYY-MM-DD. */
function dayIn(iso: string | number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/**
 * The user tapped Yes. Their tap opens the window, so hand back a briefing for
 * delivery and clear the park. Returns null when nothing is parked — a stale
 * tap on a prompt whose briefing was already delivered.
 *
 * The prompt goes out at most weekly (ADR 0089 §6), so the parked briefing can
 * be days old by the time it is tapped. "Full briefing" means today's: an old
 * park is swapped for today's posted briefing, or, when none was posted today,
 * flagged so the caller runs one now.
 */
export async function claimPendingBriefing(
  db: Kysely<DB>,
  externalChannelId: string,
  now = Date.now(),
): Promise<ClaimedBriefing | null> {
  const row = await db
    .selectFrom('group_external_channels')
    .select(['group_id', 'pending_briefing_message_id'])
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalChannelId)
    .where('pending_briefing_message_id', 'is not', null)
    .executeTakeFirst();
  if (!row?.pending_briefing_message_id) return null;

  await db
    .updateTable('group_external_channels')
    .set({ pending_briefing_message_id: null })
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalChannelId)
    .execute();

  const msg = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('id', '=', row.pending_briefing_message_id)
    .executeTakeFirst();
  if (!msg) return null;
  const parked: ClaimedBriefing = { groupId: row.group_id, body: msg.body };

  const owner = await db
    .selectFrom('groups')
    .innerJoin('users', 'users.id', 'groups.created_by')
    .select(['groups.kind', 'groups.created_by', 'users.last_tz'])
    .where('groups.id', '=', row.group_id)
    .executeTakeFirst();
  // ADR 0098: a briefing day is the user's, never the server's.
  const zone = validZone(owner?.last_tz || env.BRIEFING_DEFAULT_TZ);
  const today = dayIn(now, zone);
  if (dayIn(msg.created_at, zone) === today) return parked;

  const todays = await db
    .selectFrom('messages')
    .select(['body'])
    .where('group_id', '=', row.group_id)
    .where('proactive_kind', '=', 'daily_morning_scan')
    .where(textInstant('messages.created_at'), '>=', zonedDayStartUtc(today, zone).toISOString())
    .orderBy(textInstant('messages.created_at'), 'desc')
    .executeTakeFirst();
  if (todays) return { groupId: row.group_id, body: todays.body };

  // A briefing is generated into its owner's personal chat. A binding on any
  // other chat cannot receive a fresh one, so it keeps the parked briefing.
  if (owner?.kind !== 'personal' || !owner.created_by) return parked;
  return { ...parked, refreshForUserId: owner.created_by };
}

/**
 * The user tapped No. Channel-scoped only — `users.nudge_enabled` is
 * deliberately untouched so the briefing keeps arriving in-app and by push
 * (ADR 0089 §5).
 */
export async function optOutOfBriefing(
  db: Kysely<DB>,
  externalChannelId: string,
): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ briefing_opted_out: 1, pending_briefing_message_id: null })
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', externalChannelId)
    .execute();
}

/**
 * ADR 0091 — the inverse, for the Settings toggle. ADR 0089 shipped `n-` with
 * no way back short of re-binding the channel; this is that way back. Clearing
 * `nudge_prompt_sent_at` too means the next closed-window morning is allowed to
 * send again rather than reading as "already asked" forever.
 */
export async function resumeBriefing(
  db: Kysely<DB>,
  opts: { externalChannelId: string; groupId: string },
): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ briefing_opted_out: 0, nudge_prompt_sent_at: null })
    .where('platform', '=', 'whatsapp')
    .where('external_channel_id', '=', opts.externalChannelId)
    .where('group_id', '=', opts.groupId)
    .execute();
}
