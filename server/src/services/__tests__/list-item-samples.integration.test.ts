/**
 * The bot's snapshot previews a list with its first few unticked items; the
 * preview reads only those rows, not every item of every list.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { createList, openItemSamples } from '@/services/lists.service.js';
import { newId } from '@/utils/ids.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

async function item(listId: string, text: string, minute: number, checked = 0): Promise<void> {
  await db
    .insertInto('list_items')
    .values({
      id: newId('li'),
      list_id: listId,
      text,
      checked,
      created_at: new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString(),
    })
    .execute();
}

describe('openItemSamples', () => {
  it('gives each list its oldest unticked items, up to the cap', async () => {
    const uid = await createUser(db, 'sampler');
    const g = await createGroup(db, { name: 'Home', kind: 'group', createdBy: uid });
    const groceries = await createList(db, { groupId: g.id, name: 'Groceries', createdBy: uid });
    const packing = await createList(db, { groupId: g.id, name: 'Packing', createdBy: uid });
    const empty = await createList(db, { groupId: g.id, name: 'Empty', createdBy: uid });

    await item(groceries.id, 'eggs', 3);
    await item(groceries.id, 'milk', 1);
    await item(groceries.id, 'bread', 2, 1);
    await item(groceries.id, 'jam', 4);
    await item(groceries.id, 'tea', 5);
    await item(packing.id, 'socks', 1);
    await item(empty.id, 'done thing', 1, 1);

    const samples = await openItemSamples(db, [groceries.id, packing.id, empty.id], 3);
    expect(samples.get(groceries.id)).toEqual(['milk', 'eggs', 'jam']);
    expect(samples.get(packing.id)).toEqual(['socks']);
    expect(samples.has(empty.id)).toBe(false);
    expect((await openItemSamples(db, [], 3)).size).toBe(0);
  });
});
