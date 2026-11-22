import type { ExpressionBuilder, Kysely } from 'kysely';

import {
  categoryForKey,
  type FactCategory,
  type FactSubjectType,
  type Memory,
  type MemoryScope,
  type MemorySource,
  type MemoryStatus,
} from '@chord/kernel';

import type { DB, MemoriesTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';

function rowToMemory(row: MemoriesTable): Memory {
  return {
    id: row.id,
    groupId: row.group_id,
    personaId: row.persona_id,
    scope: row.scope,
    key: row.key,
    value: row.value,
    source: row.source,
    confidence: row.confidence,
    status: row.status,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    category: row.category,
    provenance: row.provenance,
    datedAt: row.dated_at,
    autoConfirmAt: row.auto_confirm_at,
  };
}

/**
 * Denormalised subject identity for the family-profile surface. A caller may
 * pass it explicitly (a fact about a managed persona, or a household fact);
 * otherwise it is derived from `scope`/`personaId` — the compat shim that
 * keeps every existing caller working unchanged.
 */
function resolveSubject(input: {
  scope: MemoryScope;
  personaId: string | null;
  subjectType?: FactSubjectType | null;
  subjectId?: string | null;
}): { subjectType: FactSubjectType | null; subjectId: string | null } {
  if (input.subjectType !== undefined && input.subjectType !== null) {
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectType === 'household' ? null : (input.subjectId ?? null),
    };
  }
  if (input.scope === 'persona') return { subjectType: 'user', subjectId: input.personaId };
  if (input.scope === 'group') return { subjectType: 'household', subjectId: null };
  return { subjectType: null, subjectId: null };
}

/** Null-safe `(subject_type, subject_id)` match for the dedup/supersede lookups. */
function subjectMatch(
  eb: ExpressionBuilder<DB, 'memories'>,
  subjectType: FactSubjectType | null,
  subjectId: string | null,
) {
  return eb.and([
    subjectType === null
      ? eb('memories.subject_type', 'is', null)
      : eb('memories.subject_type', '=', subjectType),
    subjectId === null
      ? eb('memories.subject_id', 'is', null)
      : eb('memories.subject_id', '=', subjectId),
  ]);
}

export interface UpsertMemoryInput {
  groupId: string;
  personaId?: string | null;
  scope: MemoryScope;
  key: string;
  value: string;
  source: MemorySource;
  confidence?: number;
  /**
   * ADR 0009: bot-extracted facts write 'proposed' and only supersede the
   * prior confirmed row on user confirmation. Direct/explicit writes pass
   * 'confirmed' (the default) and supersede immediately.
   */
  status?: MemoryStatus;
  /** Family-profile surface. When omitted, derived from `scope`/`personaId`. */
  subjectType?: FactSubjectType | null;
  subjectId?: string | null;
  category?: FactCategory | null;
  provenance?: string | null;
  datedAt?: string | null;
  /**
   * Default true. Pass false for a fact about a PROVISIONAL person (docs/notes/
   * 0191): the lighter bar below assumes the subject already exists, and a
   * provisional one does not until the user taps its card, so its facts must
   * confirm only through that tap.
   */
  autoConfirm?: boolean;
}

/**
 * Migration 082 (docs/notes/0189) — an attribute fact about a subject that
 * ALREADY exists as a real entity (a person/persona row, as opposed to the
 * fact deciding whether that entity exists at all) gets a lighter consent
 * bar than a brand-new person or relationship claim: it auto-confirms after
 * this many days unless a human rejects it first, instead of sitting
 * `proposed` forever with nothing pulling anyone back to look at it.
 */
const ATTRIBUTE_LIGHTER_BAR_CONFIDENCE = 0.8;
const ATTRIBUTE_LIGHTER_BAR_DECAY_DAYS = 7;

