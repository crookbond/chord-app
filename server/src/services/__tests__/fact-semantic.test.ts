/**
 * ADR 0284 — facts found by meaning. Vectors are made when a search needs
 * them and kept; a meaning-only match is suggested, never acted on.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { getMemory, upsertMemory, updateFact } from '@/services/memory.service.js';
import { MockEmbedder, type Embedder } from '@/services/llm/embeddings.js';
import { __resetSemanticCachesForTests } from '@/services/search/semantic.js';

const state = vi.hoisted(() => ({ embedder: null as Embedder | null, calls: 0 }));

vi.mock('@/services/llm/embeddings.js', async (orig) => {
  const real = await orig<typeof import('@/services/llm/embeddings.js')>();
  return { ...real, getEmbedderForUser: async () => state.embedder };
});

import { correctMemoryForTurn, findMemoriesForTurn, forgetMemoryForTurn } from '@/services/bot/memory-tools.js';

/** The mock embedder, counting the facts it is asked to embed. */
class CountingEmbedder extends MockEmbedder {
  override async embed(texts: string[]) {
    state.calls += texts.length;
    return super.embed(texts);
  }
}

describe('facts matched by meaning (ADR 0284)', () => {
  let db: Kysely<DB>;
  let owner: string;
  let groupId: string;
  let mayaId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro', 'John');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
    mayaId = (await createPersona(db, { groupId, name: 'Maya', householdRole: 'child', managedBy: owner })).id;
    state.embedder = new CountingEmbedder();
    state.calls = 0;
    __resetSemanticCachesForTests();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const mayaFact = (key: string, value: string) =>
    upsertMemory(db, {
      groupId, scope: 'group', key, value, source: 'explicit', subjectType: 'persona', subjectId: mayaId,
    });

  it('suggests the fact a forget request means, and forgets nothing', async () => {
    const dentist = await mayaFact('dentist', 'Dr Lee');
    await mayaFact('allergy', 'peanuts');

    // "teeth" appears nowhere in the fact, so the word rule finds nothing.
    const r = await forgetMemoryForTurn(db, { groupId, userId: owner, match: "Maya's teeth doctor" });

    expect(r.data).toMatchObject({ result: 'suggested', deleted: false });
    const candidates = r.data.candidates as Array<{ memoryId: string }>;
    expect(candidates[0].memoryId).toBe(dentist.id);
    expect(await getMemory(db, dentist.id)).not.toBeNull();
  });

  it('a word match still acts directly', async () => {
    const dentist = await mayaFact('dentist', 'Dr Lee');
    const r = await correctMemoryForTurn(db, { groupId, userId: owner, match: 'Maya dentist', value: 'Dr Park' });
    expect(r.data).toMatchObject({ result: 'corrected' });
    expect((await getMemory(db, dentist.id))?.supersededBy).toBeTruthy();
  });

  it('without an embedder it falls back to words only', async () => {
    state.embedder = null;
    await mayaFact('dentist', 'Dr Lee');
    const r = await forgetMemoryForTurn(db, { groupId, userId: owner, match: "Maya's teeth doctor" });
    expect(r.data.result).toBe('not_found');
  });

  it('embeds a fact once, and again only when its value changes', async () => {
    const dentist = await mayaFact('dentist', 'Dr Lee');
    await mayaFact('allergy', 'peanuts');

    await findMemoriesForTurn(db, { groupId, userId: owner, query: 'teeth', limit: 10 });
    const first = state.calls;
    await findMemoriesForTurn(db, { groupId, userId: owner, query: 'teeth', limit: 10 });
    expect(state.calls).toBe(first);

    await updateFact(db, dentist.id, { value: 'Dr Park' });
    await findMemoriesForTurn(db, { groupId, userId: owner, query: 'teeth', limit: 10 });
    // One changed fact plus the (cached) question: only the fact is re-embedded.
    expect(state.calls).toBe(first + 1);
    expect(await db.selectFrom('memory_embeddings').select('memory_id').execute()).toHaveLength(2);
  });

  it('list_memories with a query ranks the meant fact first, and says when nothing matches', async () => {
    const dentist = await mayaFact('dentist', 'Dr Lee');
    await mayaFact('home_city', 'Boston');

    const hit = await findMemoriesForTurn(db, { groupId, userId: owner, query: "Maya's teeth", limit: 10 });
    expect(hit.matched).toBe(true);
    expect(hit.memories[0].id).toBe(dentist.id);

    state.embedder = null;
    const miss = await findMemoriesForTurn(db, { groupId, userId: owner, query: 'shoe size', limit: 10 });
    expect(miss.matched).toBe(false);
    expect(miss.memories).toHaveLength(2);
  });

  it('a fact\'s vector goes when the fact does', async () => {
    const dentist = await mayaFact('dentist', 'Dr Lee');
    await findMemoriesForTurn(db, { groupId, userId: owner, query: 'teeth', limit: 10 });
    await forgetMemoryForTurn(db, { groupId, userId: owner, memoryId: dentist.id });
    expect(await db.selectFrom('memory_embeddings').select('memory_id').execute()).toHaveLength(0);
  });
});
