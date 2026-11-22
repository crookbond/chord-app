/**
 * ADR 0281 — the chat card that says what Chord just learned, and keeps saying
 * where that fact stands. One card per fact. `memory_notices` links a fact to
 * the message carrying its card; `refreshMemoryNotice` is the only thing that
 * rewrites a card, and every path that changes a fact calls it.
 */
import type { Kysely } from 'kysely';

import { SSE, type BotCard, type Memory, type MemoryNoticeStatus } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB, MessagesTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { getDefaultPersona } from './bot-personas.service.js';
import { ensurePersonalGroup } from './groups.service.js';
import { rowToMessage } from './messages.service.js';
import { sseHub } from './sse.hub.js';

/** "favorite_cuisine" → "favorite cuisine". */
export function humanKey(key: string): string {
  return key.replace(/_/g, ' ');
}

/**
 * ADR 0333 — the live event for a new or proposed fact. A private fact
 * (`scope = 'persona'`) goes only to its owner's own channel: on the chat's
 * channel every member's device would receive its value.
 */
export function factEventChannel(m: Pick<Memory, 'groupId' | 'scope' | 'personaId'>): string {
  return m.scope === 'persona' && m.personaId ? `user:${m.personaId}` : m.groupId;
}

export function broadcastFact(event: typeof SSE.memoryCreated | typeof SSE.memoryProposed, m: Memory): void {
  sseHub.broadcast(factEventChannel(m), event, m);
}

/** Who each fact is about, as a person reads it: "Maya", "John", "Family". */
export async function labelMemorySubjects(
  db: Kysely<DB>,
  memories: Memory[],
): Promise<Map<string, string>> {
  const ids = (type: string) =>
    [...new Set(memories.filter((m) => m.subjectType === type && m.subjectId).map((m) => m.subjectId!))];
  const userIds = [
    ...new Set([...ids('user'), ...memories.filter((m) => !m.subjectType && m.personaId).map((m) => m.personaId!)]),
  ];
  const [users, personas, people] = await Promise.all([
    userIds.length
      ? db.selectFrom('users').select(['id', 'display_name', 'username']).where('id', 'in', userIds).execute()
      : [],
    ids('persona').length
      ? db.selectFrom('personas').select(['id', 'name']).where('id', 'in', ids('persona')).execute()
      : [],
    ids('person').length
      ? db.selectFrom('people').select(['id', 'display_name']).where('id', 'in', ids('person')).execute()
      : [],
  ]);
  const names = new Map<string, string>();
  for (const u of users) names.set(u.id, u.display_name || u.username);
  for (const p of personas) names.set(p.id, p.name);
  for (const p of people) names.set(p.id, p.display_name);

  const out = new Map<string, string>();
  for (const m of memories) {
    const subject = m.subjectType === 'household' || (!m.subjectType && m.scope === 'group')
      ? 'Family'
      : names.get(m.subjectId ?? m.personaId ?? '') ?? 'Someone';
    out.set(m.id, subject);
  }
  return out;
}

function metaFor(status: MemoryNoticeStatus, replacement?: string): string {
  if (status === 'proposed') return 'Chord noticed this. Keep it?';
  if (status === 'saved') return 'Remembered';
  if (status === 'replaced') return replacement ? `Updated to: ${replacement}` : 'Updated';
  return 'Removed';
}

export function memoryCard(
  m: Memory,
  subjectLabel: string,
  forUserId: string,
): BotCard {
  const status: MemoryNoticeStatus = m.status === 'confirmed' ? 'saved' : 'proposed';
  return {
    kind: 'memory',
    title: `${subjectLabel} · ${humanKey(m.key)}`,
    subtitle: m.value,
    meta: metaFor(status),
    memoryId: m.id,
    memoryStatus: status,
    memoryForUserId: forUserId,
  };
}

/** Build cards for freshly learned facts, labelled by subject. */
export async function memoryCards(
  db: Kysely<DB>,
  memories: Memory[],
  forUserId: string,
): Promise<BotCard[]> {
  const labels = await labelMemorySubjects(db, memories);
  return memories.map((m) => memoryCard(m, labels.get(m.id) ?? 'Someone', forUserId));
}

async function linkNotices(db: Kysely<DB>, messageId: string, cards: BotCard[]): Promise<void> {
  const now = new Date().toISOString();
  for (const c of cards) {
    if (c.kind !== 'memory' || !c.memoryId) continue;
    await db
      .insertInto('memory_notices')
      .values({ memory_id: c.memoryId, message_id: messageId, created_at: now })
      .onConflict((oc) => oc.column('memory_id').doUpdateSet({ message_id: messageId }))
      .execute();
  }
}

async function readCards(db: Kysely<DB>, messageId: string): Promise<BotCard[] | null> {
  const row = await db
    .selectFrom('message_cards')
    .select('cards_json')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.cards_json) as unknown;
    return Array.isArray(parsed) ? (parsed as BotCard[]) : [];
  } catch {
    return [];
  }
}

