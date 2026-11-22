/**
 * ADR 0285 — an archived to-do says why, in the app and in chat. The reason
 * was recorded (migration 119) but never left the server: the To Do's list
 * showed every archived to-do under "Dropped" with nothing to tell the
 * user's own Drop from one Chord retired, and `list_tasks` could not answer
 * "why did that to-do go?".
 */
import { archivedReasonText, retiredByChord } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __testing } from '@/services/proactive.service.js';
import {
  createTask,
  listTasksForUser,
  retireTasksByProvenance,
  updateTask,
} from '@/services/tasks.service.js';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

describe('an archived to-do carries why', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sam');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function archiveFourWays(): Promise<void> {
    await createTask(db, { groupId, createdBy: userId, title: 'Pay the CVS bill', dueAt: at(-10) });
    await __testing.archiveStaleTasks(db);
    await createTask(db, { groupId, createdBy: userId, title: 'Reply to the school', sourceRawContext: 'gmail:thr_school' });
    await retireTasksByProvenance(db, userId, ['gmail:thr_school']);
    await createTask(db, {
      groupId,
      createdBy: userId,
      title: 'Prepare for the water shut-off',
      dueAt: at(1),
      sourceRawContext: 'gmail:thr_water',
    });
    await retireTasksByProvenance(db, userId, ['gmail:thr_water'], { dueOnOrBefore: at(2) });
    const dropped = await createTask(db, { groupId, createdBy: userId, title: 'Renew the passport', dueAt: at(30) });
    await updateTask(db, dropped.id, { status: 'archived' });
  }

  it('the To Do\'s list gets the reason for each', async () => {
    await archiveFourWays();
    const reasons = Object.fromEntries(
      (await listTasksForUser(db, userId)).map((t) => [t.title, t.archivedReason]),
    );
    expect(reasons).toEqual({
      'Pay the CVS bill': 'overdue',
      'Reply to the school': 'email_gone',
      'Prepare for the water shut-off': 'event_gone',
      'Renew the passport': 'dropped',
    });
  });

  it('list_tasks in chat says why, in the same words', async () => {
    await archiveFourWays();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_tasks', args: { status: 'archived' } },
    });
    const rows = (result.data as { tasks: Array<{ title: string; archivedBecause?: string }> }).tasks;
    const because = Object.fromEntries(rows.map((r) => [r.title, r.archivedBecause]));
    expect(because['Reply to the school']).toBe('its email was deleted');
    expect(because['Renew the passport']).toBe('you dropped it');
  });

  it('a live to-do has no reason', async () => {
    await createTask(db, { groupId, createdBy: userId, title: 'Book the dentist', dueAt: at(3) });
    const [t] = await listTasksForUser(db, userId);
    expect(t.archivedReason).toBeUndefined();
  });

  it('only Chord\'s own reasons are reported in the briefing', () => {
    expect(retiredByChord('overdue')).toBe(true);
    expect(retiredByChord('event_gone')).toBe(true);
    expect(retiredByChord('dropped')).toBe(false);
    expect(retiredByChord('completed')).toBe(false);
    expect(retiredByChord(null)).toBe(false);
    expect(archivedReasonText('expired')).toBe('its time ran out');
  });
});
