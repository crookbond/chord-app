/**
 * ADR 0096 — the precise read tools follow the same scope boundary `search` does.
 *
 * The failure this closes: a list living in a shared group was invisible to
 * `get_list` asked from the personal 1:1, while `search` found it — and the
 * tool descriptions tell the model to PREFER `get_list` when the intent is
 * precise. So doing the recommended thing answered "no such list" about a list
 * the user definitely had.
 *
 * The other half is the boundary itself: a shared group must NOT gain a view
 * of the user's other groups (ADR 0032).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addItem, resolveOrCreateListByName } from '@/services/lists.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { createTaskWithDedup } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let personalId: string;
let rdmsId: string;

async function run(groupId: string, name: string, args: Record<string, unknown>) {
  const r = await applyToolCall(db, {
    groupId,
    call: { name, args } as never,
    actorUserId: john,
    provenance: 'test',
    mode: 'commit',
    emit: () => {},
  });
  return r.data as Record<string, unknown>;
}

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john');
  personalId = (await ensurePersonalGroup(db, john)).id;
  // createGroup already enrolls the creator.
  rdmsId = (await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: john })).id;

  // The veeray shape: content lives in a shared group, the question is asked
  // from the personal chat.
  const list = await resolveOrCreateListByName(db, rdmsId, 'Restaurants', john);
  if (list.status !== 'resolved') throw new Error('fixture list was ambiguous');
  await addItem(db, list.match.id, 'Veeray');
  await createTaskWithDedup(db, { groupId: rdmsId, createdBy: john, title: 'Book dentist' });
  await createSaveWithDedup(db, {
    groupId: rdmsId,
    createdBy: john,
    kind: 'place',
    title: 'Veeray',
    tags: ['indian'],
  });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('from the personal 1:1', () => {
  it('get_list finds a list that lives in a shared group, and says where', async () => {
    const data = await run(personalId, 'get_list', { listName: 'restaurant list' });
    const list = data.list as { listName: string; group: string; items: { text: string }[] };
    expect(list).toBeTruthy();
    expect(list.listName).toBe('Restaurants');
    expect(list.group).toBe('RDMS');
    expect(list.items.map((i) => i.text)).toContain('Veeray');
  });

  it('list_tasks spans the user groups and tags each row with a group NAME', async () => {
    const data = await run(personalId, 'list_tasks', {});
    expect(data.scope).toBe('all-groups');
    const tasks = data.tasks as Array<{ title: string; group: string }>;
    expect(tasks.map((t) => t.title)).toContain('Book dentist');
    expect(tasks.find((t) => t.title === 'Book dentist')?.group).toBe('RDMS');
  });

  it('search_saves reaches a save in another group', async () => {
    const data = await run(personalId, 'search_saves', { query: 'veeray' });
    const saves = data.saves as Array<{ title: string; group: string }>;
    expect(saves.map((s) => s.title)).toContain('Veeray');
    expect(saves[0].group).toBe('RDMS');
  });

  it('completing a cross-group task by ordinal actually closes it', async () => {
    // ADR 0093 records the enumeration; if complete_task looked only at the
    // turn's group it would find nothing and silently change nothing.
    await run(personalId, 'list_tasks', {});
    const data = await run(personalId, 'complete_task', { ordinals: [1] });
    expect(data.matched).not.toBe(false);
    const row = await db
      .selectFrom('tasks')
      .select('status')
      .where('group_id', '=', rdmsId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('done');
  });
});

describe('from a shared group the boundary still holds', () => {
  it('does not leak another group content into this one', async () => {
    const other = (
      await createGroup(db, { name: 'Other', kind: 'group', createdBy: john })
    ).id;

    const lists = await run(other, 'get_list', { listName: 'restaurants' });
    expect(lists.list).toBeNull();

    const tasks = await run(other, 'list_tasks', {});
    expect(tasks.scope).toBe('this-group');
    expect(tasks.tasks).toHaveLength(0);

    const saves = await run(other, 'search_saves', { query: 'veeray' });
    expect(saves.saves).toHaveLength(0);
    expect(saves.scope).toBe('this-group');
  });
});

describe('get_list when the thing was saved, not listed', () => {
  it('answers from saves rather than reporting nothing', async () => {
    // The veeray case exactly: `save_place` files a restaurant into `saves`,
    // the user asks about their "restaurants list", and no such list exists.
    const solo = await createUser(db, 'solo');
    const soloPersonal = (await ensurePersonalGroup(db, solo)).id;
    await createSaveWithDedup(db, {
      groupId: soloPersonal,
      createdBy: solo,
      kind: 'place',
      title: 'Veeray',
      tags: ['indian', 'restaurant'],
    });

    const r = await applyToolCall(db, {
      groupId: soloPersonal,
      call: { name: 'get_list', args: { listName: 'restaurants' } } as never,
      actorUserId: solo,
      provenance: 'test',
      mode: 'commit',
      emit: () => {},
    });
    const data = r.data as { list: unknown; saves: Array<{ title: string }> };
    expect(data.list).toBeNull();
    expect(data.saves.map((s) => s.title)).toContain('Veeray');
    expect(r.summary).toContain('saved item(s) match instead');
  });

  it('still reports nothing when there is genuinely nothing', async () => {
    const r = await applyToolCall(db, {
      groupId: personalId,
      call: { name: 'get_list', args: { listName: 'kayaking' } } as never,
      actorUserId: john,
      provenance: 'test',
      mode: 'commit',
      emit: () => {},
    });
    const data = r.data as { list: unknown; saves: unknown[] };
    expect(data.list).toBeNull();
    expect(data.saves).toHaveLength(0);
  });
});
