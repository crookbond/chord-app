/**
 * listTrustCandidates: union of users sharing at least one group with
 * the requester, deduplicated, excluding self, with sharedGroups names
 * collected from every overlap.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { listTrustCandidates } from '@/services/trust.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function makeUser(
  db: Kysely<DB>,
  display: string,
  email: string | null = null,
): Promise<string> {
  const id = newId('u');
  await db
    .insertInto('users')
    .values({
      id,
      username: display.toLowerCase().replace(/\s+/g, '_'),
      display_name: display,
      email,
      created_at: new Date().toISOString(),
      shadow: 0,
    })
    .execute();
  return id;
}

async function makeGroup(
  db: Kysely<DB>,
  name: string,
  creator: string,
  members: string[],
): Promise<string> {
  const id = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id,
      name,
      kind: 'group',
      invite_code: id.slice(2, 8).toUpperCase(),
      ingest_email: `${id.slice(2)}@chord.app`,
      created_by: creator,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  for (const u of [creator, ...members]) {
    await db
      .insertInto('group_members')
      .values({
        group_id: id,
        user_id: u,
        role: u === creator ? 'owner' : 'member',
        tier: 'verified',
        joined_at: now,
      })
      .execute();
  }
  return id;
}

describe('listTrustCandidates', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns users I share a group with, excluding myself', async () => {
    const me = await makeUser(db, 'Me', 'me@x.com');
    const alice = await makeUser(db, 'Alice', 'a@x.com');
    const bob = await makeUser(db, 'Bob', null);
    await makeGroup(db, 'Family', me, [alice, bob]);

    const result = await listTrustCandidates(db, me);
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.userId === me)).toBeUndefined();
    const a = result.find((c) => c.userId === alice);
    expect(a).toMatchObject({
      displayName: 'Alice',
      email: 'a@x.com',
      sharedGroups: ['Family'],
    });
    const b = result.find((c) => c.userId === bob);
    expect(b).toMatchObject({ displayName: 'Bob', email: null });
  });

  it('deduplicates a user appearing in multiple shared groups', async () => {
    const me = await makeUser(db, 'Me');
    const alice = await makeUser(db, 'Alice');
    await makeGroup(db, 'Family', me, [alice]);
    await makeGroup(db, 'Trip', me, [alice]);

    const result = await listTrustCandidates(db, me);
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(alice);
    expect(result[0].sharedGroups.sort()).toEqual(['Family', 'Trip']);
  });

  it('excludes users I have no group overlap with', async () => {
    const me = await makeUser(db, 'Me');
    const stranger = await makeUser(db, 'Stranger');
    await makeGroup(db, 'Solo', me, []);
    await makeGroup(db, 'Other', stranger, []);

    const result = await listTrustCandidates(db, me);
    expect(result).toHaveLength(0);
  });

  it('sorts case-insensitively by display name', async () => {
    const me = await makeUser(db, 'Me');
    const charlie = await makeUser(db, 'charlie');
    const Bob = await makeUser(db, 'Bob');
    const alice = await makeUser(db, 'alice');
    await makeGroup(db, 'G', me, [charlie, Bob, alice]);

    const result = await listTrustCandidates(db, me);
    expect(result.map((c) => c.displayName)).toEqual(['alice', 'Bob', 'charlie']);
  });
});
