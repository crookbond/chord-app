import { sql, type Kysely, type RawBuilder } from 'kysely';

import type { BotCard, Message } from '@chord/kernel';
import { mentionsBot } from '@chord/kernel';
import type { DB, MessagesTable } from '../db/schema';
import { newId } from '../utils/ids';
import { getDefaultPersona } from './bot-personas.service';

export function rowToMessage(row: MessagesTable, cardsJson?: string | null): Message {
  return {
    id: row.id,
    groupId: row.group_id,
    senderId: row.sender_id,
    kind: row.kind,
    body: row.body,
    attachmentId: row.attachment_id ?? undefined,
    replyToId: row.reply_to_id ?? undefined,
    mentionsBot: row.mentions_bot === 1,
    createdAt: row.created_at,
    cards: cardsJson ? (JSON.parse(cardsJson) as BotCard[]) : undefined,
  };
}

export interface PostMessageInput {
  groupId: string;
  senderId: string | null;
  kind?: Message['kind'];
  body: string;
  attachmentId?: string;
  replyToId?: string;
  /**
   * Precomputed @-mention flag. When supplied, skips the kernel `mentionsBot`
   * regex — used by IM connectors that resolve platform-native mentions
   * (e.g. `<@U…>`, `@chord_bot`) before posting. Falls back to the regex
   * when omitted.
   */
  mentionsBot?: boolean;
  /**
   * 1 (default) = visible in Chord clients. 0 = silent (bot uses for
   * context but client filters out). See MessagesTable.chord_visible.
   */
  chordVisible?: number;
  /** Whether the body @-mentions any user other than the bot. */
  mentionsOthers?: boolean;
  /**
   * When false, suppress auto-mirroring of this bot reply to other
   * bridges (used by the relay tool's target='chord' path).
   */
  autoMirror?: boolean;
  source?: MessagesTable['source'];
  externalMessageId?: string;
  /** ADR 0027 — bot persona that authored this reply. NULL on user rows. */
  botPersonaId?: string;
}

export async function postMessage(
  db: Kysely<DB>,
  input: PostMessageInput,
): Promise<Message> {
  const id = newId('m');
  const now = new Date().toISOString();
  const kind = input.kind ?? (input.senderId ? 'text' : 'bot');
  const row: MessagesTable = {
    id,
    group_id: input.groupId,
    sender_id: input.senderId,
    kind,
    body: input.body,
    attachment_id: input.attachmentId ?? null,
    reply_to_id: input.replyToId ?? null,
    mentions_bot: (input.mentionsBot ?? mentionsBot(input.body, getDefaultPersona().mentionAliases)) ? 1 : 0,
    created_at: now,
    source: input.source ?? null,
    external_message_id: input.externalMessageId ?? null,
    chord_visible: input.chordVisible ?? 1,
    mentions_others: input.mentionsOthers ? 1 : 0,
    auto_mirror: input.autoMirror === false ? 0 : 1,
    bot_persona_id: input.botPersonaId ?? null,
    is_proactive: 0,
  };
  await db.insertInto('messages').values(row).execute();
  return rowToMessage(row);
}

export interface DeleteMessagesInput {
  groupId: string;
  userId: string;
  /** The selected messages. Omit with `all`. */
  ids?: string[];
  /** Every message in the chat as of now, loaded or not ("clear chat"). */
  all?: boolean;
}

export interface DeleteMessagesResult {
  /**
   * True in the personal chat, where the rows are really removed. False in a
   * shared chat, where they are only hidden from this user.
   */
  forEveryone: boolean;
  /** The rows removed or hidden by id. Empty for a shared-chat `all`. */
  deletedIds: string[];
  /** Visible messages this user no longer sees. */
  deleted: number;
  /** Named ids that matched nothing in this chat. */
  skipped: number;
}

const DELETE_CHUNK = 1000;

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deleted ids split into SSE-sized `messages.deleted` payloads. */
export function deletedIdBatches(ids: string[]): string[][] {
  return chunked(ids, 500);
}

async function isPersonalGroup(db: Kysely<DB>, groupId: string): Promise<boolean> {
  const g = await db.selectFrom('groups').select('kind').where('id', '=', groupId).executeTakeFirst();
  return g?.kind === 'personal';
}

