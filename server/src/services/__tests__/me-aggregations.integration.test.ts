/**
 * Regression coverage for the `/me/*` aggregation endpoints. The bug
 * that prompted these tests: a list created by John in a shared group
 * never appeared in Alice's `/me/lists` view because
 * `listListsForUser` filtered by `created_by` instead of joining
 * `group_members`. Tasks, saves, lists, and the new `createdByName`
 * enrichment are covered here so the visibility contract — "any group
 * member sees every entity in the group, with the creator's name
 * attached" — has a regression gate.
 *
 * Also covers the saves-table consolidation: save_place / save_media /
 * save_contact now write through `createSave` (kind='place' /'media' /
 * 'contact') so they land in /me/saves; lookup_contact reads from the
 * unified saves table.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addItem,
  createList,
  listLists,
  listListsForUser,
  setItemChecked,
} from '@/services/lists.service.js';
import { listSaves, listSavesForUser } from '@/services/saves.service.js';
import { listTasks, listTasksForUser, createTask } from '@/services/tasks.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('/me/* aggregations — group-shared visibility + createdByName', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // ── Lists ──────────────────────────────────────────────────────────

  it('listListsForUser returns lists from every group the user belongs to (John-Alice bug)', async () => {
    const john = await createUser(db, 'john', 'John');
    const alice = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);

    // John creates the Walmart list. created_by points at John.
    await createList(db, { groupId: group.id, name: 'Walmart', createdBy: john });

    const johnsView = await listListsForUser(db, john);
    const alicesView = await listListsForUser(db, alice);

    // Both members of the group see the list, regardless of who created it.
    expect(johnsView.map((l) => l.name)).toEqual(['Walmart']);
    expect(alicesView.map((l) => l.name)).toEqual(['Walmart']);
  });

  it('listListsForUser excludes lists from groups the user is not a member of', async () => {
    const john = await createUser(db, 'john', 'John');
    const stranger = await createUser(db, 'stranger', 'Stranger');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });

    await createList(db, { groupId: group.id, name: 'Walmart', createdBy: john });

    const strangersView = await listListsForUser(db, stranger);
    expect(strangersView).toEqual([]);
  });

  it('listListsForUser populates createdByName from the users table', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const alice = await createUser(db, 'alice', 'Alice Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);
    await createList(db, { groupId: group.id, name: 'Walmart', createdBy: john });

    const view = await listListsForUser(db, alice);
    expect(view).toHaveLength(1);
    expect(view[0]!.createdByName).toBe('John Doe');
  });

  it('listLists (per-group endpoint) also enriches createdByName', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await createList(db, { groupId: group.id, name: 'Walmart', createdBy: john });

    const rows = await listLists(db, group.id);
    expect(rows[0]!.createdByName).toBe('John Doe');
  });

  // ── Tasks ──────────────────────────────────────────────────────────

  it('listTasksForUser surfaces tasks from every group the user belongs to', async () => {
    const john = await createUser(db, 'john', 'John');
    const alice = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);

    await createTask(db, {
      groupId: group.id,
      createdBy: john,
      title: 'call dentist',
    });

    const johnsView = await listTasksForUser(db, john);
    const alicesView = await listTasksForUser(db, alice);
    expect(johnsView.map((t) => t.title)).toEqual(['call dentist']);
    expect(alicesView.map((t) => t.title)).toEqual(['call dentist']);
  });

  it('listTasksForUser populates createdByName', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const alice = await createUser(db, 'alice', 'Alice Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);
    await createTask(db, {
      groupId: group.id,
      createdBy: john,
      title: 'call dentist',
    });

    const view = await listTasksForUser(db, alice);
    expect(view[0]!.createdByName).toBe('John Doe');
  });

  it('listTasks (per-group) enriches createdByName', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await createTask(db, {
      groupId: group.id,
      createdBy: john,
      title: 'call dentist',
    });

    const rows = await listTasks(db, group.id);
    expect(rows[0]!.createdByName).toBe('John Doe');
  });

  // ── Saves ──────────────────────────────────────────────────────────

  it('listSavesForUser surfaces saves from every group the user belongs to', async () => {
    const john = await createUser(db, 'john', 'John');
    const alice = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_link',
        args: {
          title: 'NYT cookies',
          url: 'https://www.nytimes.com/best-cookies',
        },
      },
    });

    const alicesView = await listSavesForUser(db, alice);
    expect(alicesView.map((s) => s.title)).toEqual(['NYT cookies']);
  });

  it('listSavesForUser populates createdByName for the actor', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const alice = await createUser(db, 'alice', 'Alice Doe');
    const group = await createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
    await addMember(db, group.id, alice);

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_link',
        args: { title: 'NYT cookies', url: 'https://www.nytimes.com/best-cookies' },
      },
    });

    const view = await listSavesForUser(db, alice);
    expect(view[0]!.createdByName).toBe('John Doe');
  });

  // ── Saves consolidation: place / media / contact ──────────────────

  it('save_place lands in the unified saves table (kind="place"), not the orphaned places table', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Places',
      kind: 'group',
      createdBy: john,
    });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_place',
        args: {
          name: 'Salare',
          area: '25th Ave NE',
          city: 'Seattle',
          tags: ['date night'],
        },
      },
    });

    const saves = await listSaves(db, group.id);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.kind).toBe('place');
    expect(saves[0]!.title).toBe('Salare');
    // Area + city collapse into the note so the structured detail
    // survives the saves-table shape.
    expect(saves[0]!.note ?? '').toContain('25th Ave NE');
    expect(saves[0]!.note ?? '').toContain('Seattle');
    expect(saves[0]!.tags).toContain('date night');
  });

  it('save_media routes through saves with kind="media" and the subtype as a tag', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Media',
      kind: 'group',
      createdBy: john,
    });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_media',
        args: { kind: 'book', title: 'The Overstory', note: 'Carol rec' },
      },
    });

    const saves = await listSaves(db, group.id);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.kind).toBe('media');
    expect(saves[0]!.title).toBe('The Overstory');
    expect(saves[0]!.tags).toContain('book');
  });

  it('save_contact routes through saves with kind="contact"', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Contacts',
      kind: 'group',
      createdBy: john,
    });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_contact',
        args: {
          name: 'Dr. Patel',
          org: 'Smile Dental',
          family: 'dentist',
          tags: ['health'],
        },
      },
    });

    const saves = await listSaves(db, group.id);
    expect(saves).toHaveLength(1);
    expect(saves[0]!.kind).toBe('contact');
    expect(saves[0]!.title).toBe('Dr. Patel');
    expect(saves[0]!.note ?? '').toContain('Smile Dental');
    expect(saves[0]!.note ?? '').toContain('dentist');
  });

  // ── setItemChecked: fans out across same-text items in the group ─

  it('checking "milk" in Walmart also marks "milk" in Errands as checked (same group)', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    const walmart = await createList(db, {
      groupId: group.id,
      name: 'Walmart',
      createdBy: john,
    });
    const errands = await createList(db, {
      groupId: group.id,
      name: 'Errands',
      createdBy: john,
    });
    const walmartMilk = (await addItem(db, walmart.id, 'milk')).item;
    const errandsMilk = (await addItem(db, errands.id, 'milk')).item;
    const errandsMail = (await addItem(db, errands.id, 'mail package')).item;

    await setItemChecked(db, walmartMilk.id, true);

    // Both "milk" rows are now checked. "mail package" is unaffected.
    const allItems = await db
      .selectFrom('list_items')
      .selectAll()
      .where('id', 'in', [walmartMilk.id, errandsMilk.id, errandsMail.id])
      .execute();
    const byId = Object.fromEntries(allItems.map((r) => [r.id, r]));
    expect(byId[walmartMilk.id]!.checked).toBe(1);
    expect(byId[errandsMilk.id]!.checked).toBe(1);
    expect(byId[errandsMail.id]!.checked).toBe(0);
  });

  it('un-checking fans out the same way (idempotent inverse)', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    const walmart = await createList(db, {
      groupId: group.id,
      name: 'Walmart',
      createdBy: john,
    });
    const errands = await createList(db, {
      groupId: group.id,
      name: 'Errands',
      createdBy: john,
    });
    const walmartMilk = (await addItem(db, walmart.id, 'milk')).item;
    const errandsMilk = (await addItem(db, errands.id, 'milk')).item;
    await setItemChecked(db, walmartMilk.id, true);
    // Now both are checked. Un-check via Errands.
    await setItemChecked(db, errandsMilk.id, false);

    const rows = await db
      .selectFrom('list_items')
      .selectAll()
      .where('id', 'in', [walmartMilk.id, errandsMilk.id])
      .execute();
    expect(rows.every((r) => r.checked === 0)).toBe(true);
  });

  it('fanout is scoped to the group — items in OTHER groups are unaffected', async () => {
    const john = await createUser(db, 'john');
    const groupA = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    const groupB = await createGroup(db, {
      name: 'Roommates',
      kind: 'group',
      createdBy: john,
    });
    const familyList = await createList(db, {
      groupId: groupA.id,
      name: 'Walmart',
      createdBy: john,
    });
    const roommatesList = await createList(db, {
      groupId: groupB.id,
      name: 'Walmart',
      createdBy: john,
    });
    const familyMilk = (await addItem(db, familyList.id, 'milk')).item;
    const roommatesMilk = (await addItem(db, roommatesList.id, 'milk')).item;

    await setItemChecked(db, familyMilk.id, true);

    const rows = await db
      .selectFrom('list_items')
      .selectAll()
      .where('id', 'in', [familyMilk.id, roommatesMilk.id])
      .execute();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[familyMilk.id]!.checked).toBe(1);
    // Different group — must NOT cascade across the privacy boundary.
    expect(byId[roommatesMilk.id]!.checked).toBe(0);
  });

  it('fanout matches normalization (case + whitespace insensitive)', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    const walmart = await createList(db, {
      groupId: group.id,
      name: 'Walmart',
      createdBy: john,
    });
    const errands = await createList(db, {
      groupId: group.id,
      name: 'Errands',
      createdBy: john,
    });
    const a = (await addItem(db, walmart.id, 'Milk')).item;
    const b = (await addItem(db, errands.id, '  milk')).item;

    await setItemChecked(db, a.id, true);
    const rows = await db
      .selectFrom('list_items')
      .selectAll()
      .where('id', 'in', [a.id, b.id])
      .execute();
    expect(rows.every((r) => r.checked === 1)).toBe(true);
  });

  // ── search_saves: scans saves AND lists ──────────────────────────

  it('search_saves matches a save by title', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_link',
        args: { title: 'Best ramen in Seattle', url: 'https://example.com/ramen' },
      },
    });

    const r = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search_saves', args: { query: 'ramen' } },
    });
    const data = r.data as { saves: { title: string }[]; lists: unknown[] };
    expect(data.saves.map((s) => s.title)).toContain('Best ramen in Seattle');
  });

  it('search_saves finds list items added via add_list_item ("restaurants to try")', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'add_list_item',
        args: {
          listName: 'restaurants to try',
          items: ['Zuni Cafe', 'State Bird Provisions'],
        },
      },
    });

    const r = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search_saves', args: { query: 'zuni' } },
    });
    const data = r.data as {
      saves: unknown[];
      lists: Array<{ listName: string; matchedItems: { text: string }[] }>;
    };
    expect(data.lists.length).toBeGreaterThan(0);
    const hit = data.lists.find((l) => l.listName === 'restaurants to try')!;
    expect(hit).toBeDefined();
    expect(hit.matchedItems.map((i) => i.text)).toContain('Zuni Cafe');
  });

  it('search_saves with a list-name match returns every item from that list', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'add_list_item',
        args: {
          listName: 'restaurants to try',
          items: ['Zuni Cafe', 'State Bird Provisions', 'Liholiho'],
        },
      },
    });

    const r = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search_saves', args: { query: 'restaurants' } },
    });
    const data = r.data as {
      lists: Array<{ listName: string; matchedItems: { text: string }[] }>;
    };
    const hit = data.lists.find((l) => l.listName === 'restaurants to try');
    expect(hit).toBeDefined();
    expect(hit!.matchedItems).toHaveLength(3);
  });

  it('search_saves returns combined saves AND list hits for the same query', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: john,
    });
    // One save matching, one list-item matching, both for "salare".
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_place',
        args: { name: 'Salare', area: '25th Ave NE', tags: ['date'] },
      },
    });
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'add_list_item',
        args: { listName: 'date spots', items: ['Salare', 'Canlis'] },
      },
    });

    const r = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search_saves', args: { query: 'salare' } },
    });
    const data = r.data as {
      saves: { title: string }[];
      lists: Array<{ listName: string; matchedItems: { text: string }[] }>;
    };
    expect(data.saves.map((s) => s.title)).toContain('Salare');
    const listHit = data.lists.find((l) => l.listName === 'date spots');
    expect(listHit).toBeDefined();
    expect(listHit!.matchedItems.map((i) => i.text)).toContain('Salare');
  });

  it('lookup_contact reads contacts from the saves table by title', async () => {
    const john = await createUser(db, 'john');
    const group = await createGroup(db, {
      name: 'Contacts',
      kind: 'group',
      createdBy: john,
    });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'save_contact',
        args: { name: 'Dr. Patel', org: 'Smile Dental' },
      },
    });

    const result = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: {
        name: 'lookup_contact',
        args: { name: 'patel' },
      },
    });
    const data = result.data as { contact: { name: string; note: string | null } | null };
    expect(data.contact).not.toBeNull();
    expect(data.contact!.name).toBe('Dr. Patel');
    expect(data.contact!.note ?? '').toContain('Smile Dental');
  });
});
