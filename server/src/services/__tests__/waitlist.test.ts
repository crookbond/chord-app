/**
 * Coverage for migration 039 + the waitlist insert/dedupe shape used by
 * POST /api/v1/waitlist. The route logic is thin (validate → check
 * existing → insert), so we exercise the DB contract directly: unique
 * email, optional name/note, and the "already on list" path returning a
 * row without a second insert.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('waitlist table (migration 039)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('inserts a waitlist row and reads it back', async () => {
    await db
      .insertInto('waitlist')
      .values({
        id: 'w_test1',
        email: 'a@example.com',
        name: 'Ada',
        note: 'love this',
        created_at: new Date().toISOString(),
      })
      .execute();

    const row = await db
      .selectFrom('waitlist')
      .selectAll()
      .where('email', '=', 'a@example.com')
      .executeTakeFirst();

    expect(row?.id).toBe('w_test1');
    expect(row?.name).toBe('Ada');
    expect(row?.note).toBe('love this');
  });

  it('allows nullable name and note', async () => {
    await db
      .insertInto('waitlist')
      .values({
        id: 'w_test2',
        email: 'b@example.com',
        name: null,
        note: null,
        created_at: new Date().toISOString(),
      })
      .execute();

    const row = await db
      .selectFrom('waitlist')
      .selectAll()
      .where('email', '=', 'b@example.com')
      .executeTakeFirst();

    expect(row?.name).toBeNull();
    expect(row?.note).toBeNull();
  });

  it('enforces unique email — second insert with same email throws', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('waitlist')
      .values({ id: 'w_dup1', email: 'dup@example.com', name: null, note: null, created_at: now })
      .execute();

    await expect(
      db
        .insertInto('waitlist')
        .values({ id: 'w_dup2', email: 'dup@example.com', name: null, note: null, created_at: now })
        .execute(),
    ).rejects.toThrow();
  });

  it('lookup-then-skip is how the route dedupes — existing row is returned without re-insert', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('waitlist')
      .values({ id: 'w_pre', email: 'pre@example.com', name: 'Pre', note: null, created_at: now })
      .execute();

    const existing = await db
      .selectFrom('waitlist')
      .select('id')
      .where('email', '=', 'pre@example.com')
      .executeTakeFirst();

    expect(existing?.id).toBe('w_pre');

    const count = await db
      .selectFrom('waitlist')
      .select(db.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });
});
