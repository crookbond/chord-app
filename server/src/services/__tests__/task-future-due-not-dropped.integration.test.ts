/**
 * A to-do whose due date is still ahead is still owed.
 *
 * Reported: to-dos with a future due date were showing under Dropped. Nothing
 * a person did dropped them - their source email was trashed after reading
 * (ADR 0143), or the stale sweep's live_until rule fired. And once dropped, a
 * to-do stayed dropped even when its due date was moved into the future.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { __testing, drainOnce as drainTick } from '@/services/proactive.service.js';
import {
  createTask,
  isDueInFuture,
  retireTasksByProvenance,
  updateTask,
} from '@/services/tasks.service.js';
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
const THREAD = 'gmail:t_school_trip_form';

describe('a to-do with a future due date', () => {
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

  const rowOf = async (id: string) =>
    db
      .selectFrom('tasks')
      .select(['status', 'archived_at', 'completed_at', 'due_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('survives its source email being trashed', async () => {
    const future = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Return the school trip form',
      dueAt: daysAhead(5),
      sourceRawContext: THREAD,
    });
    const past = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Pay the deposit',
      dueAt: daysAgo(1),
      sourceRawContext: THREAD,
    });
    const undated = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Ask about the bus',
      sourceRawContext: THREAD,
    });

    const retired = await retireTasksByProvenance(db, uid, [THREAD]);

    expect(retired.map((t) => t.id).sort()).toEqual([past.id, undated.id].sort());
    expect((await rowOf(future.id)).status).toBe('open');
    expect((await rowOf(future.id)).archived_at).toBeNull();
  });

  it('still goes with a removed event it was for', async () => {
    // ADR 0192 passes the event's end as a cutoff. A prep to-do due by a
    // deleted event next week was FOR that event, so it is retired with it -
    // the future-date protection is about trashed mail and age, not this.
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Buy a gift for the party',
      dueAt: daysAhead(3),
      sourceRawContext: THREAD,
    });

    await retireTasksByProvenance(db, uid, [THREAD], { dueOnOrBefore: daysAhead(7) });

    expect((await rowOf(task.id)).status).toBe('archived');
  });

  it('is not archived by a lapsed live_until', async () => {
    const future = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Renew the car registration',
      dueAt: daysAhead(10),
      liveUntil: daysAgo(1),
    });
    const noDue = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Bring cups to the picnic',
      liveUntil: daysAgo(1),
    });

    await drainOnce(db);

    expect((await rowOf(future.id)).status).toBe('open');
    expect((await rowOf(noDue.id)).status).toBe('archived');
  });

  it('is read as an instant, not as text, when the offset is ahead of UTC', async () => {
    // 01:00+05:30 tomorrow is still ahead even where its date text is not.
    const soon = new Date(Date.now() + 2 * 60 * 60_000);
    const shifted = new Date(soon.getTime() + 330 * 60_000).toISOString().slice(0, 19) + '+05:30';
    expect(isDueInFuture(shifted)).toBe(true);
    expect(isDueInFuture(daysAgo(1))).toBe(false);
    expect(isDueInFuture(null)).toBe(false);
    expect(isDueInFuture('not a date')).toBe(false);
  });
});

describe('a dropped to-do given a future due date', () => {
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

  const rowOf = async (id: string) =>
    db
      .selectFrom('tasks')
      .select(['status', 'archived_at', 'completed_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  it('comes back as open, and the overdue sweep may act on the new date later', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Send the passport photos',
      dueAt: daysAgo(30),
    });
    await drainOnce(db);
    expect((await rowOf(task.id)).status).toBe('archived');

    const updated = await updateTask(db, task.id, { dueAt: daysAhead(4) });

    expect(updated?.status).toBe('open');
    const row = await rowOf(task.id);
    expect(row.status).toBe('open');
    expect(row.archived_at).toBeNull();

    await drainOnce(db);
    expect((await rowOf(task.id)).status).toBe('open');
  });

  it('stays dropped when the new due date is in the past', async () => {
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'Old errand' });
    await updateTask(db, task.id, { status: 'archived' });

    await updateTask(db, task.id, { dueAt: daysAgo(2) });

    expect((await rowOf(task.id)).status).toBe('archived');
  });

  it('does not reopen a COMPLETED task that was archived', async () => {
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'Book the dentist' });
    await updateTask(db, task.id, { status: 'done' });
    await db.updateTable('tasks').set({ status: 'archived' }).where('id', '=', task.id).execute();

    await updateTask(db, task.id, { dueAt: daysAhead(4) });

    const row = await rowOf(task.id);
    expect(row.status).toBe('archived');
    expect(row.completed_at).not.toBeNull();
  });

  it('respects a status the caller chose in the same edit', async () => {
    const task = await createTask(db, { groupId: gid, createdBy: uid, title: 'Cancel the gym' });
    await updateTask(db, task.id, { status: 'archived' });

    await updateTask(db, task.id, { dueAt: daysAhead(4), status: 'archived' });

    expect((await rowOf(task.id)).status).toBe('archived');
  });

  it('still lets a person drop a future-dated to-do by hand', async () => {
    const task = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Plan the reunion',
      dueAt: daysAhead(20),
    });

    await updateTask(db, task.id, { status: 'archived' });

    expect((await rowOf(task.id)).status).toBe('archived');
  });
});
