/**
 * ADR 0281 — the memory clean-up pass: deterministic tidying of proposed
 * facts, and a model review that may only fold facts into one another.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { getMemory, upsertMemory } from '@/services/memory.service.js';

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'mock',
    defaultModel: 'mock-model',
    supportsNativeTools: false,
    complete: async () => '{"merge":[]}',
    async *stream() {
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

import {
  __resetMemoryCleanupForTests,
  __setDuplicateFinderForTests,
  cleanupMemories,
  maybeCleanupMemories,
  tidyProposedMemories,
  validMerges,
} from '@/services/memory-cleanup.service.js';

describe('memory clean-up (ADR 0281)', () => {
  let db: Kysely<DB>;
  let owner: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro', 'John');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
    __resetMemoryCleanupForTests();
  });
  afterEach(async () => {
    __setDuplicateFinderForTests(null);
    await closeTestDb(db);
  });

  const fact = (key: string, value: string, status: 'proposed' | 'confirmed', subjectId?: string) =>
    upsertMemory(db, {
      groupId,
      scope: 'group',
      key,
      value,
      source: status === 'confirmed' ? 'explicit' : 'passive',
      status,
      ...(subjectId ? { subjectType: 'persona' as const, subjectId } : {}),
    });

  const backdate = (id: string, daysAgo: number) =>
    db
      .updateTable('memories')
      .set({ created_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString() })
      .where('id', '=', id)
      .execute();

  it('removes a proposal that repeats the saved value', async () => {
    const saved = await fact('pet', 'Biscuit the dog', 'confirmed');
    // Inserted before the repeat check existed: a pending duplicate of a saved fact.
    await db
      .insertInto('memories')
      .values({
        id: 'mem_old_dupe', group_id: groupId, persona_id: null, scope: 'group', key: 'pet',
        value: 'biscuit the dog', source: 'passive', confidence: 0.9, status: 'proposed',
        superseded_by: null, created_at: new Date().toISOString(), subject_type: 'household',
        subject_id: null, category: null, provenance: null, dated_at: null, auto_confirm_at: null,
      })
      .execute();

    expect(await tidyProposedMemories(db)).toBe(1);
    expect(await getMemory(db, 'mem_old_dupe')).toBeNull();
    expect(await getMemory(db, saved.id)).not.toBeNull();
  });

  it('keeps only the newest proposal per fact, and drops unanswered old ones', async () => {
    const older = await fact('home_city', 'Boston', 'proposed');
    await backdate(older.id, 2);
    const newer = await fact('home_city', 'Cambridge', 'proposed');
    const stale = await fact('car', 'Volvo', 'proposed');
    await backdate(stale.id, 31);

    expect(await tidyProposedMemories(db)).toBe(2);
    expect(await getMemory(db, older.id)).toBeNull();
    expect(await getMemory(db, stale.id)).toBeNull();
    expect(await getMemory(db, newer.id)).not.toBeNull();
  });

  it('leaves a proposal on the lighter-bar timer to that timer', async () => {
    const maya = await createPersona(db, { groupId, name: 'Maya', householdRole: 'child', managedBy: owner });
    const timed = await upsertMemory(db, {
      groupId, scope: 'group', key: 'shoe_size', value: '2', source: 'passive', status: 'proposed',
      confidence: 0.9, subjectType: 'persona', subjectId: maya.id,
    });
    await backdate(timed.id, 40);
    expect(timed.autoConfirmAt).not.toBeNull();
    expect(await tidyProposedMemories(db)).toBe(0);
  });

  it('folds a duplicate the model names into the kept fact', async () => {
    const maya = await createPersona(db, { groupId, name: 'Maya', householdRole: 'child', managedBy: owner });
    const a = await fact('allergy', 'peanuts', 'confirmed', maya.id);
    const b = await fact('food_allergy', 'peanut allergy', 'confirmed', maya.id);
    let prompt = '';
    __setDuplicateFinderForTests(async (p, _llm, onUsage) => {
      prompt = p;
      onUsage({ promptTokens: 100, completionTokens: 20 });
      return '{"merge":[{"keep":"f1","drop":["f2"]}]}';
    });

    const r = await cleanupMemories(db);

    expect(prompt).toContain('Subject: Maya');
    expect(r).toMatchObject({ duplicatesMerged: 1, groupsReviewed: 1 });
    const ids = [a.id, b.id];
    const after = await Promise.all(ids.map((id) => getMemory(db, id)));
    expect(after.filter((m) => m?.supersededBy === null)).toHaveLength(1);
    expect(after.filter((m) => m?.supersededBy && ids.includes(m.supersededBy))).toHaveLength(1);
    const usage = await db.selectFrom('token_usage').selectAll().executeTakeFirstOrThrow();
    expect(usage).toMatchObject({ source: 'memory_cleanup', user_id: owner, total_tokens: 120 });
    const g = await db.selectFrom('groups').select('memories_reviewed_at').where('id', '=', groupId).executeTakeFirstOrThrow();
    expect(g.memories_reviewed_at).not.toBeNull();
  });

  it('skips the model review until the owner agrees to AI, and leaves the chat due (ADR 0283)', async () => {
    await fact('allergy', 'peanuts', 'confirmed');
    await fact('pet', 'dog', 'confirmed');
    let calls = 0;
    __setDuplicateFinderForTests(async () => {
      calls++;
      return '{"merge":[]}';
    });
    const mutable = env as { AI_CONSENT_REQUIRED: boolean };
    mutable.AI_CONSENT_REQUIRED = true;
    try {
      const r = await cleanupMemories(db);
      expect(calls).toBe(0);
      expect(r.groupsReviewed).toBe(0);
      const g = await db.selectFrom('groups').select('memories_reviewed_at').where('id', '=', groupId).executeTakeFirstOrThrow();
      expect(g.memories_reviewed_at).toBeNull();
    } finally {
      mutable.AI_CONSENT_REQUIRED = false;
    }
  });

  it('does not review a chat again until a fact changes', async () => {
    await fact('allergy', 'peanuts', 'confirmed');
    await fact('pet', 'dog', 'confirmed');
    let calls = 0;
    __setDuplicateFinderForTests(async () => {
      calls++;
      return '{"merge":[]}';
    });
    await cleanupMemories(db);
    await cleanupMemories(db);
    expect(calls).toBe(1);
  });

  it('ignores ids the model invents or that cross subjects', () => {
    const subjectOf = new Map([['f1', '0'], ['f2', '0'], ['f3', '1']]);
    expect(validMerges({ merge: [{ keep: 'f1', drop: ['f3', 'f9'] }] }, subjectOf)).toEqual([]);
    expect(validMerges({ merge: [{ keep: 'f1', drop: ['f1', 'f2'] }] }, subjectOf)).toEqual([
      { keep: 'f1', drop: ['f2'] },
    ]);
    expect(
      validMerges({ merge: [{ keep: 'f1', drop: ['f2'] }, { keep: 'f2', drop: ['f1'] }] }, subjectOf),
    ).toEqual([{ keep: 'f1', drop: ['f2'] }]);
    expect(validMerges('nonsense', subjectOf)).toEqual([]);
  });

  it('runs at most once a day from the tick', async () => {
    expect(await maybeCleanupMemories(db)).not.toBeNull();
    expect(await maybeCleanupMemories(db)).toBeNull();
  });
});
