/**
 * ADR 0285 — the briefing names the to-dos Chord took off the list and says
 * why. Before, the full briefing gave the model a count it was asked to
 * mention, the short one said "2 past-due retired to Archived" while one of
 * the two was retired because its email went away, and neither said which.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { renderRetiredSection, retiredTodosSince } from '@/services/briefing/retired-todos.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { __testing } from '@/services/proactive.service.js';
import { createTask, retireTasksByProvenance, updateTask } from '@/services/tasks.service.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '' } };
});

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const yesterday = () => new Date(Date.now() - DAY).toISOString();

describe('the to-dos Chord retired, by name', () => {
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

  const task = (title: string, dueAt: string | null, sourceRawContext?: string) =>
    createTask(db, { groupId, createdBy: userId, title, dueAt: dueAt ?? undefined, sourceRawContext });

  it('names each with why, and leaves out what the user did themselves', async () => {
    await task('Pay the CVS bill', at(-10));
    await __testing.archiveStaleTasks(db);

    await task('Reply to the school', null, 'gmail:thr_school');
    await retireTasksByProvenance(db, userId, ['gmail:thr_school']);

    await task('Prepare for the water shut-off', at(1), 'gmail:thr_water');
    await retireTasksByProvenance(db, userId, ['gmail:thr_water'], { dueOnOrBefore: at(2) });

    const dropped = await task('Renew the passport', at(30));
    await updateTask(db, dropped.id, { status: 'archived' });

    const finished = await task('Book the dentist', at(-1));
    await updateTask(db, finished.id, { status: 'done' });
    // Finished long enough ago for the sweep to file it.
    await db.updateTable('tasks').set({ completed_at: at(-2) }).where('id', '=', finished.id).execute();
    await __testing.archiveStaleTasks(db);

    const section = renderRetiredSection(await retiredTodosSince(db, userId, yesterday())) ?? '';
    expect(section).toContain('Pay the CVS bill — more than a week past its date');
    expect(section).toContain('Reply to the school — its email was deleted');
    expect(section).toContain('Prepare for the water shut-off — its calendar event was removed');
    expect(section).not.toContain('Renew the passport');
    expect(section).not.toContain('Book the dentist');
  });

  it('a dropped to-do brought back by a new date has no reason left', async () => {
    const t = await task('Renew the passport', at(30));
    await updateTask(db, t.id, { status: 'archived' });
    await updateTask(db, t.id, { dueAt: at(40) });
    const row = await db.selectFrom('tasks').select(['status', 'archived_reason']).where('id', '=', t.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'open', archived_reason: null });
  });

  it('an older row with no reason counts only if the overdue rule fits', async () => {
    const old = await task('Old overdue one', at(-10));
    const gone = await task('Old one whose email went', at(3));
    await db
      .updateTable('tasks')
      .set({ status: 'archived', archived_at: new Date().toISOString(), archived_reason: null })
      .where('id', 'in', [old.id, gone.id])
      .execute();
    const items = await retiredTodosSince(db, userId, yesterday());
    expect(items).toEqual([{ title: 'Old overdue one', reason: 'overdue' }]);
  });

  it('a to-do in two groups is one line', async () => {
    const family = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
    await task('Pay the CVS bill', at(-10));
    await createTask(db, { groupId: family, createdBy: userId, title: 'Pay the CVS bill', dueAt: at(-10) });
    await __testing.archiveStaleTasks(db);
    expect(await retiredTodosSince(db, userId, yesterday())).toHaveLength(1);
  });

  it('shows eight and counts the rest', () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ title: `To-do ${i + 1}`, reason: 'overdue' as const }));
    const lines = renderRetiredSection(items)!.split('\n');
    expect(lines).toHaveLength(1 + 8 + 1);
    expect(lines.at(-1)).toBe('• …and 3 more');
  });
});
