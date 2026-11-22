/**
 * A to-do dies with the email it came from (ADR 0143).
 *
 * ADR 0073 retracted a deleted thread's *pending* proposals and deliberately
 * left anything an earlier confirm had created. That is right for a saved
 * place or a calendar event — a record of something that happened — and wrong
 * for a to-do, which is not a record but an outstanding obligation. Deleting
 * the mail is how someone says the obligation is over.
 *
 * The narrowness is the point, so most of these cases are about what must NOT
 * be touched.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { createTask, retireTasksByProvenance, updateTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const THREAD = 'gmail:t_permission_slip';

describe('retireTasksByProvenance', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    gid = g.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const mk = async (over: Partial<Parameters<typeof createTask>[1]> = {}) =>
    createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Return the permission slip',
      sourceRawContext: THREAD,
      ...over,
    });

  const rowOf = async (id: string) =>
    db
      .selectFrom('tasks')
      .select(['status', 'archived_at', 'completed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('retires an open to-do whose source thread was deleted', async () => {
    const task = await mk();

    const retired = await retireTasksByProvenance(db, uid, [THREAD]);

    expect(retired.map((t) => t.id)).toEqual([task.id]);
    const row = await rowOf(task.id);
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
  });

  it('archives rather than completing it', async () => {
    // ADR 0092 made dropping first-class precisely because routing abandonment
    // through `done` corrupts the completion signal. Nobody did this task; the
    // reason to do it went away.
    const task = await mk();

    await retireTasksByProvenance(db, uid, [THREAD]);

    const row = await rowOf(task.id);
    expect(row.status).not.toBe('done');
    expect(row.completed_at).toBeNull();
  });

  it('leaves a task somebody already picked up', async () => {
    const task = await mk();
    await updateTask(db, task.id, { status: 'active' });

    expect(await retireTasksByProvenance(db, uid, [THREAD])).toEqual([]);
    expect((await rowOf(task.id)).status).toBe('active');
  });

  it('leaves a task already finished', async () => {
    const task = await mk();
    await updateTask(db, task.id, { status: 'done' });

    expect(await retireTasksByProvenance(db, uid, [THREAD])).toEqual([]);
    const row = await rowOf(task.id);
    expect(row.status).toBe('done');
    expect(row.completed_at).not.toBeNull();
  });

  it('does not re-stamp a task the ADR 0092 sweep already retired', async () => {
    // A non-null archived_at is that sweep's marker that it has fired once.
    // Re-stamping would restart a clock built to fire exactly once, which is
    // the open/archived oscillation ADR 0092 was written to stop.
    const task = await mk();
    const firstArchivedAt = new Date(Date.now() - 60_000).toISOString();
    await updateTask(db, task.id, { status: 'archived', archivedAt: firstArchivedAt });
    await updateTask(db, task.id, { status: 'open' });

    expect(await retireTasksByProvenance(db, uid, [THREAD])).toEqual([]);
    expect((await rowOf(task.id)).archived_at).toBe(firstArchivedAt);
  });

  it('leaves a task that came from somewhere else', async () => {
    const chat = await mk({ sourceRawContext: null });
    const other = await mk({ sourceRawContext: 'gmail:t_unrelated' });

    expect(await retireTasksByProvenance(db, uid, [THREAD])).toEqual([]);
    expect((await rowOf(chat.id)).status).toBe('open');
    expect((await rowOf(other.id)).status).toBe('open');
  });

  it('will not retire another user’s task', async () => {
    // Thread ids are opaque per mailbox, so a collision is unlikely rather
    // than impossible — and this writes into groups other people can see.
    const bob = await createUser(db, 'bob');
    const task = await createTask(db, {
      groupId: gid,
      createdBy: bob,
      title: 'Return the permission slip',
      sourceRawContext: THREAD,
    });

    expect(await retireTasksByProvenance(db, uid, [THREAD])).toEqual([]);
    expect((await rowOf(task.id)).status).toBe('open');
  });

  it('is a no-op for an empty provenance list', async () => {
    const task = await mk();
    expect(await retireTasksByProvenance(db, uid, [])).toEqual([]);
    expect((await rowOf(task.id)).status).toBe('open');
  });
});
