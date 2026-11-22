/**
 * ADR 0281 — the memory clean-up pass. Deterministic tidying every run
 * (proposed repeats of a saved fact, older proposals for the same fact,
 * proposals nobody answered), then a model review of chats whose confirmed
 * facts changed: it names facts that say the same thing and which to keep,
 * and code supersedes the rest. The model never writes a value.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { z } from 'zod';

import { SSE, type Memory } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type { DB, MemoriesTable } from '../db/schema.js';
import { textInstant } from '../db/text-instant.js';
import { parseJsonObject } from '../utils/json-repair.js';
import { hasAiConsent } from './ai-consent.service.js';
import { getEntitlement } from './billing.service.js';
import { isLeader } from './cluster/leadership.js';
import { resolveTurnLlm } from './llm/factory.js';
import type { LlmService, LlmTokenUsage } from './llm/types.js';
import { listFamilyFacts, sameFactValue, supersede } from './memory.service.js';
import { humanKey, labelMemorySubjects, refreshMemoryNotices } from './memory-notices.service.js';
import { sseHub } from './sse.hub.js';
import { recordTokenUsage } from './tokens.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryCleanupResult {
  /** Proposed facts removed: repeats, superseded suggestions, unanswered. */
  proposalsRemoved: number;
  /** Confirmed facts folded into another that says the same thing. */
  duplicatesMerged: number;
  groupsReviewed: number;
}

function subjectKey(r: Pick<MemoriesTable, 'group_id' | 'subject_type' | 'subject_id' | 'persona_id' | 'scope'>): string {
  return `${r.group_id}|${r.subject_type ?? r.scope}|${r.subject_id ?? r.persona_id ?? ''}`;
}

async function removeProposals(
  db: Kysely<DB>,
  rows: Pick<MemoriesTable, 'id' | 'group_id'>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  await db.deleteFrom('memories').where('id', 'in', ids).where('status', '=', 'proposed').execute();
  for (const r of rows) sseHub.broadcast(r.group_id, SSE.memoryResolved, { id: r.id, status: 'rejected' });
  await refreshMemoryNotices(db, ids);
  return rows.length;
}

/**
 * The deterministic half. A proposal that repeats the saved value teaches
 * nothing; of several proposals for the same fact only the newest is current;
 * one nobody answered in `MEMORY_PROPOSED_TTL_DAYS` is not coming back. Facts
 * on the lighter-bar timer (docs/notes/0189) are left to it.
 */
export async function tidyProposedMemories(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  const proposed = await db
    .selectFrom('memories')
    .selectAll()
    .where('status', '=', 'proposed')
    .where('superseded_by', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(2000)
    .execute();
  if (proposed.length === 0) return 0;

  const groupIds = [...new Set(proposed.map((p) => p.group_id))];
  const confirmed = await db
    .selectFrom('memories')
    .selectAll()
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .where('group_id', 'in', groupIds)
    .execute();
  const savedValue = new Map<string, string>();
  for (const c of confirmed) savedValue.set(`${subjectKey(c)}|${c.key}`, c.value);

  const cutoff = now.getTime() - env.MEMORY_PROPOSED_TTL_DAYS * DAY_MS;
  const newestSeen = new Set<string>();
  const remove: MemoriesTable[] = [];
  // Newest first, so the first proposal per fact is the one that stays.
  const ordered = [...proposed].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const p of ordered) {
    const fact = `${subjectKey(p)}|${p.key}`;
    const saved = savedValue.get(fact);
    if (saved !== undefined && sameFactValue(saved, p.value)) {
      remove.push(p);
      continue;
    }
    if (newestSeen.has(fact)) {
      remove.push(p);
      continue;
    }
    newestSeen.add(fact);
    if (
      env.MEMORY_PROPOSED_TTL_DAYS > 0 &&
      p.auto_confirm_at === null &&
      Date.parse(p.created_at) < cutoff
    ) {
      remove.push(p);
    }
  }
  return removeProposals(db, remove);
}