async function writeCards(db: Kysely<DB>, messageId: string, cards: BotCard[]): Promise<void> {
  await db
    .insertInto('message_cards')
    .values({ message_id: messageId, cards_json: JSON.stringify(cards), created_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('message_id').doUpdateSet({ cards_json: JSON.stringify(cards) }))
    .execute();
}

/**
 * Record the cards a bot reply already persisted (e.g. `remember_fact`'s), so
 * later changes to those facts update them. Called once the reply row exists.
 */
export async function linkReplyMemoryCards(
  db: Kysely<DB>,
  messageId: string,
  cards: BotCard[],
): Promise<void> {
  await linkNotices(db, messageId, cards);
}

/**
 * Add memory cards under an existing bot reply. The client replaces a
 * message's card list on `bot.card`, so the whole merged list is sent.
 */
export async function attachMemoryNotices(
  db: Kysely<DB>,
  opts: { messageId: string; groupId: string; cards: BotCard[] },
): Promise<void> {
  if (opts.cards.length === 0) return;
  const existing = (await readCards(db, opts.messageId)) ?? [];
  const held = new Set(existing.filter((c) => c.memoryId).map((c) => c.memoryId));
  const merged = [...existing, ...opts.cards.filter((c) => !held.has(c.memoryId))];
  await writeCards(db, opts.messageId, merged);
  await linkNotices(db, opts.messageId, opts.cards);
  sseHub.broadcast(opts.groupId, SSE.botCard, { messageId: opts.messageId, cards: merged });
}

/**
 * When the turn that taught the facts has no reply visible in Chord (passive
 * listening, a silent bridge turn), the notice goes to the sayer's personal
 * chat instead. A `system` message: it sends no push, is not mirrored to a
 * bridge (auto_mirror 0) and stays out of the model's history (is_proactive 1).
 */
export async function postPersonalMemoryNotice(
  db: Kysely<DB>,
  opts: { userId: string; fromGroupName: string | null; cards: BotCard[] },
): Promise<string | null> {
  if (opts.cards.length === 0) return null;
  const personal = await ensurePersonalGroup(db, opts.userId);
  const row: MessagesTable = {
    id: newId('m'),
    group_id: personal.id,
    sender_id: null,
    kind: 'system',
    body: opts.fromGroupName ? `From your message in ${opts.fromGroupName}, I noted:` : 'I noted:',
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
  await writeCards(db, row.id, opts.cards);
  await linkNotices(db, row.id, opts.cards);
  sseHub.broadcast(personal.id, SSE.message, rowToMessage(row, JSON.stringify(opts.cards)));
  sseHub.broadcast(personal.id, SSE.botCard, { messageId: row.id, cards: opts.cards });
  return row.id;
}

/** Where a fact stands now, read from the table (not from what a caller believes). */
async function currentStatus(
  db: Kysely<DB>,
  memoryId: string,
): Promise<{ status: MemoryNoticeStatus; replacement?: string; value?: string }> {
  const row = await db
    .selectFrom('memories')
    .select(['status', 'superseded_by', 'value'])
    .where('id', '=', memoryId)
    .executeTakeFirst();
  if (!row) return { status: 'removed' };
  if (row.superseded_by) {
    // Follow the chain to the live answer (a fact corrected twice).
    let next: string | null = row.superseded_by;
    let value: string | undefined;
    for (let hop = 0; next && hop < 10; hop++) {
      const r = await db
        .selectFrom('memories')
        .select(['value', 'superseded_by'])
        .where('id', '=', next)
        .executeTakeFirst();
      if (!r) break;
      value = r.value;
      next = r.superseded_by;
    }
    return { status: 'replaced', replacement: value };
  }
  return { status: row.status === 'confirmed' ? 'saved' : 'proposed', value: row.value };
}

/**
 * Rewrite a fact's card to match the table. A no-op for a fact that never had
 * a card. Best-effort: a failure here must not fail the change itself.
 */
export async function refreshMemoryNotice(db: Kysely<DB>, memoryId: string): Promise<void> {
  try {
    const link = await db
      .selectFrom('memory_notices')
      .innerJoin('messages', 'messages.id', 'memory_notices.message_id')
      .select(['memory_notices.message_id as messageId', 'messages.group_id as groupId'])
      .where('memory_notices.memory_id', '=', memoryId)
      .executeTakeFirst();
    if (!link) return;
    const cards = await readCards(db, link.messageId);
    if (!cards) return;
    const { status, replacement, value } = await currentStatus(db, memoryId);
    let changed = false;
    const next = cards.map((c) => {
      if (c.kind !== 'memory' || c.memoryId !== memoryId) return c;
      const meta = metaFor(status, replacement);
      // An edit in place (the family profile) changes the value, not the status.
      const subtitle = value ?? c.subtitle;
      if (c.memoryStatus === status && c.meta === meta && c.subtitle === subtitle) return c;
      changed = true;
      return { ...c, memoryStatus: status, meta, subtitle };
    });
    if (!changed) return;
    await writeCards(db, link.messageId, next);
    sseHub.broadcast(link.groupId, SSE.botCard, { messageId: link.messageId, cards: next });
  } catch (err) {
    logger.warn('memory notice refresh failed', { err, memoryId });
  }
}

export async function refreshMemoryNotices(db: Kysely<DB>, memoryIds: Iterable<string>): Promise<void> {
  for (const id of new Set(memoryIds)) await refreshMemoryNotice(db, id);
}