/**
 * Insert a new memory row.
 *
 * Dedup / supersede key is `(group_id, subject_type, subject_id, key)` — for a
 * legacy caller that is exactly `(group_id, scope, persona_id, key)` under the
 * shim, so behaviour is unchanged; a fact about a managed persona is now
 * expressible by passing `subjectType: 'persona'` + the personas.id.
 *
 * For `status: 'confirmed'` (default): if a live confirmed row exists for the
 * same subject + key, mark it superseded and chain from it.
 * For `status: 'proposed'`: insert without touching any confirmed row; an
 * identical proposed row is returned rather than duplicated.
 */
export async function upsertMemory(
  db: Kysely<DB>,
  input: UpsertMemoryInput,
): Promise<Memory> {
  return (await writeMemory(db, input)).memory;
}

/** Case and spacing do not make a fact different (ADR 0281). */
export function sameFactValue(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(a) === norm(b);
}

/**
 * `upsertMemory`, also saying whether a row was written. `created: false`
 * means the fact was already held (the returned row is the existing one), so
 * nothing new was learned and no notice is owed (ADR 0281).
 */
export async function writeMemory(
  db: Kysely<DB>,
  input: UpsertMemoryInput,
): Promise<{ memory: Memory; created: boolean }> {
  const personaId = input.personaId ?? null;
  const confidence = input.confidence ?? 0.6;
  const status: MemoryStatus = input.status ?? 'confirmed';
  const { subjectType, subjectId } = resolveSubject({
    scope: input.scope,
    personaId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
  });
  const category = input.category ?? categoryForKey(input.key);

  const live = await db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', input.groupId)
    .where('key', '=', input.key)
    .where('superseded_by', 'is', null)
    .where((eb) => subjectMatch(eb, subjectType, subjectId))
    .execute();
  const liveConfirmed = live.find((r) => r.status === 'confirmed');

  // Restating a fact Chord already holds learns nothing: an extracted repeat of
  // the confirmed value used to open a fresh pending card every time.
  if (liveConfirmed && sameFactValue(liveConfirmed.value, input.value)) {
    return { memory: rowToMemory(liveConfirmed), created: false };
  }
  if (status === 'proposed') {
    const dupe = live.find((r) => r.status === 'proposed' && sameFactValue(r.value, input.value));
    if (dupe) return { memory: rowToMemory(dupe), created: false };
  }

  // Never for a new person/relationship claim (those aren't memories rows at
  // all) — only for one more fact about a subject that already, verifiably,
  // exists. `subjectId` being set on 'person'/'persona' already implies the
  // people/personas row is real (neither table has its own proposed state),
  // so no extra existence query is needed here.
  const eligibleForLighterBar =
    input.autoConfirm !== false &&
    status === 'proposed' &&
    confidence >= ATTRIBUTE_LIGHTER_BAR_CONFIDENCE &&
    (subjectType === 'person' || subjectType === 'persona') &&
    subjectId !== null;
  const autoConfirmAt = eligibleForLighterBar
    ? new Date(Date.now() + ATTRIBUTE_LIGHTER_BAR_DECAY_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const id = newId('mem');
  const row: MemoriesTable = {
    id,
    group_id: input.groupId,
    persona_id: personaId,
    scope: input.scope,
    key: input.key,
    value: input.value,
    source: input.source,
    confidence,
    status,
    superseded_by: null,
    created_at: new Date().toISOString(),
    subject_type: subjectType,
    subject_id: subjectId,
    category,
    provenance: input.provenance ?? null,
    dated_at: input.datedAt ?? null,
    auto_confirm_at: autoConfirmAt,
  };
  await db.insertInto('memories').values(row).execute();

  if (status === 'confirmed' && liveConfirmed) {
    await db
      .updateTable('memories')
      .set({ superseded_by: id })
      .where('id', '=', liveConfirmed.id)
      .execute();
  }

  return { memory: rowToMemory(row), created: true };
}

/**
 * Every live fact (confirmed AND proposed) the asker can see in this chat —
 * the same visibility rule as `queryForTurn`: the chat's shared facts plus the
 * asker's own. The chat tools that change a fact act only on these (ADR 0281),
 * so a tool call can never reach another member's private facts.
 */
export async function visibleMemoriesForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; triggeringUserId: string; limit?: number },
): Promise<Memory[]> {
  const rows = await db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', opts.groupId)
    .where('superseded_by', 'is', null)
    .where(factVisibleTo(opts.triggeringUserId))
    .orderBy('created_at', 'desc')
    // ADR 0333 — high enough that an old fact is still found by
    // correct_memory / forget_memory / list_memories.
    .limit(opts.limit ?? 2000)
    .execute();
  return rows.map(rowToMemory);
}