const MergeReply = z.object({
  merge: z
    .array(z.object({ keep: z.string(), drop: z.array(z.string()).min(1).max(20) }))
    .max(40),
});

export type DuplicateFinder = (
  prompt: string,
  llm: LlmService,
  onUsage: (u: LlmTokenUsage) => void,
) => Promise<string>;

const MERGE_SYSTEM = [
  'You tidy a family assistant\'s saved facts. Each subject below lists facts as "fN  key = value".',
  'Find facts about the SAME subject that say the SAME thing in different words or under a',
  'different key (e.g. "allergy = peanuts" and "food_allergy = peanut allergy").',
  'For each such set, keep the one that says it most completely and drop the rest.',
  'Never merge facts that differ in ANY detail (two different allergies, two different',
  'schools, an old and a new address): those are different facts, leave them alone.',
  'Never merge across subjects. When in doubt, leave it.',
  'Output ONLY JSON: {"merge":[{"keep":"f1","drop":["f2"]}]} — {"merge":[]} when nothing repeats.',
].join('\n');

const defaultFinder: DuplicateFinder = async (prompt, llm, onUsage) =>
  llm.complete(
    [
      { role: 'system', content: MERGE_SYSTEM },
      { role: 'user', content: prompt },
    ],
    { maxTokens: 600, temperature: 0, onUsage },
  );

let finder: DuplicateFinder = defaultFinder;
/** Tests replace the model call with a scripted reply. */
export function __setDuplicateFinderForTests(f: DuplicateFinder | null): void {
  finder = f ?? defaultFinder;
}

/**
 * Validate a model reply against the facts it was shown. Only ids from one
 * subject's own list count; each fact is used once; `keep` is never dropped.
 * Pure — exported for tests.
 */
export function validMerges(
  reply: unknown,
  subjectOf: Map<string, string>,
): { keep: string; drop: string[] }[] {
  const parsed = MergeReply.safeParse(reply);
  if (!parsed.success) return [];
  const used = new Set<string>();
  const out: { keep: string; drop: string[] }[] = [];
  for (const m of parsed.data.merge) {
    const subject = subjectOf.get(m.keep);
    if (!subject || used.has(m.keep)) continue;
    const drop = [...new Set(m.drop)].filter(
      (d) => d !== m.keep && subjectOf.get(d) === subject && !used.has(d),
    );
    if (drop.length === 0) continue;
    used.add(m.keep);
    for (const d of drop) used.add(d);
    out.push({ keep: m.keep, drop });
  }
  return out;
}

async function reviewGroup(db: Kysely<DB>, groupId: string, ownerId: string): Promise<number> {
  // ADR 0333 — shared facts only: the review runs on one member's model, and
  // another member's private facts are not theirs to send there.
  const facts = (await listFamilyFacts(db, groupId, 'shared')).filter((f) => f.status === 'confirmed');
  const bySubject = new Map<string, Memory[]>();
  for (const f of facts) {
    const k = `${f.subjectType}|${f.subjectId ?? ''}`;
    bySubject.set(k, [...(bySubject.get(k) ?? []), f]);
  }
  const subjects = [...bySubject.values()].filter((list) => list.length >= 2).slice(0, 12);
  if (subjects.length === 0) return 0;

  const labels = await labelMemorySubjects(db, subjects.flat());
  const realId = new Map<string, string>();
  const subjectOf = new Map<string, string>();
  const lines: string[] = [];
  let n = 0;
  subjects.forEach((list, si) => {
    lines.push(`Subject: ${labels.get(list[0].id) ?? 'Someone'}`);
    for (const f of list.slice(0, 40)) {
      const local = `f${++n}`;
      realId.set(local, f.id);
      subjectOf.set(local, String(si));
      lines.push(`  ${local}  ${humanKey(f.key)} = ${f.value.slice(0, 160)}`);
    }
  });

  const { llm, tier } = await resolveTurnLlm(db, ownerId);
  let usage: LlmTokenUsage | null = null;
  const raw = await finder(lines.join('\n'), llm, (u) => {
    usage = u;
  });
  const used = usage as LlmTokenUsage | null;
  // ADR 0193 — the owner's own key is their cost; nothing is recorded for it.
  if (used && tier !== 'byok') {
    await recordTokenUsage(db, {
      userId: ownerId,
      source: 'memory_cleanup',
      ref: groupId,
      model: llm.defaultModel,
      promptTokens: used.promptTokens,
      completionTokens: used.completionTokens,
      cachedTokens: used.cachedTokens,
      costUsd: used.costUsd,
    }).catch((err) => logger.warn('memory cleanup token record failed', { err }));
  }

  const merges = validMerges(parseJsonObject(raw), subjectOf);
  let merged = 0;
  const touched: string[] = [];
  for (const m of merges) {
    const keep = realId.get(m.keep)!;
    for (const d of m.drop) {
      const drop = realId.get(d)!;
      await supersede(db, drop, keep);
      sseHub.broadcast(groupId, SSE.memoryResolved, { id: drop, status: 'rejected' });
      touched.push(drop);
      merged++;
    }
  }
  await refreshMemoryNotices(db, touched);
  if (merged > 0) logger.info(`memory cleanup merged ${merged} duplicate fact(s) in ${groupId}`);
  return merged;
}

