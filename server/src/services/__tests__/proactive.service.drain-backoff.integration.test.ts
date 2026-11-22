/**
 * A briefing whose render fails is held back (1 min, doubling) instead of
 * re-asking the model every tick, and a due reminder is not stuck behind a
 * queue of failing briefings.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { drainOnce, enqueueFromTask, proactiveRetryDelayMs } from '@/services/proactive.service.js';
import { createTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

const calls = vi.hoisted(() => ({ complete: 0 }));

// The briefing model answers with nothing: the "render returned null — retry"
// path, the one that used to re-run on every 15-second tick.
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pinned-mock',
    defaultModel: 'pinned-mock',
    supportsNativeTools: false,
    complete: async () => {
      calls.complete++;
      return '';
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      return;
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

async function addBriefing(db: Kysely<DB>, groupId: string, userId: string, scheduledFor: string) {
  const id = newId('pm');
  await db
    .insertInto('proactive_messages')
    .values({
      id,
      group_id: groupId,
      persona_id: userId,
      kind: 'daily_morning_scan',
      payload: JSON.stringify({ userId, scanDate: scheduledFor.slice(0, 10) }),
      scheduled_for: scheduledFor,
      fired_at: null,
      created_at: scheduledFor,
    })
    .execute();
  return id;
}

describe('proactive drain retry backoff', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    calls.complete = 0;
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('does not re-render a failed briefing on the very next tick', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: uid });
    const id = await addBriefing(db, g.id, uid, new Date(Date.now() - 60_000).toISOString());

    await drainOnce(db);
    expect(calls.complete).toBe(1);
    await drainOnce(db);
    expect(calls.complete).toBe(1);

    const row = await db
      .selectFrom('proactive_messages')
      .select(['attempts', 'retry_after', 'fired_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.fired_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(Date.parse(row.retry_after!)).toBeGreaterThan(Date.now());
  });

  it('drains a due reminder before a queue of failing briefings', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: uid });
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    // 20 briefings, all scheduled before the reminder (a batch holds 20).
    for (let i = 0; i < 20; i++) {
      await addBriefing(db, personal.id, uid, new Date(Date.now() - (25 - i) * 60_000).toISOString());
    }
    const task = await createTask(db, {
      groupId: g.id,
      createdBy: uid,
      title: 'Pick up Sam',
      remindAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await enqueueFromTask(db, task);

    await drainOnce(db);

    const reminder = await db
      .selectFrom('proactive_messages')
      .select('fired_at')
      .where('kind', '=', 'task_remind')
      .executeTakeFirstOrThrow();
    expect(reminder.fired_at).not.toBeNull();
  });

  it('doubles the wait up to 30 minutes', () => {
    expect(proactiveRetryDelayMs(0)).toBe(60_000);
    expect(proactiveRetryDelayMs(1)).toBe(120_000);
    expect(proactiveRetryDelayMs(10)).toBe(30 * 60_000);
  });
});
