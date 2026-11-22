/**
 * Fans Chord messages out to registered devices as push notifications
 * (ADR 0054). Mirrors the IM connector outbound-publisher (ADR 0010): it
 * listens on every `sseHub.broadcast` and, for each `SSE.message`, pushes to
 * the group's members minus the message's own sender.
 *
 * Because proactive nudges, bot replies, and human messages ALL flow through
 * `sseHub.broadcast(groupId, SSE.message, msg)`, hooking that one path covers
 * every notification trigger:
 *   - proactive nudges / daily briefings — kind='bot', sender_id=null → all members
 *   - bot replies & @mentions            — kind='bot', sender_id=null → all members
 *   - new group messages                 — kind='text'|'file'         → members ≠ author
 * `system` messages are skipped.
 */
import type { Kysely } from 'kysely';

import { SSE } from '@chord/kernel';
import type { Message } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { isScheduledBriefing } from '../../db/schema.js';
import type { DB } from '../../db/schema.js';
import { runInBackground } from '../../utils/background.js';
import { isLeader } from '../cluster/leadership.js';
import { sseHub } from '../sse.hub.js';
import { sendPush } from './expo.service.js';
import { isQuietNow } from './quiet-hours.js';

const PUSH_KINDS = new Set<Message['kind']>(['text', 'file', 'bot']);

export type Category = 'messages' | 'email' | 'bot' | 'briefing';

// The per-user column gating each category, and whether quiet hours applies.
// The briefing is exempt: it fires at the user's own nudge schedule.
const CATEGORY_META: Record<
  Category,
  {
    column: 'notify_messages' | 'notify_email' | 'notify_bot' | 'notify_briefing';
    quietApplies: boolean;
  }
> = {
  messages: { column: 'notify_messages', quietApplies: true },
  // New mail respects quiet hours for the obvious reason: it is the category
  // most likely to arrive at 3am (ADR 0117).
  email: { column: 'notify_email', quietApplies: true },
  bot: { column: 'notify_bot', quietApplies: true },
  briefing: { column: 'notify_briefing', quietApplies: false },
};

/**
 * Tokens for the users among `userIds` who should actually receive a push of
 * this category: their toggle is on, they are not inside quiet hours, and they
 * have a device registered.
 *
 * Shared by the group path and the email one (ADR 0117) rather than written
 * twice — quiet hours is exactly the rule that would drift if a second caller
 * reimplemented it, and the drift would be invisible until 3am.
 */
export async function eligibleTokens(
  db: Kysely<DB>,
  userIds: string[],
  category: Category,
  now: Date = new Date(),
): Promise<string[]> {
  if (userIds.length === 0) return [];
  const meta = CATEGORY_META[category];
  const candidates = await db
    .selectFrom('users as u')
    .select([
      'u.id as user_id',
      'u.last_tz as last_tz',
      'u.quiet_enabled as quiet_enabled',
      'u.quiet_start_hour as quiet_start_hour',
      'u.quiet_start_minute as quiet_start_minute',
      'u.quiet_end_hour as quiet_end_hour',
      'u.quiet_end_minute as quiet_end_minute',
    ])
    .where('u.id', 'in', userIds)
    .where(`u.${meta.column}`, '=', 1)
    .execute();

  const awake = candidates
    .filter((c) => {
      if (!meta.quietApplies || c.quiet_enabled !== 1) return true;
      return !isQuietNow(
        c.last_tz,
        {
          startHour: c.quiet_start_hour,
          startMinute: c.quiet_start_minute,
          endHour: c.quiet_end_hour,
          endMinute: c.quiet_end_minute,
        },
        now,
      );
    })
    .map((c) => c.user_id);
  if (awake.length === 0) return [];

  const tokenRows = await db
    .selectFrom('push_tokens')
    .select('token')
    .where('user_id', 'in', awake)
    .execute();
  return tokenRows.map((r) => r.token);
}

/**
 * Classify the message. text/file → 'messages'. A bot message is a reply, or
 * one of the several things Chord starts by itself — we look the row up only
 * for bot messages, since the kernel Message carries neither field.
 *
 * `is_proactive` alone used to decide this, so EVERY proactive kind landed in
 * 'briefing' — the one category that is quiet-hours exempt, because it "fires
 * at the user's own nudge schedule". An event-created echo and a reconnect
 * warning do not, and were waking people at 3am on a technicality (ADR 0137).
 */