/**
 * SQL condition: this message is still in `userId`'s view of its chat, i.e.
 * they have neither deleted it for themselves nor cleared the chat since it
 * was posted (ADR 0242), and its sender is not someone they blocked (ADR
 * 0298). `alias` is the messages table's name in the query.
 */
export function inViewOf(userId: string, alias = 'messages'): RawBuilder<boolean> {
  const id = sql.ref(`${alias}.id`);
  const groupId = sql.ref(`${alias}.group_id`);
  const createdAt = sql.ref(`${alias}.created_at`);
  const senderId = sql.ref(`${alias}.sender_id`);
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1 FROM message_hides mh
      WHERE mh.message_id = ${id} AND mh.user_id = ${userId}
    )
    AND NOT EXISTS (
      SELECT 1 FROM group_members cleared
      WHERE cleared.group_id = ${groupId}
        AND cleared.user_id = ${userId}
        AND cleared.cleared_at IS NOT NULL
        AND ${createdAt} <= cleared.cleared_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM blocks bl
      WHERE bl.blocker_user_id = ${userId} AND bl.blocked_user_id = ${senderId}
    )
  )`;
}

/** Personal chat: really remove the rows, hidden bot replies included. */
async function removeForEveryone(
  db: Kysely<DB>,
  groupId: string,
  requested: string[] | null,
): Promise<DeleteMessagesResult> {
  const base = () => db.selectFrom('messages').select(['id', 'chord_visible']).where('group_id', '=', groupId);
  const rows: { id: string; chord_visible: number }[] = [];
  if (requested) {
    for (const part of chunked(requested, DELETE_CHUNK)) {
      rows.push(...(await base().where('id', 'in', part).execute()));
    }
  } else {
    rows.push(...(await base().execute()));
  }

  // A directive turn's hidden bot reply (ADR 0022) goes with the message it
  // answered, so the bot's context forgets the exchange too.
  const ids = new Set(rows.map((r) => r.id));
  for (const part of chunked([...ids], DELETE_CHUNK)) {
    const receipts = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', groupId)
      .where('sender_id', 'is', null)
      .where('chord_visible', '=', 0)
      .where('reply_to_id', 'in', part)
      .execute();
    for (const r of receipts) ids.add(r.id);
  }

  const deletedIds = [...ids];
  for (const part of chunked(deletedIds, DELETE_CHUNK)) {
    await db.deleteFrom('messages').where('group_id', '=', groupId).where('id', 'in', part).execute();
  }
  return {
    forEveryone: true,
    deletedIds,
    deleted: rows.filter((r) => r.chord_visible === 1).length,
    skipped: requested ? requested.length - rows.length : 0,
  };
}

/** Shared chat: hide from this user only. Everyone else keeps the message. */
async function hideForUser(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  requested: string[] | null,
): Promise<DeleteMessagesResult> {
  const now = new Date().toISOString();
  if (!requested) {
    const seen = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('group_id', '=', groupId)
      .where('chord_visible', '=', 1)
      .where(inViewOf(userId))
      .executeTakeFirst();
    await db
      .updateTable('group_members')
      .set({ cleared_at: now })
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();
    // Everything up to now is covered by the marker; the per-message rows
    // for this chat are no longer needed.
    await db.deleteFrom('message_hides').where('group_id', '=', groupId).where('user_id', '=', userId).execute();
    return { forEveryone: false, deletedIds: [], deleted: Number(seen?.n ?? 0), skipped: 0 };
  }

  const found: string[] = [];
  for (const part of chunked(requested, DELETE_CHUNK)) {
    const rows = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', groupId)
      .where('chord_visible', '=', 1)
      .where('id', 'in', part)
      .where(inViewOf(userId))
      .execute();
    found.push(...rows.map((r) => r.id));
  }
  for (const part of chunked(found, DELETE_CHUNK)) {
    await db
      .insertInto('message_hides')
      .values(part.map((id) => ({ user_id: userId, message_id: id, group_id: groupId, created_at: now })))
      .onConflict((oc) => oc.columns(['user_id', 'message_id']).doNothing())
      .execute();
  }
  return {
    forEveryone: false,
    deletedIds: found,
    deleted: found.length,
    skipped: requested.length - found.length,
  };
}

/**
 * Delete chat messages (ADR 0242). In the personal chat the rows are removed.
 * In a shared chat the delete is for this user only: the messages leave their
 * view and stay for everyone else, so any message may be chosen, not just
 * their own. `all` clears the chat as of now; later messages show as usual.
 * Attachments are never removed here (ADR 0037 owns that).
 * The caller must already have checked membership.
 */
export async function deleteMessages(
  db: Kysely<DB>,
  input: DeleteMessagesInput,
): Promise<DeleteMessagesResult> {
  const personal = await isPersonalGroup(db, input.groupId);
  const requested = input.all ? null : [...new Set(input.ids ?? [])];
  if (requested && requested.length === 0) {
    return { forEveryone: personal, deletedIds: [], deleted: 0, skipped: 0 };
  }
  return personal
    ? removeForEveryone(db, input.groupId, requested)
    : hideForUser(db, input.groupId, input.userId, requested);
}

/**
 * The newest `count` messages still in the user's view, oldest first, leaving
 * out `exceptId` (the message that asked). For "delete the last 3".
 */
export async function recentDeletableMessageIds(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string; count: number; exceptId?: string | null },
): Promise<string[]> {
  let q = db
    .selectFrom('messages')
    .select('id')
    .where('group_id', '=', opts.groupId)
    .where('chord_visible', '=', 1)
    .where(inViewOf(opts.userId))
    .orderBy('created_at', 'desc')
    .limit(opts.count);
  if (opts.exceptId) q = q.where('id', '!=', opts.exceptId);
  const rows = await q.execute();
  return rows.map((r) => r.id).reverse();
}

export interface ListMessagesOpts {
  groupId: string;
  before?: string;
  limit?: number;
  /**
   * When true (default), filter out chord_visible=0 messages — these
   * are private bot interactions that the bot still uses for context
   * but Chord clients shouldn't render. Internal callers (LLM context
   * builder, retrieval) pass false to see everything.
   */
  visibleOnly?: boolean;
  /**
   * The member this list is for. Messages they deleted for themselves, or
   * that predate their last "clear chat", are left out (ADR 0242). Omit for
   * internal readers (the bot's context), which see the whole chat.
   */
  viewerId?: string;
}

export async function listMessages(
  db: Kysely<DB>,
  opts: ListMessagesOpts,
): Promise<Message[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let q = db
    .selectFrom('messages')
    .leftJoin('message_cards', 'message_cards.message_id', 'messages.id')
    .selectAll('messages')
    .select('message_cards.cards_json as cardsJson')
    .where('messages.group_id', '=', opts.groupId)
    .orderBy('messages.created_at', 'desc')
    .limit(limit);
  if (opts.before) q = q.where('messages.created_at', '<', opts.before);
  if (opts.visibleOnly !== false) q = q.where('messages.chord_visible', '=', 1);
  if (opts.viewerId) q = q.where(inViewOf(opts.viewerId));
  const rows = await q.execute();
  const visible = rows.reverse().map((r) => rowToMessage(r, r.cardsJson));

  // ADR 0022: directive bot turns persist at chord_visible=0 and surface
  // as a receipt strip beneath the trigger message. The `bot.receipt`
  // SSE event isn't replayed on history fetch, so attach receipt data
  // here by looking up the invisible bot reply for each visible message.
  const triggerIds = visible.filter((m) => m.kind !== 'bot').map((m) => m.id);
  if (opts.visibleOnly !== false && triggerIds.length > 0) {
    const replies = await db
      .selectFrom('messages')
      .leftJoin('message_cards', 'message_cards.message_id', 'messages.id')
      .select([
        'messages.id as botMessageId',
        'messages.reply_to_id as triggerMessageId',
        'message_cards.cards_json as cardsJson',
      ])
      .where('messages.group_id', '=', opts.groupId)
      .where('messages.kind', '=', 'bot')
      .where('messages.chord_visible', '=', 0)
      .where('messages.reply_to_id', 'in', triggerIds)
      .execute();
    const byTrigger = new Map<string, { botMessageId: string; cards: BotCard[] }>();
    for (const r of replies) {
      if (!r.triggerMessageId || !r.botMessageId) continue;
      const cards: BotCard[] = r.cardsJson ? (JSON.parse(r.cardsJson) as BotCard[]) : [];
      byTrigger.set(r.triggerMessageId, { botMessageId: r.botMessageId, cards });
    }
    for (const m of visible) {
      const r = byTrigger.get(m.id);
      if (r) {
        m.receipt = {
          botMessageId: r.botMessageId,
          status: 'ok',
          toolNames: [],
          cards: r.cards,
        };
      }
    }
  }
  return visible;
}