/**
 * Return the memories relevant to a single bot turn: the group-scope memories
 * for this group + the persona-scope memories for the triggering user. Only
 * live (non-superseded) confirmed rows — proposed memories are invisible to
 * the LLM until a user accepts them (ADR 0009).
 */
export async function queryForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; triggeringUserId: string; limit?: number },
): Promise<Memory[]> {
  const rows = await db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', opts.groupId)
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .where((eb) =>
      eb.or([
        eb('scope', '=', 'group'),
        eb.and([
          eb('scope', '=', 'persona'),
          eb('persona_id', '=', opts.triggeringUserId),
        ]),
      ]),
    )
    .orderBy('confidence', 'desc')
    .orderBy('created_at', 'desc')
    .limit(opts.limit ?? 12)
    .execute();
  return rows.map(rowToMemory);
}

/**
 * ADR 0333 — who may see a fact: a shared (`group`) fact is the chat's; a
 * private (`persona`) fact only its owner's (`persona_id`), whoever it is
 * about. Every list of facts a person or the bot reads goes through this.
 */
export function factVisibleTo(viewerId: string) {
  return (eb: ExpressionBuilder<DB, 'memories'>) =>
    eb.or([
      eb('memories.scope', '=', 'group'),
      eb.and([eb('memories.scope', '=', 'persona'), eb('memories.persona_id', '=', viewerId)]),
    ]);
}

/** `factVisibleTo` for one row already read. */
export function canSeeFact(row: { scope: string; persona_id: string | null }, viewerId: string): boolean {
  return row.scope === 'group' || (row.scope === 'persona' && row.persona_id === viewerId);
}

export async function listMemories(
  db: Kysely<DB>,
  groupId: string,
  opts: { viewerId: string; includeSuperseded?: boolean; status?: MemoryStatus; limit?: number },
): Promise<Memory[]> {
  let q = db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', groupId)
    .where(factVisibleTo(opts.viewerId))
    .orderBy('created_at', 'desc');
  if (!opts.includeSuperseded) q = q.where('superseded_by', 'is', null);
  if (opts.status) q = q.where('status', '=', opts.status);
  // Unbounded over a group's lifetime otherwise; see tasks.service.ts's
  // listTasks for the same reasoning. 200 is generous for any normal family
  // group.
  const rows = await q.limit(opts.limit ?? 200).execute();
  return rows.map(rowToMemory);
}

export async function listMemoriesForUser(
  db: Kysely<DB>,
  userId: string,
  opts?: { status?: MemoryStatus; limit?: number },
): Promise<Memory[]> {
  let q = db
    .selectFrom('memories')
    .innerJoin('group_members', 'group_members.group_id', 'memories.group_id')
    .where('group_members.user_id', '=', userId)
    .where('memories.superseded_by', 'is', null)
    .where(factVisibleTo(userId))
    .selectAll('memories')
    .orderBy('memories.created_at', 'desc');
  if (opts?.status) q = q.where('memories.status', '=', opts.status);
  const rows = await q.limit(opts?.limit ?? 200).execute();
  return rows.map(rowToMemory);
}

/**
 * Family-profile surface — every live fact for a group that carries a
 * subject: confirmed + proposed, both members' facts and household facts.
 * The caller buckets them by subject. ADR 0333: `{ viewerId }` adds that
 * person's own private facts to the chat's shared ones; `'shared'` is the
 * shared ones only (for work no single member is asking for).
 */
