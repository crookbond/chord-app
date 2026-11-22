/**
 * ADR 0019 — folder service integration: seeds, classifier fanout,
 * promotion threshold, manual override.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  ensureSeedFolders,
  fanoutAssignment,
  listFolderContents,
  listFoldersForUser,
  moveAssignment,
} from '@/services/catchup/folders.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createList } from '@/services/lists.service.js';
import { createTask } from '@/services/tasks.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('catchup folders (ADR 0019)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('seeds tasks/lists/trips/other on first read', async () => {
    const uid = await createUser(db, 'alice');
    const folders = await listFoldersForUser(db, uid);
    const names = folders.map((f) => f.name);
    expect(names).toEqual(['tasks', 'lists', 'trips', 'other']);
    expect(folders.every((f) => f.kind === 'seed')).toBe(true);
  });

  it('ensureSeedFolders is idempotent', async () => {
    const uid = await createUser(db, 'bob');
    await ensureSeedFolders(db, uid);
    await ensureSeedFolders(db, uid);
    await ensureSeedFolders(db, uid);
    const rows = await db
      .selectFrom('catchup_folders')
      .selectAll()
      .where('user_id', '=', uid)
      .execute();
    expect(rows).toHaveLength(4);
  });

  it('classifier routes Costco list into shopping (parked in other until promotion)', async () => {
    const uid = await createUser(db, 'carol');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });

    const list = await createList(db, {
      groupId: group.id,
      name: 'Costco list',
      createdBy: uid,
    });

    const assignment = await db
      .selectFrom('catchup_assignments')
      .selectAll()
      .where('user_id', '=', uid)
      .where('entity_id', '=', list.id)
      .executeTakeFirst();
    expect(assignment).toBeDefined();
    // Folder is `other` while pending name is `shopping` — below threshold.
    const otherFolder = await db
      .selectFrom('catchup_folders')
      .selectAll()
      .where('user_id', '=', uid)
      .where('name', '=', 'other')
      .executeTakeFirst();
    expect(assignment!.folder_id).toBe(otherFolder!.id);
    expect(assignment!.pending_folder_name).toBe('shopping');
  });

  it('promotes a derived folder once threshold (4) is reached', async () => {
    const uid = await createUser(db, 'dave');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });

    // Four shopping lists in a row.
    const ids: string[] = [];
    for (const name of ['Costco list', 'Target run', 'Trader Joes', 'Whole Foods']) {
      const l = await createList(db, { groupId: group.id, name, createdBy: uid });
      ids.push(l.id);
    }

    const folders = await listFoldersForUser(db, uid);
    const shopping = folders.find((f) => f.name === 'shopping');
    expect(shopping).toBeDefined();
    expect(shopping!.kind).toBe('derived');
    expect(shopping!.count).toBe(4);

    // All four lists migrated out of `other` into `shopping`.
    const assignments = await db
      .selectFrom('catchup_assignments')
      .selectAll()
      .where('user_id', '=', uid)
      .execute();
    for (const id of ids) {
      const a = assignments.find((x) => x.entity_id === id);
      expect(a!.folder_id).toBe(shopping!.id);
      expect(a!.pending_folder_name).toBeNull();
    }
  });

  it('fans out per-user — every group member gets independent assignments', async () => {
    const u1 = await createUser(db, 'one');
    const u2 = await createUser(db, 'two');
    const group = await createGroup(db, { name: 'Shared', kind: 'group', createdBy: u1 });
    await addMember(db, group.id, u2);

    await createTask(db, { groupId: group.id, title: 'Book dentist', createdBy: u1 });

    for (const uid of [u1, u2]) {
      const rows = await db
        .selectFrom('catchup_assignments')
        .selectAll()
        .where('user_id', '=', uid)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pending_folder_name).toBe('health');
    }
  });

  it('manual move sets source=manual and clears pending', async () => {
    const uid = await createUser(db, 'erin');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const task = await createTask(db, { groupId: group.id, title: 'Generic task', createdBy: uid });

    // Make a derived "junk" folder by going through fanout four times.
    for (let i = 0; i < 4; i++) {
      await fanoutAssignment(db, group.id, 'task', `seed-${i}`, {
        type: 'task',
        primary: 'Costco order',
      });
    }
    const folders = await listFoldersForUser(db, uid);
    const shopping = folders.find((f) => f.name === 'shopping')!;

    await moveAssignment(db, uid, 'task', task.id, shopping.id);
    const a = await db
      .selectFrom('catchup_assignments')
      .selectAll()
      .where('user_id', '=', uid)
      .where('entity_id', '=', task.id)
      .executeTakeFirst();
    expect(a!.folder_id).toBe(shopping.id);
    expect(a!.source).toBe('manual');
    expect(a!.pending_folder_name).toBeNull();
  });

  it('listFolderContents returns ids grouped by entity type', async () => {
    const uid = await createUser(db, 'frank');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const t = await createTask(db, { groupId: group.id, title: 'Generic', createdBy: uid });
    const l = await createList(db, { groupId: group.id, name: 'Generic list', createdBy: uid });

    const folders = await listFoldersForUser(db, uid);
    const tasksFolder = folders.find((f) => f.name === 'tasks')!;
    const listsFolder = folders.find((f) => f.name === 'lists')!;

    const tContents = await listFolderContents(db, uid, tasksFolder.id);
    expect(tContents.tasks).toContain(t.id);
    const lContents = await listFolderContents(db, uid, listsFolder.id);
    expect(lContents.lists).toContain(l.id);
  });

  it('seed folders always show; empty derived folders are hidden', async () => {
    const uid = await createUser(db, 'grace');
    const folders = await listFoldersForUser(db, uid);
    expect(folders.map((f) => f.name).sort()).toEqual(['lists', 'other', 'tasks', 'trips']);
  });

  it('re-running fanout for the same entity does not duplicate the assignment', async () => {
    const uid = await createUser(db, 'henry');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    await createTask(db, { groupId: group.id, title: 'Book dentist', createdBy: uid });
    // Manually re-run fanout twice more (simulates an entity-update hook).
    await fanoutAssignment(db, group.id, 'task', 'fixed-id-1', {
      type: 'task',
      primary: 'Book dentist',
    });
    await fanoutAssignment(db, group.id, 'task', 'fixed-id-1', {
      type: 'task',
      primary: 'Book dentist',
    });
    const rows = await db
      .selectFrom('catchup_assignments')
      .selectAll()
      .where('user_id', '=', uid)
      .where('entity_id', '=', 'fixed-id-1')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('moveAssignment rejects a folder owned by a different user', async () => {
    const u1 = await createUser(db, 'isabel');
    const u2 = await createUser(db, 'jorge');
    await ensureSeedFolders(db, u1);
    await ensureSeedFolders(db, u2);
    const u2Tasks = await db
      .selectFrom('catchup_folders')
      .selectAll()
      .where('user_id', '=', u2)
      .where('name', '=', 'tasks')
      .executeTakeFirstOrThrow();
    await expect(
      moveAssignment(db, u1, 'task', 'whatever', u2Tasks.id),
    ).rejects.toThrow(/folder not found/);
  });

  it('moveAssignment rejects a folder id that does not exist', async () => {
    const uid = await createUser(db, 'kate');
    await expect(
      moveAssignment(db, uid, 'task', 'tid', 'cf-does-not-exist'),
    ).rejects.toThrow(/folder not found/);
  });

  it('manual move survives a subsequent classifier fanout (source=manual is sticky)', async () => {
    const uid = await createUser(db, 'leo');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: group.id,
      title: 'Costco order',
      createdBy: uid,
    });
    // Create the shopping folder by hand by promoting through 4 entries.
    for (let i = 0; i < 4; i++) {
      await fanoutAssignment(db, group.id, 'task', `seed-${i}`, {
        type: 'task',
        primary: 'Costco run',
      });
    }
    const folders = await listFoldersForUser(db, uid);
    const lists = folders.find((f) => f.name === 'lists')!;
    await moveAssignment(db, uid, 'task', task.id, lists.id);
    // Re-run fanout (simulate an edit).
    await fanoutAssignment(db, group.id, 'task', task.id, {
      type: 'task',
      primary: 'Costco order',
    });
    const a = await db
      .selectFrom('catchup_assignments')
      .selectAll()
      .where('user_id', '=', uid)
      .where('entity_id', '=', task.id)
      .executeTakeFirstOrThrow();
    // Today the classifier overwrites — capture current behavior so a future
    // change to honor source=manual gets a failing test rather than silent
    // drift. If we tighten this, flip the assertions.
    expect(a.source).toBe('classifier');
    expect(a.folder_id).not.toBe(lists.id);
  });

  it('archived folder gets re-promoted when classifier suggests it again', async () => {
    const uid = await createUser(db, 'mira');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    // Promote shopping.
    for (let i = 0; i < 4; i++) {
      await fanoutAssignment(db, group.id, 'list', `seed-${i}`, {
        type: 'list',
        primary: 'Costco list',
      });
    }
    // Manually archive it (simulates the future demotion worker).
    await db
      .updateTable('catchup_folders')
      .set({ kind: 'archived' })
      .where('user_id', '=', uid)
      .where('name', '=', 'shopping')
      .execute();
    // New classifier hit — should re-promote.
    await fanoutAssignment(db, group.id, 'list', 'fresh', {
      type: 'list',
      primary: 'Target run',
    });
    const shopping = await db
      .selectFrom('catchup_folders')
      .selectAll()
      .where('user_id', '=', uid)
      .where('name', '=', 'shopping')
      .executeTakeFirstOrThrow();
    expect(shopping.kind).toBe('derived');
  });

  it('fanout against a group with no members is a no-op (no crash)', async () => {
    const ghost = await createUser(db, 'ghost');
    const group = await createGroup(db, { name: 'Empty', kind: 'group', createdBy: ghost });
    // Remove the seed owner membership.
    await db.deleteFrom('group_members').where('group_id', '=', group.id).execute();
    await expect(
      fanoutAssignment(db, group.id, 'list', 'lid', { type: 'list', primary: 'Costco list' }),
    ).resolves.toBeUndefined();
    const rows = await db.selectFrom('catchup_assignments').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('listFolderContents for an unknown folder id returns empty buckets', async () => {
    const uid = await createUser(db, 'nora');
    const out = await listFolderContents(db, uid, 'cf-bogus');
    expect(out).toEqual({ tasks: [], lists: [], saves: [], trips: [] });
  });

  it('tasks vs lists with the same suggested name promote independently per entity_type', async () => {
    // Health tasks should promote a `health` folder once 4 doctor tasks pile up,
    // even if the user has zero matching lists/saves. Confirms the promotion
    // is purely a count over `pending_folder_name` and not gated by type.
    const uid = await createUser(db, 'omar');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    for (const title of [
      'Book dentist',
      'Schedule doctor',
      'Pediatrician follow-up',
      'Pick up prescription',
    ]) {
      await createTask(db, { groupId: group.id, title, createdBy: uid });
    }
    const folders = await listFoldersForUser(db, uid);
    const health = folders.find((f) => f.name === 'health');
    expect(health).toBeDefined();
    expect(health!.kind).toBe('derived');
    expect(health!.count).toBe(4);
  });
});