async function classify(db: Kysely<DB>, msg: Message): Promise<Category> {
  if (msg.kind !== 'bot') return 'messages';
  const row = await db
    .selectFrom('messages')
    .select(['is_proactive', 'proactive_kind'])
    .where('id', '=', msg.id)
    .executeTakeFirst();
  if (row?.is_proactive !== 1) return 'bot';
  return isScheduledBriefing(row.proactive_kind) ? 'briefing' : 'bot';
}

export function startPushPublisher(db: Kysely<DB>): () => void {
  return sseHub.onBroadcast((channel, event, data) => {
    if (!env.PUSH_ENABLED) return;
    if (event !== SSE.message) return;
    // ADR 0280 — every worker copy hears every broadcast; one of them pushes.
    if (!isLeader('worker')) return;
    const msg = data as Message;
    if (!PUSH_KINDS.has(msg.kind)) return;

    runInBackground(
      deliver(db, channel, msg).catch((err) =>
        logger.warn('push publisher: deliver crashed', { err }),
      ),
    );
  });
}

/**
 * Resolve the device tokens that should receive a push for `msg` in `groupId`,
 * applying every gate: exclude the author, exclude members who muted the group
 * or blocked the author (ADR 0298),
 * require the recipient's category toggle, and drop recipients currently in
 * their quiet-hours window (briefing exempt). Exported for unit testing.
 */
export async function selectRecipientTokens(
  db: Kysely<DB>,
  groupId: string,
  msg: Message,
  now: Date = new Date(),
): Promise<string[]> {
  const category = await classify(db, msg);

  // Group membership and the mute are this path's own; the toggle, quiet hours
  // and token lookup are shared with email (ADR 0117).
  let q = db
    .selectFrom('group_members as gm')
    .select('gm.user_id as user_id')
    .where('gm.group_id', '=', groupId)
    .where('gm.muted', '=', 0);
  if (msg.senderId) {
    const senderId = msg.senderId;
    q = q.where('gm.user_id', '!=', senderId).where((eb) =>
      // ADR 0298: nobody is pushed a message from someone they blocked.
      eb.not(
        eb.exists(
          eb
            .selectFrom('blocks')
            .select('blocks.blocker_user_id')
            .whereRef('blocks.blocker_user_id', '=', 'gm.user_id')
            .where('blocks.blocked_user_id', '=', senderId),
        ),
      ),
    );
  }
  const members = (await q.execute()).map((r) => r.user_id);
  return eligibleTokens(db, members, category, now);
}

/** Push titles are group names, read once a minute at most per group: a
 *  busy chat pushes on every message. A rename shows within the minute. */
const NAME_TTL_MS = 60_000;
const NAME_CACHE_MAX = 500;
const nameCache = new Map<string, { name: string | null; at: number }>();

async function groupName(db: Kysely<DB>, groupId: string): Promise<string | null> {
  const now = Date.now();
  const hit = nameCache.get(groupId);
  if (hit && now - hit.at < NAME_TTL_MS) return hit.name;
  const row = await db
    .selectFrom('groups')
    .select('name')
    .where('id', '=', groupId)
    .executeTakeFirst();
  const name = row?.name ?? null;
  nameCache.delete(groupId);
  if (nameCache.size >= NAME_CACHE_MAX) {
    const oldest = nameCache.keys().next().value;
    if (oldest !== undefined) nameCache.delete(oldest);
  }
  nameCache.set(groupId, { name, at: now });
  return name;
}

async function deliver(
  db: Kysely<DB>,
  groupId: string,
  msg: Message,
): Promise<void> {
  const tokens = await selectRecipientTokens(db, groupId, msg);
  if (tokens.length === 0) return; // nobody eligible/registered → no Expo call

  const title = (await groupName(db, groupId)) ?? 'Chord';
  const body = msg.kind === 'file' ? '📎 Sent a file' : msg.body.slice(0, 180);

  await sendPush(db, tokens, {
    title,
    body,
    data: { groupId, messageId: msg.id, kind: msg.kind },
  });
}