export async function listFamilyFacts(
  db: Kysely<DB>,
  groupId: string,
  who: { viewerId: string } | 'shared',
): Promise<Memory[]> {
  const rows = await db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('superseded_by', 'is', null)
    .where('subject_type', 'is not', null)
    .where(who === 'shared' ? (eb) => eb('memories.scope', '=', 'group') : factVisibleTo(who.viewerId))
    .orderBy('category', 'asc')
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToMemory);
}

export interface ContextFact {
  /** "Household", or "Ben (child)". */
  subjectLabel: string;
  /** ADR 0333 — who the fact is about, as an identity ("persona:<id>",
   *  "household"), so two people with one label are never merged. */
  subjectKey: string;
  category: string;
  key: string;
  value: string;
  datedAt: string | null;
}

/**
 * The family facts that are SHARED group knowledge — household facts and facts
 * about a managed persona (a kid, a grandparent). Deliberately excludes
 * `subject_type='user'` rows: a fact about an account-holding member stays
 * private to that member (context.ts's privacy rule). Confirmed only.
 *
 * Value-clipped and row-capped — this feeds a prompt (bot context + the daily
 * briefing), same bounding discipline as ADR 0088's world-context block.
 */
export async function familyFactsForContext(
  db: Kysely<DB>,
  groupId: string,
  opts: { limit?: number } = {},
): Promise<ContextFact[]> {
  const rows = await db
    .selectFrom('memories')
    .leftJoin('personas', 'personas.id', 'memories.subject_id')
    .select([
      'memories.subject_type as subject_type',
      'memories.subject_id as subject_id',
      'memories.category as category',
      'memories.key as key',
      'memories.value as value',
      'memories.dated_at as dated_at',
      'personas.name as persona_name',
      'personas.household_role as persona_role',
    ])
    .where('memories.group_id', '=', groupId)
    .where('memories.status', '=', 'confirmed')
    .where('memories.superseded_by', 'is', null)
    .where('memories.subject_type', 'in', ['household', 'persona'])
    // ADR 0333 — shared facts only: this goes to every member's prompt.
    .where('memories.scope', '=', 'group')
    .orderBy('memories.category', 'asc')
    .orderBy('memories.created_at', 'desc')
    .limit(opts.limit ?? 200)
    .execute();

  // ADR 0333 — a fact whose person no longer exists has nobody to name, so
  // it is left out rather than shown as "A family member" (two such facts
  // were then merged into one in the briefing).
  return rows
    .filter((r) => r.subject_type === 'household' || !!r.persona_name)
    .map((r) => ({
    subjectKey: r.subject_type === 'household' ? 'household' : `persona:${r.subject_id}`,
    subjectLabel:
      r.subject_type === 'household'
        ? 'Household'
        : `${r.persona_name}${r.persona_role && r.persona_role !== 'other' ? ` (${r.persona_role})` : ''}`,
    category: r.category ?? 'note',
    key: r.key,
    value: r.value.length > 120 ? `${r.value.slice(0, 117)}…` : r.value,
    datedAt: r.dated_at,
  }));
}

/** Edit a fact's value / category / dated_at (profile surface). */
export async function updateFact(
  db: Kysely<DB>,
  id: string,
  patch: { value?: string; category?: FactCategory; datedAt?: string | null },
): Promise<Memory | null> {
  const values: Partial<MemoriesTable> = {};
  if (patch.value !== undefined) values.value = patch.value;
  if (patch.category !== undefined) values.category = patch.category;
  if (patch.datedAt !== undefined) values.dated_at = patch.datedAt;
  if (Object.keys(values).length > 0) {
    await db.updateTable('memories').set(values).where('id', '=', id).execute();
  }
  const row = await db.selectFrom('memories').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToMemory(row) : null;
}

