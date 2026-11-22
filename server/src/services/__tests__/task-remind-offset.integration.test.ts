/**
 * A bot-set reminder carries the user's offset ("…T20:20:00-04:00", from
 * `normalizeDatetimes`), and `proactive_messages.scheduled_for` copied it
 * verbatim. The drain compares scheduled_for to a UTC "…Z" now as TEXT, so
 * "20:20-04:00" (00:20Z tomorrow) sorted below "23:20Z" today and fired four
 * hours early in New York - seven in Los Angeles.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { normalizeProactiveScheduledFor } from '@/db/migrate.js';
import { createGroup } from '@/services/groups.service.js';
import { drainOnce, enqueueFromTask } from '@/services/proactive.service.js';
import { createTask } from '@/services/tasks.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pinned-mock',
    defaultModel: 'pinned-mock',
    supportsNativeTools: false,
    complete: async () => 'ok',
    // eslint-disable-next-line require-yield
    async *stream() { return; },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

/** The instant `ms`, written the way the bot writes it: wall time + offset. */
function inOffset(ms: number, offsetHours: number): string {
  const sign = offsetHours < 0 ? '-' : '+';
  const hh = String(Math.abs(offsetHours)).padStart(2, '0');
  return new Date(ms + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, `${sign}${hh}:00`);
}

describe('task reminders in a local offset', () => {
  let db: Kysely<DB>;
  let uid: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    groupId = (await createGroup(db, { name: 'G', kind: 'group', createdBy: uid })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('does not fire a New York reminder due in an hour', async () => {
    const task = await createTask(db, {
      groupId,
      createdBy: uid,
      title: 'Pick up Sam',
      remindAt: inOffset(Date.now() + 60 * 60_000, -4),
    });
    await enqueueFromTask(db, task);
    await drainOnce(db);

    const row = await db
      .selectFrom('proactive_messages')
      .select(['scheduled_for', 'fired_at'])
      .where('kind', '=', 'task_remind')
      .executeTakeFirstOrThrow();
    expect(row.fired_at).toBeNull();
    expect(row.scheduled_for).toMatch(/Z$/);
  });

  it('rewrites a queued offset row to UTC so the drain reads it right', async () => {
    const dueMs = Date.now() + 60 * 60_000;
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: groupId,
        persona_id: null,
        kind: 'task_remind',
        payload: JSON.stringify({ taskId: 't_x', title: 'x', cue: null }),
        scheduled_for: inOffset(dueMs, -4),
        fired_at: null,
        created_at: new Date().toISOString(),
      })
      .execute();

    await normalizeProactiveScheduledFor(db);

    const row = await db
      .selectFrom('proactive_messages')
      .select('scheduled_for')
      .executeTakeFirstOrThrow();
    expect(row.scheduled_for).toBe(new Date(Math.floor(dueMs / 1000) * 1000).toISOString());
  });
});
