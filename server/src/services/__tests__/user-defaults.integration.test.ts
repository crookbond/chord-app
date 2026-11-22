/**
 * ADR 0255 addendum — later per-user defaults share one jsonb column instead
 * of a column each. Pinned: keys do not clobber each other, null removes a
 * key, a value that no longer parses reads as unset, and one user's defaults
 * never touch another's.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { DB } from '@/db/schema.js';
import { defineUserDefault } from '@/services/user-defaults.service.js';
import { closeParallelHandle, closeTestDb, createUser, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';

const reminderLead = defineUserDefault('test_reminder_lead_minutes', z.number().int().min(0).max(1440));
const listName = defineUserDefault('test_list_name', z.string().min(1));

describe('user defaults (key → value)', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('is unset until set, and keys are independent', async () => {
    expect(await reminderLead.get(db, userId)).toBeNull();

    await reminderLead.set(db, userId, 30);
    await listName.set(db, userId, "Trader Joe's");

    expect(await reminderLead.get(db, userId)).toBe(30);
    expect(await listName.get(db, userId)).toBe("Trader Joe's");
  });

  it('null removes only that key', async () => {
    await reminderLead.set(db, userId, 30);
    await listName.set(db, userId, 'Groceries');
    await reminderLead.set(db, userId, null);

    expect(await reminderLead.get(db, userId)).toBeNull();
    expect(await listName.get(db, userId)).toBe('Groceries');
    const row = await db.selectFrom('users').select('defaults').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(row.defaults).toEqual({ test_list_name: 'Groceries' });
  });

  it('refuses to write a value its schema rejects', async () => {
    await expect(reminderLead.set(db, userId, -5)).rejects.toThrow();
    expect(await reminderLead.get(db, userId)).toBeNull();
  });

  it('reads a stored value that no longer parses as unset', async () => {
    await db
      .updateTable('users')
      .set({ defaults: JSON.stringify({ test_reminder_lead_minutes: 'half an hour' }) })
      .where('id', '=', userId)
      .execute();

    expect(await reminderLead.get(db, userId)).toBeNull();
  });

  it("does not touch another user's defaults", async () => {
    const other = await createUser(db, 'alice');
    await reminderLead.set(db, userId, 10);

    expect(await reminderLead.get(db, other)).toBeNull();
  });

  it('refuses a key declared twice', () => {
    expect(() => defineUserDefault('test_list_name', z.string())).toThrow(/declared twice/);
  });
});

describe('user default update', () => {
  const tags = defineUserDefault('test_tags', z.array(z.string()));
  let db: Kysely<DB>;
  let par: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    par = openParallelHandle(db);
    userId = await createUser(db, 'john');
  });
  afterEach(async () => {
    await closeParallelHandle(par);
    await closeTestDb(db);
  });

  it('changes made at the same moment all land', async () => {
    const add = (t: string) =>
      tags.update(par, userId, (cur) => ({ value: [...(cur ?? []), t], result: undefined }));
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(add));
    expect((await tags.get(db, userId))?.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('undefined writes nothing and the result comes back', async () => {
    await tags.set(db, userId, ['keep']);
    const r = await tags.update(db, userId, (cur) => ({ value: undefined, result: cur?.length }));
    expect(r).toBe(1);
    expect(await tags.get(db, userId)).toEqual(['keep']);
  });
});