export async function deleteFact(db: Kysely<DB>, id: string): Promise<boolean> {
  const res = await db.deleteFrom('memories').where('id', '=', id).executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

export async function getMemory(db: Kysely<DB>, id: string): Promise<Memory | null> {
  const row = await db.selectFrom('memories').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToMemory(row) : null;
}

export interface ConfirmMemoryResult {
  memory: Memory;
  /**
   * The prior-confirmed row (if any) that was just superseded. Routes
   * broadcast an additional `memory.resolved` event for this id so the
   * client drops the stale value from the live Memory tab without
   * waiting for a refetch (ADR 0009 review fix).
   */
  supersededId: string | null;
}

/**
 * Accept a proposed memory. Flips status → 'confirmed' and supersedes any
 * previously-confirmed row for the same subject + key, so the newly-accepted
 * fact becomes the live answer.
 */
export async function confirmMemory(
  db: Kysely<DB>,
  id: string,
): Promise<ConfirmMemoryResult | null> {
  const row = await db
    .selectFrom('memories')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  if (row.status === 'confirmed') {
    return { memory: rowToMemory(row), supersededId: null };
  }

  const { subjectType, subjectId } = resolveSubject({
    scope: row.scope,
    personaId: row.persona_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
  });
  const priorConfirmed = await db
    .selectFrom('memories')
    .selectAll()
    .where('group_id', '=', row.group_id)
    .where('key', '=', row.key)
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .where((eb) => subjectMatch(eb, subjectType, subjectId))
    .executeTakeFirst();

  await db
    .updateTable('memories')
    .set({ status: 'confirmed' })
    .where('id', '=', id)
    .execute();

  const supersededId =
    priorConfirmed && priorConfirmed.id !== id ? priorConfirmed.id : null;
  if (supersededId) {
    await db
      .updateTable('memories')
      .set({ superseded_by: id })
      .where('id', '=', supersededId)
      .execute();
  }

  const updated = await db
    .selectFrom('memories')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return updated ? { memory: rowToMemory(updated), supersededId } : null;
}

/**
 * Drop a proposed memory. Hard-delete — rejected proposals don't need durable
 * state in Phase 1. An audit view is Phase 7 work (see consensus-before-commit
 * task doc). Confirmed rows are refused; use supersede() for those.
 */
export async function rejectMemory(db: Kysely<DB>, id: string): Promise<boolean> {
  const row = await db
    .selectFrom('memories')
    .select(['id', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return false;
  if (row.status === 'confirmed') return false;
  await db.deleteFrom('memories').where('id', '=', id).execute();
  return true;
}

export interface DecayedMemory {
  id: string;
  groupId: string;
  supersededId: string | null;
}

/**
 * The `memories` lighter-bar sweep (docs/notes/0189), structurally identical
 * to `proposals.service.ts`'s `expireStale` — same lazy-on-read placement
 * (called at the top of the People/family-profile list routes, no cron) —
 * but the outcome is `confirmed`, not `expired`, and it reuses `confirmMemory`
 * per row instead of hand-rolling the supersede logic a second time. Only
 * rows an eligible `upsertMemory` call opted into (`auto_confirm_at` set) are
 * ever touched; nothing here decides eligibility itself.
 */
export async function decayMemories(db: Kysely<DB>): Promise<DecayedMemory[]> {
  const due = await db
    .selectFrom('memories')
    .select(['id', 'group_id'])
    .where('status', '=', 'proposed')
    .where('auto_confirm_at', 'is not', null)
    .where('auto_confirm_at', '<=', new Date().toISOString())
    .execute();
  const out: DecayedMemory[] = [];
  for (const row of due) {
    const result = await confirmMemory(db, row.id);
    if (result) out.push({ id: row.id, groupId: row.group_id, supersededId: result.supersededId });
  }
  return out;
}

export async function supersede(
  db: Kysely<DB>,
  id: string,
  replacementId: string | null = null,
): Promise<void> {
  await db
    .updateTable('memories')
    .set({ superseded_by: replacementId })
    .where('id', '=', id)
    .execute();
}
