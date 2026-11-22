/**
 * `remember_fact` — the in-turn counterpart to add_person, for a fact rather
 * than a person. Writes straight to confirmed (no proposal round-trip): the
 * user stating it in this turn IS the confirmation, same reasoning as
 * add_person's direct write (executor.ts case 'add_person').
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { queryForTurn } from '@/services/memory.service.js';
import { createGroup, joinGroupByCode } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let alice: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  alice = await createUser(db, 'alice', 'Alice Doe');
  const g = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
  await joinGroupByCode(db, alice, g.invite_code);
  groupId = g.id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('remember_fact tool', () => {
  it('writes immediately as a confirmed, explicit persona fact', async () => {
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'remember_fact', args: { key: 'favorite_cuisine', value: 'thai' } },
    });
    expect(res.summary).toContain('favorite_cuisine');

    const rows = await queryForTurn(db, { groupId, triggeringUserId: john });
    const fact = rows.find((m) => m.key === 'favorite_cuisine');
    expect(fact?.value).toBe('thai');
    expect(fact?.status).toBe('confirmed');
    expect(fact?.source).toBe('explicit');
  });

  it('is visible to a later list_memories call in the same turn/group', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'remember_fact', args: { key: 'home_airport', value: 'JFK' } },
    });
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'list_memories', args: {} },
    });
    const memories = (res.data as { memories: Array<{ key: string; value: string }> }).memories;
    expect(memories.find((m) => m.key === 'home_airport')?.value).toBe('JFK');
  });

  it("is private to the asker — not visible to another member's list_memories call", async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: john,
      provenance: null,
      call: { name: 'remember_fact', args: { key: 'allergy', value: 'peanuts' } },
    });

    const res = await applyToolCall(db, {
      groupId,
      actorUserId: alice,
      provenance: null,
      call: { name: 'list_memories', args: {} },
    });
    const memories = (res.data as { memories: Array<{ key: string }> }).memories;
    expect(memories.find((m) => m.key === 'allergy')).toBeUndefined();
  });
});
