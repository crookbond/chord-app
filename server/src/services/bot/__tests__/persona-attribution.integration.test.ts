/**
 * Family-profile Phase 2 — the chat memory extractor attributes a fact to a
 * managed persona (a kid, a grandparent) on the family roster, instead of
 * filing it under whoever mentioned them.
 */
import type { Message } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { listFamilyFacts } from '@/services/memory.service.js';
import { createPerson } from '@/services/people.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const mockState = vi.hoisted(() => ({ rows: '[]' }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'mock',
    defaultModel: 'mock',
    supportsNativeTools: false,
    complete: async () => mockState.rows,
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

import { extractMemoriesFromTurn } from '@/services/bot/extraction.js';

describe('chat memory extraction — managed-persona attribution', () => {
  let db: Kysely<DB>;
  let owner: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeTestDb(db);
  });

  const runTurn = (body: string) =>
    extractMemoriesFromTurn(db, {
      triggerMsg: { senderId: owner, body } as Message,
      triggerUserName: 'Ro',
      botReply: '',
      group: { id: groupId, kind: 'group' },
    });

  it('a fact about a managed persona lands on that persona', async () => {
    const ben = await createPersona(db, {
      groupId,
      name: 'Ben',
      householdRole: 'child',
      managedBy: owner,
    });
    mockState.rows = JSON.stringify([
      { key: 'allergy', value: 'peanuts', confidence: 0.95, scope: 'persona', subject: 'Ben' },
    ]);

    await runTurn('Ben is allergic to peanuts');

    const facts = await listFamilyFacts(db, groupId, { viewerId: owner });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      subjectType: 'persona',
      subjectId: ben.id,
      category: 'health',
      status: 'proposed',
      value: 'peanuts',
    });
  });

  it('a fact about the speaking user lands as subject_type=user', async () => {
    mockState.rows = JSON.stringify([
      { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
    ]);
    await runTurn('my home airport is JFK');
    const [f] = await listFamilyFacts(db, groupId, { viewerId: owner });
    expect(f).toMatchObject({ subjectType: 'user', subjectId: owner });
  });

  // ADR 0333 — flipped: this used to file the fact as a household fact. A
  // fact about a person nobody can place is not saved at all; filed under
  // the whole family, a second child's number replaced the first's.
  it('an unresolved subject is not saved', async () => {
    mockState.rows = JSON.stringify([
      { key: 'allergy', value: 'dust', confidence: 0.9, scope: 'persona', subject: 'Nimbus' },
    ]);
    await runTurn('Nimbus is allergic to dust');
    expect(await db.selectFrom('memories').selectAll().execute()).toHaveLength(0);
  });

  it('ADR 0333: in the personal chat a first name finds the saved person (prod: "Ben" for "Ben Doe")', async () => {
    const personal = await ensurePersonalGroup(db, owner);
    const ben = await createPerson(db, { ownerUserId: owner, displayName: 'Ben Doe' });
    await createPerson(db, { ownerUserId: owner, displayName: 'Nolan Doe' });
    mockState.rows = JSON.stringify([
      { key: 'global_entry_number', value: '155605322', confidence: 0.95, scope: 'persona', subject: 'Ben' },
    ]);
    await extractMemoriesFromTurn(db, {
      triggerMsg: { senderId: owner, body: "Ben's global entry is 155605322" } as Message,
      triggerUserName: 'Ro',
      botReply: '',
      group: { id: personal.id, kind: 'personal' },
    });
    const rows = await db.selectFrom('memories').select(['subject_type', 'subject_id', 'value']).execute();
    expect(rows).toEqual([{ subject_type: 'person', subject_id: ben.id, value: '155605322' }]);
  });

  it("docs/notes/0189: a fact about the asker's private contact lands on the PERSON, in their PERSONAL group, never the shared chat's group", async () => {
    const alice = await createPerson(db, { ownerUserId: owner, displayName: 'Alice' });
    mockState.rows = JSON.stringify([
      { key: 'allergy', value: 'shellfish', confidence: 0.95, scope: 'persona', subject: 'Alice' },
    ]);

    await runTurn('Alice is allergic to shellfish');

    // Never leaks into the shared group's family-profile surface.
    expect(await listFamilyFacts(db, groupId, { viewerId: owner })).toHaveLength(0);

    const personal = await ensurePersonalGroup(db, owner);
    const onPerson = await db
      .selectFrom('memories')
      .select(['key', 'value', 'subject_type', 'subject_id', 'group_id'])
      .where('subject_type', '=', 'person')
      .where('subject_id', '=', alice.id)
      .execute();
    expect(onPerson).toEqual([
      expect.objectContaining({ key: 'allergy', value: 'shellfish', group_id: personal.id }),
    ]);
  });

  it('a group-scope fact is a household fact', async () => {
    mockState.rows = JSON.stringify([
      { key: 'home_address', value: '12 Oak St', confidence: 0.9, scope: 'group', subject: 'self' },
    ]);
    await runTurn('our address is 12 Oak St');
    const [f] = await listFamilyFacts(db, groupId, { viewerId: owner });
    expect(f).toMatchObject({ subjectType: 'household', category: 'logistics' });
  });
});
