/**
 * Bug 2: reminders firing on already-completed tasks.
 *
 * Verifies two safeguards:
 *   1. updateTask cancels pending task_remind rows when the task moves to
 *      a terminal status, or when remindAt is cleared/replaced.
 *   2. drainOnce / fireOne skip the nudge if the task has been completed
 *      or deleted between queueing and firing, and marks the row fired so
 *      it doesn't re-poll.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { drainOnce, enqueueFromTask } from '@/services/proactive.service.js';
import { createTask, deleteTask, updateTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

// Force a deterministic LLM so the daily_morning_scan render path always
// produces a non-empty body. The real factory uses the mock provider in tests
// but its output isn't guaranteed for this prompt; pin it.
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pinned-mock',
    defaultModel: 'pinned-mock',
    supportsNativeTools: false,
    complete: async () => 'Morning! 1 thing to flag today.',
    // eslint-disable-next-line require-yield
    async *stream() { return; },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

async function countPending(db: Kysely<DB>, taskId: string): Promise<number> {
  const rows = await db
    .selectFrom('proactive_messages')
    .select('id')
    .where('kind', '=', 'task_remind')
    .where('fired_at', 'is', null)
    .where('payload', 'like', `%"taskId":"${taskId}"%`)
    .execute();
  return rows.length;
}

describe('task_remind cancellation', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('cancels the pending nudge when the task is marked done', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Pick up Sam',
      remindAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);
    expect(await countPending(db, task.id)).toBe(1);

    await updateTask(db, task.id, { status: 'done' });
    expect(await countPending(db, task.id)).toBe(0);
  });

  it('cancels the pending nudge when the task is deleted', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Call dentist',
      remindAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    await deleteTask(db, task.id);
    expect(await countPending(db, task.id)).toBe(0);
  });

  it('cancels the previous nudge when remindAt is rescheduled', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Walk the dog',
      remindAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);
    expect(await countPending(db, task.id)).toBe(1);

    await updateTask(db, task.id, {
      remindAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    });
    expect(await countPending(db, task.id)).toBe(0);
  });

  it('drainOnce skips and retires a task_remind that is hours past stale-cutoff', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Pick up Sam',
      // 24h in the past — well past the 6h task_remind staleness cutoff.
      remindAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    const before = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', g.id)
      .where('kind', '=', 'bot')
      .execute();

    await drainOnce(db);

    const after = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', g.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(after.length).toBe(before.length); // didn't fire

    const row = await db
      .selectFrom('proactive_messages')
      .select(['fired_at'])
      .where('kind', '=', 'task_remind')
      .where('payload', 'like', `%"taskId":"${task.id}"%`)
      .executeTakeFirstOrThrow();
    expect(row.fired_at).not.toBeNull(); // marked fired so it won't requeue
  });

  it('drainOnce still fires a task_remind that is only slightly past due', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Call back the school',
      // 10 minutes ago — comfortably inside the 6h cutoff.
      remindAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    await drainOnce(db);

    const botMsgs = await db
      .selectFrom('messages')
      .select(['body'])
      .where('group_id', '=', g.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(botMsgs.some((m) => m.body.includes('Call back the school'))).toBe(true);
  });

  it('daily_morning_scan fires even when yesterday\'s briefing fired <24h ago', async () => {
    // Reproduces the rate-limiter bug: with PROACTIVE_RATE_MINUTES=1440, a row
    // whose fired_at is just inside the 24h window used to suppress today's
    // scheduled briefing. daily_morning_scan should bypass the cross-kind rate
    // limit (one-per-day is already enforced by scanDate dedup).
    const uid = await createUser(db, 'alice');
    const personalGroup = await createGroup(db, {
      name: 'Personal',
      kind: 'personal',
      createdBy: uid,
    });

    const now = new Date();
    // Yesterday's row, fired 23h 59m ago — squarely inside the 24h window.
    const yesterdayFiredAt = new Date(now.getTime() - (24 * 60 - 1) * 60_000).toISOString();
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: personalGroup.id,
        persona_id: uid,
        kind: 'daily_morning_scan',
        payload: JSON.stringify({ userId: uid, scanDate: '2999-01-01' }),
        scheduled_for: yesterdayFiredAt,
        fired_at: yesterdayFiredAt,
        created_at: yesterdayFiredAt,
      })
      .execute();

    // Today's row, scheduled 5 minutes ago — overdue, should fire.
    const scheduledFor = new Date(now.getTime() - 5 * 60_000).toISOString();
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: personalGroup.id,
        persona_id: uid,
        kind: 'daily_morning_scan',
        payload: JSON.stringify({ userId: uid, scanDate: '2999-01-02' }),
        scheduled_for: scheduledFor,
        fired_at: null,
        created_at: scheduledFor,
      })
      .execute();

    await drainOnce(db);

    const todayRow = await db
      .selectFrom('proactive_messages')
      .select(['fired_at'])
      .where('kind', '=', 'daily_morning_scan')
      .where('payload', 'like', '%"scanDate":"2999-01-02"%')
      .executeTakeFirstOrThrow();
    expect(todayRow.fired_at).not.toBeNull();

    const briefingMsgs = await db
      .selectFrom('messages')
      .select('body')
      .where('group_id', '=', personalGroup.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(briefingMsgs.length).toBeGreaterThan(0);
  });

  it('a task_remind fires even when the morning briefing fired two hours earlier', async () => {
    // Prod 2026-10-13: "Text Nick" was queued for 09:00 -04:00. The 07:00
    // briefing had fired in the same personal chat, so the 24h per-person
    // limit held the reminder back on every tick until the 6h staleness
    // cutoff retired it unsent.
    const uid = await createUser(db, 'alice');
    const personalGroup = await createGroup(db, {
      name: 'Personal',
      kind: 'personal',
      createdBy: uid,
    });

    const briefingFiredAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: personalGroup.id,
        persona_id: uid,
        kind: 'daily_morning_scan',
        payload: JSON.stringify({ userId: uid, scanDate: '2999-01-01' }),
        scheduled_for: briefingFiredAt,
        fired_at: briefingFiredAt,
        created_at: briefingFiredAt,
      })
      .execute();

    const task = await createTask(db, {
      groupId: personalGroup.id,
      createdBy: uid,
      assigneeId: uid,
      title: 'Text Nick',
      remindAt: new Date(Date.now() - 15_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    await drainOnce(db);

    const botMsgs = await db
      .selectFrom('messages')
      .select(['body'])
      .where('group_id', '=', personalGroup.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(botMsgs.some((m) => m.body.includes('Text Nick'))).toBe(true);
    expect(await countPending(db, task.id)).toBe(0);
  });

  it('two task_reminds for the same person on the same day both fire', async () => {
    const uid = await createUser(db, 'alice');
    const personalGroup = await createGroup(db, {
      name: 'Personal',
      kind: 'personal',
      createdBy: uid,
    });
    for (const title of ['Text Nick', 'Call the plumber']) {
      const task = await createTask(db, {
        groupId: personalGroup.id,
        createdBy: uid,
        assigneeId: uid,
        title,
        remindAt: new Date(Date.now() - 15_000).toISOString(),
      });
      await enqueueFromTask(db, task);
    }

    await drainOnce(db);
    await drainOnce(db);

    const bodies = (
      await db
        .selectFrom('messages')
        .select(['body'])
        .where('group_id', '=', personalGroup.id)
        .where('kind', '=', 'bot')
        .execute()
    ).map((m) => m.body);
    expect(bodies.some((b) => b.includes('Text Nick'))).toBe(true);
    expect(bodies.some((b) => b.includes('Call the plumber'))).toBe(true);
  });

  it('drainOnce skips and retires a nudge whose task has been completed', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    // Queue a reminder for a past time so drainOnce picks it up immediately.
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Buy milk',
      remindAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    // Mark the task done directly via the DB to bypass updateTask's cancel
    // path — simulates the case where the row was queued but the task was
    // completed before drainOnce ran (e.g. the server was offline).
    await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', task.id).execute();

    const before = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', g.id)
      .where('kind', '=', 'bot')
      .execute();

    await drainOnce(db);

    const after = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', g.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(after.length).toBe(before.length); // no reminder posted

    // The row should be marked fired so we don't retry every tick.
    const row = await db
      .selectFrom('proactive_messages')
      .select(['fired_at'])
      .where('kind', '=', 'task_remind')
      .where('payload', 'like', `%"taskId":"${task.id}"%`)
      .executeTakeFirstOrThrow();
    expect(row.fired_at).not.toBeNull();
  });
});
