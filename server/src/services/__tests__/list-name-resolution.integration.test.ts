/**
 * ADR 0094 — read and write agree, and the forks already in the database heal.
 *
 * `resolveListName` is unit-tested next door; this covers the two things only
 * a database shows: that the resolver is actually wired into the write path
 * (so "restaurant list" appends instead of creating), and that
 * `mergeDuplicateLists` folds the rows the old `=` left behind without losing
 * an item or duplicating one.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { mergeDuplicateLists } from '@/db/list-merge.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addItem,
  createList,
  listLists,
  renameList,
  resolveOrCreateListByName,
} from '@/services/lists.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  groupId = (await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: userId })).id;
});

afterEach(async () => {
  await closeTestDb(db);
});

async function resolve(name: string) {
  return resolveOrCreateListByName(db, groupId, name, userId);
}

describe('resolveOrCreateListByName', () => {
  it('appends to the existing list however the name is said', async () => {
    const first = await resolve('Restaurants');
    expect(first.status).toBe('resolved');

    for (const spoken of ['restaurants', 'RESTAURANTS', 'restaurant list', 'Restaurant']) {
      const again = await resolve(spoken);
      expect(again.status === 'resolved' && again.match.id).toBe(
        first.status === 'resolved' ? first.match.id : null,
      );
    }
    expect(await listLists(db, groupId)).toHaveLength(1);
  });

  it('a burst of concurrent turns resolving one name creates one list, not a fork (ADR 0155)', async () => {
    // The prod incident: "add oatmeal to trader joes list" / "add bananas" /
    // "add to trader joes ..." fired within seconds, each its own bot turn.
    // Every turn's SELECT ran before any INSERT committed, so each created a
    // "Trader Joes" fork. The transaction + advisory lock serialises them.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? resolve('Trader Joes') : resolve('trader joes list'),
      ),
    );
    const ids = new Set(
      results.map((r) => (r.status === 'resolved' ? r.match.id : `not-resolved-${Math.random()}`)),
    );
    expect(ids.size).toBe(1);
    expect(await listLists(db, groupId)).toHaveLength(1);
  });

  it('creates when nothing matches', async () => {
    await resolve('Restaurants');
    await resolve('Costco');
    expect((await listLists(db, groupId)).map((l) => l.name).sort()).toEqual([
      'Costco',
      'Restaurants',
    ]);
  });

  it('asks instead of minting a third list when the name fits two', async () => {
    await resolve('Books to read');
    await resolve('Books to buy');

    const r = await resolve('books');
    expect(r.status).toBe('ambiguous');
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.name).sort()).toEqual([
      'Books to buy',
      'Books to read',
    ]);
    // The point of asking: no third list was created.
    expect(await listLists(db, groupId)).toHaveLength(2);
  });

  it('stays inside the group — a same-named list elsewhere is untouched', async () => {
    const other = (
      await createGroup(db, { name: 'Other', kind: 'group', createdBy: userId })
    ).id;
    const mine = await resolve('Restaurants');
    const theirs = await resolveOrCreateListByName(db, other, 'restaurants', userId);
    expect(mine.status === 'resolved' && theirs.status === 'resolved').toBe(true);
    expect(mine.status === 'resolved' && theirs.status === 'resolved'
      ? mine.match.id !== theirs.match.id
      : false).toBe(true);
  });
});

describe('mergeDuplicateLists', () => {
  it('folds the forks into the oldest and moves the items across', async () => {
    const keeper = await createList(db, { groupId, name: 'Restaurants', createdBy: userId });
    await addItem(db, keeper.id, 'Rasika');
    const fork = await createList(db, { groupId, name: 'restaurant list', createdBy: userId });
    await addItem(db, fork.id, 'Veeray');

    await mergeDuplicateLists(db);

    const after = await listLists(db, groupId);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(keeper.id);
    expect(after[0].name).toBe('Restaurants');
    expect(after[0].items.map((i) => i.text).sort()).toEqual(['Rasika', 'Veeray']);
  });

  it('does not duplicate an item both lists already had', async () => {
    const keeper = await createList(db, { groupId, name: 'Groceries', createdBy: userId });
    await addItem(db, keeper.id, 'Milk');
    const fork = await createList(db, { groupId, name: 'grocery', createdBy: userId });
    await addItem(db, fork.id, 'milk');
    await addItem(db, fork.id, 'Bread');

    await mergeDuplicateLists(db);

    const after = await listLists(db, groupId);
    expect(after).toHaveLength(1);
    expect(after[0].items.map((i) => i.text).sort()).toEqual(['Bread', 'Milk']);
  });

  it('leaves genuinely different lists alone and is safe to re-run', async () => {
    await createList(db, { groupId, name: 'Books to read', createdBy: userId });
    await createList(db, { groupId, name: 'Books to buy', createdBy: userId });

    await mergeDuplicateLists(db);
    await mergeDuplicateLists(db);

    expect((await listLists(db, groupId)).map((l) => l.name).sort()).toEqual([
      'Books to buy',
      'Books to read',
    ]);
  });

  it('never merges across groups', async () => {
    const other = (
      await createGroup(db, { name: 'Other', kind: 'group', createdBy: userId })
    ).id;
    await createList(db, { groupId, name: 'Restaurants', createdBy: userId });
    await createList(db, { groupId: other, name: 'restaurants', createdBy: userId });

    await mergeDuplicateLists(db);

    expect(await listLists(db, groupId)).toHaveLength(1);
    expect(await listLists(db, other)).toHaveLength(1);
  });
});

describe('renameList on a colliding name', () => {
  it('merges instead of stranding the other list', async () => {
    const keeper = await createList(db, { groupId, name: 'Restaurants', createdBy: userId });
    await addItem(db, keeper.id, 'Rasika');
    const fork = await createList(db, { groupId, name: 'restaurant list', createdBy: userId });
    await addItem(db, fork.id, 'Veeray');

    const res = await renameList(db, fork.id, 'Restaurants');

    expect(res?.merged).toMatchObject({ removedName: 'restaurant list', movedItems: 1 });
    const after = await listLists(db, groupId);
    expect(after).toHaveLength(1);
    // Oldest keeps the rows, and it carries the name the user typed.
    expect(after[0].id).toBe(keeper.id);
    expect(after[0].name).toBe('Restaurants');
    expect(after[0].items.map((i) => i.text).sort()).toEqual(['Rasika', 'Veeray']);
  });

  it('renaming the older list onto a newer one still keeps the older row', async () => {
    const older = await createList(db, { groupId, name: 'Restaurants', createdBy: userId });
    await addItem(db, older.id, 'Rasika');
    const newer = await createList(db, { groupId, name: 'Places to eat', createdBy: userId });
    await addItem(db, newer.id, 'Veeray');

    const res = await renameList(db, older.id, 'places to eat');

    expect(res?.list.id).toBe(older.id);
    expect(res?.list.name).toBe('places to eat');
    expect(res?.merged?.movedItems).toBe(1);
    const after = await listLists(db, groupId);
    expect(after).toHaveLength(1);
    expect(after[0].items.map((i) => i.text).sort()).toEqual(['Rasika', 'Veeray']);
  });

  it('does not duplicate an item both lists held', async () => {
    const keeper = await createList(db, { groupId, name: 'Groceries', createdBy: userId });
    await addItem(db, keeper.id, 'Milk');
    const fork = await createList(db, { groupId, name: 'Shopping', createdBy: userId });
    await addItem(db, fork.id, 'milk');
    await addItem(db, fork.id, 'Bread');

    await renameList(db, fork.id, 'grocery');

    const after = await listLists(db, groupId);
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('grocery');
    expect(after[0].items.map((i) => i.text).sort()).toEqual(['Bread', 'Milk']);
  });

  it('leaves an ordinary rename alone', async () => {
    const list = await createList(db, { groupId, name: 'Costco', createdBy: userId });
    const res = await renameList(db, list.id, 'Whole Foods');
    expect(res?.merged).toBeNull();
    expect(res?.list.id).toBe(list.id);
    expect(await listLists(db, groupId)).toHaveLength(1);
  });

  it('never merges a list from another group', async () => {
    const other = (
      await createGroup(db, { name: 'Other', kind: 'group', createdBy: userId })
    ).id;
    await createList(db, { groupId: other, name: 'Restaurants', createdBy: userId });
    const mine = await createList(db, { groupId, name: 'Costco', createdBy: userId });

    const res = await renameList(db, mine.id, 'restaurants');

    expect(res?.merged).toBeNull();
    expect(await listLists(db, groupId)).toHaveLength(1);
    expect(await listLists(db, other)).toHaveLength(1);
  });
});
