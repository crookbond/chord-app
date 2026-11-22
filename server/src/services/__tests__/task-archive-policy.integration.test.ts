/**
 * Auto-archive policy for tasks (ADR 0092, spec v4 §6.2).
 *
 * A task that CARRIES a due date retires itself once it is
 * TASK_OVERDUE_ARCHIVE_DAYS past due. A task with NO due date is never
 * auto-archived however old it is — only the user closes undated work.
 * Archiving is recoverable and fires at most once per task.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { __testing, drainOnce as drainTick } from '@/services/proactive.service.js';
import { createTask, updateTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// The archive pass runs at most every 10 minutes per database; these tests
// drive it tick by tick.
const drainOnce = (d: Parameters<typeof drainTick>[0]) => {
  __testing.resetArchiveThrottle(d);
  return drainTick(d);
};

const DAY = 24 * 60 * 60_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString();

describe('archiveStaleTasks', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    gid = g.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const statusOf = async (id: string) =>
    (
      await db
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    ).status;

  it('archives an open task well past TASK_OVERDUE_ARCHIVE_DAYS', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'RSVP to the potluck',
      dueAt: daysAgo(env.TASK_OVERDUE_ARCHIVE_DAYS + 1),
    });

    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('archived');
  });

  it('leaves an open task that is only just overdue', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Pay the water bill',
      dueAt: daysAgo(Math.max(1, env.TASK_OVERDUE_ARCHIVE_DAYS - 4)),
    });

    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('open');
  });

  it('never archives an UNDATED task, however old', async () => {
    // The load-bearing case: "renew passport" typed once and ignored for a
    // year is still work the user means to do. Only a due date licenses us
    // to retire something.
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Renew passport',
    });
    await db
      .updateTable('tasks')
      .set({ created_at: daysAgo(300) })
      .where('id', '=', task.id)
      .execute();

    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('open');
  });

  it('defers while a reminder is still pending', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Book the dentist',
      dueAt: daysAgo(env.TASK_OVERDUE_ARCHIVE_DAYS + 5),
      remindAt: daysAhead(2),
    });

    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('open');
  });

  it('does not re-archive a task the user pulled back out', async () => {
    // Auto-archive fires at most once. Without this guard, reopening a
    // long-overdue task re-archives it on the next tick — the same
    // open<->archived oscillation the completed_at keying below prevents
    // for done tasks.
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Fix the gate',
      dueAt: daysAgo(env.TASK_OVERDUE_ARCHIVE_DAYS + 30),
    });

    await drainOnce(db);
    expect(await statusOf(task.id)).toBe('archived');

    await updateTask(db, task.id, { status: 'open' });
    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('open');
  });

  it('stamps archived_at on a manual drop', async () => {
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'Drop me' });
    await updateTask(db, task.id, { status: 'archived' });

    const row = await db
      .selectFrom('tasks')
      .select(['status', 'archived_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
  });

  it('does NOT re-archive a freshly-done task whose due_at is ancient', async () => {
    // Regression: archiveStaleTasks used to key off due_at, so a task with
    // an old due date got re-archived seconds after the user toggled it
    // done — oscillating done<->archived. Must key off completed_at instead.
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Old TODO',
      dueAt: daysAgo(30),
    });
    await updateTask(db, task.id, { status: 'done' });

    await drainOnce(db);

    const row = await db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('done');
    expect(row.completed_at).not.toBeNull();
  });

  it('clears completed_at when a done task is reopened', async () => {
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'X' });
    await updateTask(db, task.id, { status: 'done' });
    await updateTask(db, task.id, { status: 'open' });

    const row = await db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('open');
    expect(row.completed_at).toBeNull();
  });

  it('clears completed_at when an auto-archived done task is reopened', async () => {
    // A done task auto-archives after ARCHIVE_DONE_MINUTES (status -> 'archived',
    // completed_at kept). Reopening it from that state must still clear
    // completed_at — otherwise the client keeps reading `archived && completedAt`
    // as "finished" and the row renders struck-through after being reopened.
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'Y' });
    await updateTask(db, task.id, { status: 'done' });
    await updateTask(db, task.id, { status: 'archived' });

    let row = await db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('archived');
    expect(row.completed_at).not.toBeNull();

    await updateTask(db, task.id, { status: 'open' });

    row = await db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('open');
    expect(row.completed_at).toBeNull();
  });

  it('still archives an open task whose live_until has elapsed', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Pick up dry cleaning Friday',
      liveUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    await drainOnce(db);

    expect(await statusOf(task.id)).toBe('archived');
  });

  it('runs the pass at most every 10 minutes', async () => {
    const t0 = Date.now();
    await __testing.maybeArchiveStaleTasks(db, t0);
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Pick up dry cleaning',
      liveUntil: new Date(t0 - 60_000).toISOString(),
    });

    expect(await __testing.maybeArchiveStaleTasks(db, t0 + 9 * 60_000)).toBe(0);
    expect(await statusOf(task.id)).toBe('open');

    expect(await __testing.maybeArchiveStaleTasks(db, t0 + 10 * 60_000)).toBe(1);
    expect(await statusOf(task.id)).toBe('archived');
  });
});
