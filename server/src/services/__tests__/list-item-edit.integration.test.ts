/**
 * List-item text editing (PR3 follow-up). `setItemText` renames a single
 * row; the mobile Lists view fans a rename out across a consolidated
 * bucket item's sources itself, so the service deliberately does NOT do
 * the group-wide normalized-text fanout that `setItemChecked` does.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createUser, openTestDb, closeTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { addItem, createList, getItem, setItemText } from '@/services/lists.service.js';

describe('setItemText — rename a single list item', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('updates the row text and returns the updated item', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe', kind: 'group', createdBy: john });
    const list = await createList(db, { groupId: group.id, name: 'Costco', createdBy: john });
    const { item } = await addItem(db, list.id, 'milk');

    const updated = await setItemText(db, item.id, 'oat milk');
    expect(updated?.text).toBe('oat milk');

    const reread = await getItem(db, item.id);
    expect(reread?.text).toBe('oat milk');
  });

  it('trims whitespace and is a no-op for unchanged text', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe', kind: 'group', createdBy: john });
    const list = await createList(db, { groupId: group.id, name: 'Costco', createdBy: john });
    const { item } = await addItem(db, list.id, 'bread');

    const trimmed = await setItemText(db, item.id, '  sourdough bread  ');
    expect(trimmed?.text).toBe('sourdough bread');

    const same = await setItemText(db, item.id, 'sourdough bread');
    expect(same?.text).toBe('sourdough bread');
  });

  it('rejects empty text and missing items', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe', kind: 'group', createdBy: john });
    const list = await createList(db, { groupId: group.id, name: 'Costco', createdBy: john });
    const { item } = await addItem(db, list.id, 'eggs');

    expect(await setItemText(db, item.id, '   ')).toBeNull();
    expect(await setItemText(db, 'li_does_not_exist', 'whatever')).toBeNull();

    const reread = await getItem(db, item.id);
    expect(reread?.text).toBe('eggs');
  });

  it('does not fan out across same-named items in other lists', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe', kind: 'group', createdBy: john });
    const costco = await createList(db, { groupId: group.id, name: 'Costco', createdBy: john });
    const errands = await createList(db, { groupId: group.id, name: 'Errands', createdBy: john });
    const { item: costcoMilk } = await addItem(db, costco.id, 'milk');
    const { item: errandsMilk } = await addItem(db, errands.id, 'milk');

    await setItemText(db, costcoMilk.id, 'almond milk');

    expect((await getItem(db, costcoMilk.id))?.text).toBe('almond milk');
    expect((await getItem(db, errandsMilk.id))?.text).toBe('milk');
  });
});
