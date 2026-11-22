/**
 * A group fan-out assigns one entity to every member. It used to do that with
 * one INSERT per member, awaited in sequence inside the request that created
 * the task, list or save (five members: five inserts, plus two folder selects).
 * The common case is now a single INSERT; members that need a side effect still
 * take the per-member path, and must end up exactly where they always did.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { fanoutAssignment } from '@/services/catchup/folders.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

/** Count writes to catchup_assignments without changing what runs. */
function countAssignmentInserts(db: Kysely<DB>): { db: Kysely<DB>; inserts: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'insertInto') {
        return (table: string) => {
          if (table === 'catchup_assignments') n += 1;
          return (target.insertInto as (t: string) => unknown).call(target, table);
        };
      }
      // Kysely keeps private fields, so a method must run against the real handle.
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as Kysely<DB>;
  return { db: proxy, inserts: () => n };
}

describe('catchup fan-out (bulk write)', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let members: string[];

  beforeEach(async () => {
    db = await openTestDb();
    const owner = await createUser(db, 'owner');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: owner });
    groupId = group.id;
    members = [owner];
    for (const name of ['m1', 'm2', 'm3', 'm4']) {
      const id = await createUser(db, name);
      await addMember(db, groupId, id);
      members.push(id);
    }
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const assignments = (entityId: string) =>
    db
      .selectFrom('catchup_assignments as a')
      .innerJoin('catchup_folders as f', 'f.id', 'a.folder_id')
      .select(['a.user_id', 'f.name as folder', 'a.pending_folder_name as pending'])
      .where('a.entity_id', '=', entityId)
      .execute();

  it('writes a five-member group in one insert, each member in their own tasks folder', async () => {
    const counted = countAssignmentInserts(db);
    const id = newId('t');
    await fanoutAssignment(counted.db, groupId, 'task', id, { type: 'task', primary: 'Call grandma' });

    expect(counted.inserts()).toBe(1);
    const rows = await assignments(id);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set(members));
    expect(rows.every((r) => r.folder === 'tasks' && r.pending === null)).toBe(true);
  });

  it('is idempotent: fanning the same entity out again updates, never duplicates', async () => {
    const id = newId('t');
    await fanoutAssignment(db, groupId, 'task', id, { type: 'task', primary: 'Call grandma' });
    await fanoutAssignment(db, groupId, 'task', id, { type: 'task', primary: 'Call grandma' });
    expect(await assignments(id)).toHaveLength(5);
  });

  it('parks a suggestion that is not a folder yet in "other", as before', async () => {
    const id = newId('l');
    await fanoutAssignment(db, groupId, 'list', id, { type: 'list', primary: 'Costco list' });
    const rows = await assignments(id);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.folder === 'other' && r.pending === 'shopping')).toBe(true);
  });

  it('a member who already has the suggested folder goes straight into it; the rest are parked', async () => {
    // m1 has promoted "shopping" already; nobody else has.
    await db
      .insertInto('catchup_folders')
      .values({
        id: newId('cf'),
        user_id: members[1]!,
        name: 'shopping',
        display: 'Shopping',
        kind: 'derived',
        pinned: 0,
        created_at: new Date().toISOString(),
      })
      .execute();

    const id = newId('l');
    await fanoutAssignment(db, groupId, 'list', id, { type: 'list', primary: 'Costco list' });
    const rows = await assignments(id);
    const byUser = new Map(rows.map((r) => [r.user_id, r]));
    expect(byUser.get(members[1]!)).toMatchObject({ folder: 'shopping', pending: null });
    for (const u of members.filter((m) => m !== members[1])) {
      expect(byUser.get(u)).toMatchObject({ folder: 'other', pending: 'shopping' });
    }
  });

  it('revives an archived folder for the member who had archived it', async () => {
    await db
      .insertInto('catchup_folders')
      .values({
        id: newId('cf'),
        user_id: members[2]!,
        name: 'shopping',
        display: 'Shopping',
        kind: 'archived',
        pinned: 0,
        created_at: new Date().toISOString(),
      })
      .execute();

    const id = newId('l');
    await fanoutAssignment(db, groupId, 'list', id, { type: 'list', primary: 'Costco list' });
    const revived = await db
      .selectFrom('catchup_folders')
      .select('kind')
      .where('user_id', '=', members[2]!)
      .where('name', '=', 'shopping')
      .executeTakeFirstOrThrow();
    expect(revived.kind).toBe('derived');
    const mine = (await assignments(id)).find((r) => r.user_id === members[2]);
    expect(mine).toMatchObject({ folder: 'shopping', pending: null });
  });

  it('creates missing seed folders for members who have none, in the same pass', async () => {
    const id = newId('t');
    await fanoutAssignment(db, groupId, 'task', id, { type: 'task', primary: 'Water the plants' });
    const seeds = await db
      .selectFrom('catchup_folders')
      .select(['user_id', 'name'])
      .where('kind', '=', 'seed')
      .execute();
    // 4 seeds (tasks, lists, trips, other) for each of the 5 members, no duplicates.
    expect(seeds).toHaveLength(20);
  });

  it('concurrent fan-outs for the same members do not collide creating their seed folders', async () => {
    // Several tasks created at once in one group: every fan-out sees no seed
    // folders yet, and (user_id, name) is unique.
    const ids = Array.from({ length: 8 }, () => newId('t'));
    const results = await Promise.allSettled(
      ids.map((id) => fanoutAssignment(db, groupId, 'task', id, { type: 'task', primary: 'Call grandma' })),
    );
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    for (const id of ids) expect(await assignments(id)).toHaveLength(5);
    const seeds = await db.selectFrom('catchup_folders').select('id').where('kind', '=', 'seed').execute();
    expect(seeds).toHaveLength(20);
  });
});
