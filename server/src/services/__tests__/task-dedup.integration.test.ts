/**
 * ADR 0095 — a restated to-do folds into the one that already exists.
 *
 * `create_task` had no dedup whatsoever, so every restatement minted a row and
 * the daily briefing read them all back, prompting more restatement. These pin
 * the two halves of the fix that can go wrong in opposite directions: folding
 * something that is genuinely new (losing a task), and failing to fold a
 * reschedule (the multiplication we are fixing).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  createTaskWithDedup,
  listTasks,
  updateTask,
} from '@/services/tasks.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let groupId: string;

const add = (title: string, extra: Record<string, unknown> = {}) =>
  createTaskWithDedup(db, { groupId, createdBy: john, title, ...extra });

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john');
  groupId = (await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: john })).id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('createTaskWithDedup', () => {
  it('folds a restatement instead of minting a second row', async () => {
    const first = await add('Book dentist');
    expect(first.created).toBe(true);

    for (const spoken of ['Book dentist', 'book dentist', '  BOOK   DENTIST ']) {
      const again = await add(spoken);
      expect(again.created).toBe(false);
      expect(again.updated).toEqual([]);
      expect(again.task.id).toBe(first.task.id);
    }
    expect(await listTasks(db, groupId)).toHaveLength(1);
  });

  it('treats a reschedule as an update, not a duplicate or a new task', async () => {
    const first = await add('Book dentist', { dueAt: '2026-09-01T17:00:00Z' });
    const moved = await add('book dentist', { dueAt: '2026-09-04T17:00:00Z' });

    expect(moved.created).toBe(false);
    expect(moved.updated).toEqual(['dueAt']);
    expect(moved.task.id).toBe(first.task.id);
    expect(moved.task.dueAt).toBe('2026-09-04T17:00:00Z');
    expect(await listTasks(db, groupId)).toHaveLength(1);
  });

  it('does not call the same time written with another offset a reschedule', async () => {
    // The stored time keeps its own offset (ADR 0074); a restatement may come
    // back stamped differently for the same moment. Comparing the text made
    // that a "moved" to-do the bot then reported.
    const first = await add('Book dentist', {
      dueAt: '2026-09-01T13:00:00-04:00',
      remindAt: '2026-09-01T12:00:00-04:00',
    });
    const again = await add('book dentist', {
      dueAt: '2026-09-01T17:00:00Z',
      remindAt: '2026-09-01T16:00:00.000Z',
    });

    expect(again.created).toBe(false);
    expect(again.updated).toEqual([]);
    expect(again.task.id).toBe(first.task.id);
    expect(again.task.dueAt).toBe('2026-09-01T13:00:00-04:00');
  });

  it('fills in a field the existing task lacked', async () => {
    await add('Renew passport');
    const withDate = await add('renew passport', { dueAt: '2026-10-01T12:00:00Z' });
    expect(withDate.updated).toEqual(['dueAt']);
  });

  it('never clears a field the caller omitted', async () => {
    await add('Book dentist', { dueAt: '2026-09-01T17:00:00Z', details: 'the one on Main St' });
    const bare = await add('Book dentist');
    expect(bare.task.dueAt).toBe('2026-09-01T17:00:00Z');
    expect(bare.task.details).toBe('the one on Main St');
  });

  it('does not fold onto a task that is already done', async () => {
    const first = await add('Book dentist');
    await updateTask(db, first.task.id, { status: 'done' });

    const again = await add('Book dentist');
    expect(again.created).toBe(true);
    expect(again.task.id).not.toBe(first.task.id);
  });

  it('does not fold onto an archived task', async () => {
    const first = await add('Book dentist');
    await db
      .updateTable('tasks')
      .set({ status: 'archived', archived_at: new Date().toISOString() })
      .where('id', '=', first.task.id)
      .execute();

    expect((await add('Book dentist')).created).toBe(true);
  });

  it('keeps same-titled tasks for different people apart', async () => {
    const alice = await createUser(db, 'alice');
    await addMember(db, groupId, alice);
    // Trust: assigning to someone else needs their grant, so self-assign both
    // sides of the comparison and vary only the assignee that is set.
    const mine = await add('Call the vet');
    const theirs = await createTaskWithDedup(db, {
      groupId,
      createdBy: alice,
      title: 'Call the vet',
      assigneeId: alice,
    });
    expect(theirs.created).toBe(true);
    expect(theirs.task.id).not.toBe(mine.task.id);
  });

  it('does not fold across groups', async () => {
    const other = (
      await createGroup(db, { name: 'Other', kind: 'group', createdBy: john })
    ).id;
    await add('Book dentist');
    const elsewhere = await createTaskWithDedup(db, {
      groupId: other,
      createdBy: john,
      title: 'Book dentist',
    });
    expect(elsewhere.created).toBe(true);
  });
});