/** Chats with a confirmed fact newer than their last review. */
async function groupsDueForReview(db: Kysely<DB>, limit: number) {
  return db
    .selectFrom('groups')
    .select(['groups.id', 'groups.created_by'])
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('memories')
          .select('memories.id')
          .whereRef('memories.group_id', '=', 'groups.id')
          .where('memories.status', '=', 'confirmed')
          .where('memories.superseded_by', 'is', null)
          .where((e) =>
            e.or([
              e('groups.memories_reviewed_at', 'is', null),
              e(textInstant('memories.created_at'), '>', textInstant('groups.memories_reviewed_at')),
            ]),
          ),
      ),
    )
    .orderBy(sql`groups.memories_reviewed_at NULLS FIRST`)
    .limit(limit)
    .execute();
}

export async function cleanupMemories(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<MemoryCleanupResult> {
  const out: MemoryCleanupResult = { proposalsRemoved: 0, duplicatesMerged: 0, groupsReviewed: 0 };
  out.proposalsRemoved = await tidyProposedMemories(db, now);

  for (const g of await groupsDueForReview(db, env.MEMORY_CLEANUP_GROUPS_PER_RUN)) {
    try {
      if (env.BILLING_ENABLED && !(await getEntitlement(db, g.created_by)).entitled) continue;
      // ADR 0283 — the review is a model call on the owner's behalf; skipped
      // (left due) until they agree. The deterministic tidy above sends nothing.
      if (!(await hasAiConsent(db, g.created_by))) continue;
      out.duplicatesMerged += await reviewGroup(db, g.id, g.created_by);
      out.groupsReviewed++;
      await db
        .updateTable('groups')
        .set({ memories_reviewed_at: now.toISOString() })
        .where('id', '=', g.id)
        .execute();
    } catch (err) {
      // A model or key failure leaves the chat due; it is tried next run.
      logger.warn('memory cleanup: review failed', { err, groupId: g.id });
    }
  }
  return out;
}

let lastRunAt: number | null = null;

/** At most every `MEMORY_CLEANUP_HOURS`, from the proactive tick. In memory: a restart runs it again. */
export async function maybeCleanupMemories(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<MemoryCleanupResult | null> {
  if (!env.MEMORY_CLEANUP_ENABLED) return null;
  // ADR 0280 — with several worker copies, only the leader runs the pass;
  // the in-memory day guard below is per process.
  if (!isLeader('worker')) return null;
  if (lastRunAt !== null && now.getTime() - lastRunAt < env.MEMORY_CLEANUP_HOURS * 60 * 60 * 1000) return null;
  lastRunAt = now.getTime();
  const out = await cleanupMemories(db, now);
  if (out.proposalsRemoved + out.duplicatesMerged > 0) logger.info('memory cleanup', { ...out });
  return out;
}

export function __resetMemoryCleanupForTests(): void {
  lastRunAt = null;
}
