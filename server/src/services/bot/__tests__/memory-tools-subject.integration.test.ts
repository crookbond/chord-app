/**
 * ADR 0333 — `remember_fact` saves a fact for the person it is about, and
 * `list_memories` answers a question about one person only from that
 * person's facts.
 *
 * Prod, 11 Nov 2026: "What is ben global entry" was answered with another
 * family member's number. `remember_fact` had no way to say whose a fact was,
 * so "Ben's Global Entry is …" was saved as the speaker's own fact.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { labelMemorySubjects } from '@/services/memory-notices.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { queryForTurn, upsertMemory } from '@/services/memory.service.js';
import { createPerson } from '@/services/people.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let groupId: string;
let ben: string;
let nolan: string;

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  groupId = (await ensurePersonalGroup(db, john)).id;
  ben = (await createPerson(db, { ownerUserId: john, displayName: 'Ben Doe' })).id;
  nolan = (await createPerson(db, { ownerUserId: john, displayName: 'Nolan Doe' })).id;
});

afterEach(async () => {
  await closeTestDb(db);
});

const remember = (args: Record<string, unknown>) =>
  applyToolCall(db, { groupId, actorUserId: john, provenance: null, call: { name: 'remember_fact', args } });

describe('remember_fact', () => {
  it('saves a fact about a family member under that member, by first name', async () => {
    await remember({ about: 'Ben', key: 'global_entry_number', value: '155605322' });
    await remember({ about: 'Nolan', key: 'global_entry_number', value: '154800334' });

    const facts = await queryForTurn(db, { groupId, triggeringUserId: john, limit: 50 });
    const labels = await labelMemorySubjects(db, facts);
    const ge = facts
      .filter((m) => m.key === 'global_entry_number')
      .map((m) => [labels.get(m.id), m.value, m.subjectType, m.subjectId]);
    expect(ge).toEqual(
      expect.arrayContaining([
        ['Ben Doe', '155605322', 'person', ben],
        ['Nolan Doe', '154800334', 'person', nolan],
      ]),
    );
    expect(ge).toHaveLength(2);
  });

  it('saves nothing for a name nobody has, and says so', async () => {
    const res = await remember({ about: 'Nimbus', key: 'global_entry_number', value: '123' });
    expect(res.data).toMatchObject({ saved: false, result: 'not_found' });
    expect(await queryForTurn(db, { groupId, triggeringUserId: john, limit: 50 })).toHaveLength(0);
  });

  it('asks when two people have the name', async () => {
    await createPerson(db, { ownerUserId: john, displayName: 'Ben Rao' });
    const res = await remember({ about: 'Ben', key: 'passport_number', value: 'P1' });
    expect(res.data).toMatchObject({ saved: false, result: 'ambiguous' });
  });

  it('without `about` the fact is the speaker\'s own', async () => {
    await remember({ key: 'home_airport', value: 'JFK' });
    const [f] = await queryForTurn(db, { groupId, triggeringUserId: john });
    expect(f).toMatchObject({ subjectType: 'user', subjectId: john, value: 'JFK' });
  });
});

describe('list_memories with a query naming a person', () => {
  it("does not answer with another person's fact", async () => {
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      subjectType: 'person',
      subjectId: ben,
      key: 'passport_number',
      value: 'P1234567',
      source: 'explicit',
      status: 'confirmed',
    });
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      subjectType: 'person',
      subjectId: nolan,
      key: 'global_entry_number',
      value: '154800334',
      source: 'explicit',
      status: 'confirmed',
    });
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'list_memories', args: { query: 'ben global entry' } },
    });
    const data = res.data as { matched: boolean; memories: Array<{ value: string }> };
    // Ben has no Global Entry fact: nothing matched, and what comes back is
    // Ben's own facts — never Nolan's number.
    expect(data.matched).toBe(false);
    expect(data.memories.map((m) => m.value)).toEqual(['P1234567']);
  });

  it('a person named by a word only they have is matched to their own fact', async () => {
    for (const [p, v] of [
      [nolan, '154800334'],
      [ben, '155605322'],
    ] as const) {
      await upsertMemory(db, {
        groupId,
        scope: 'group',
        subjectType: 'person',
        subjectId: p,
        key: 'global_entry_number',
        value: v,
        source: 'explicit',
        status: 'confirmed',
      });
    }
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'list_memories', args: { query: 'ben doe global entry number' } },
    });
    const data = res.data as { matched: boolean; memories: Array<{ value: string; about: string }> };
    expect(data.matched).toBe(true);
    expect(data.memories.map((m) => [m.about, m.value])).toEqual([['Ben Doe', '155605322']]);
  });
});
