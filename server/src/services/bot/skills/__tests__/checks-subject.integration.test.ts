/**
 * ADR 0333 — an onboarding question is skipped only for a fact about THIS
 * user (or a school they can see). Before: owning a private fact about the
 * spouse's airport counted as "home airport known", another member's private
 * school fact counted as "school known", and a proposed airport counted too.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { hasFact, knowsHome, knowsSchool } from '@/services/bot/skills/checks.js';
import { createGroup } from '@/services/groups.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let alice: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  alice = await createUser(db, 'alice', 'Alice Doe');
  groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john })).id;
  await db
    .insertInto('group_members')
    .values({ group_id: groupId, user_id: alice, role: 'member', tier: 'verified', joined_at: new Date().toISOString() })
    .execute();
  await db.updateTable('users').set({ weather_place_source: 'user' }).where('id', '=', john).execute();
});

afterEach(async () => {
  await closeTestDb(db);
});

const ctx = (userId: string) => ({ db, userId }) as Parameters<typeof hasFact>[0];

describe('onboarding checks read only facts about the user', () => {
  it("a private fact John owns about Alice's airport is not John's airport", async () => {
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: john,
      subjectType: 'user',
      subjectId: alice,
      key: 'home_airport',
      value: 'EWR',
      source: 'explicit',
      status: 'confirmed',
    });
    expect(await hasFact(ctx(john), 'home_airport')).toBe(false);
    expect(await knowsHome(ctx(john))).toBe(false);
  });

  it('a proposed home airport does not count', async () => {
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: john,
      subjectType: 'user',
      subjectId: john,
      key: 'home_airport',
      value: 'JFK',
      source: 'extracted',
      status: 'proposed',
    });
    expect(await knowsHome(ctx(john))).toBe(false);
  });

  it("another member's private school fact does not count, a shared one does", async () => {
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: alice,
      subjectType: 'user',
      subjectId: alice,
      key: 'kid_school',
      value: 'Lincoln Elementary',
      source: 'explicit',
      status: 'confirmed',
    });
    expect(await knowsSchool(ctx(john))).toBe(false);
    expect(await knowsSchool(ctx(alice))).toBe(true);

    await upsertMemory(db, {
      groupId,
      scope: 'group',
      subjectType: 'household',
      key: 'kid_school',
      value: 'Lincoln Elementary',
      source: 'explicit',
      status: 'confirmed',
    });
    expect(await knowsSchool(ctx(john))).toBe(true);
  });
});
