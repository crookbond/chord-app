/**
 * Briefing OPEN_TASKS ordering + staleness tagging (ADR 0092).
 *
 * The briefing used to hand the model an unsorted, untagged dump ordered by
 * created_at, then ask it to compare raw ISO strings and surface "anything
 * already overdue" — which is how a months-old backlog got read aloud every
 * morning. Dated work now wins the row budget and carries the same kind of
 * tag events and trips already do.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { retiredTodosSince } from '@/services/briefing/retired-todos.js';
import { createGroup } from '@/services/groups.service.js';
import { __testing, loadScanContext } from '@/services/proactive.service.js';
import { createTask, updateTask } from '@/services/tasks.service.js';

const HOUR = 60 * 60_000;
const hoursAgo = (n: number) => new Date(Date.now() - n * HOUR).toISOString();
const hoursAhead = (n: number) => new Date(Date.now() + n * HOUR).toISOString();

/** The `  - <title> …` lines under the OPEN_TASKS heading. */
function openTaskLines(ctx: string): string[] {
  const start = ctx.split('\n').findIndex((l) => l.startsWith('OPEN_TASKS:'));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of ctx.split('\n').slice(start + 1)) {
    if (!line.startsWith('  - ')) break;
    out.push(line);
  }
  return out;
}

describe('loadScanContext — OPEN_TASKS', () => {
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

  it('tags overdue and stale, leaves future and undated untagged', async () => {
    await createTask(db, { groupId: gid, createdBy: uid, title: 'Long gone', dueAt: hoursAgo(96) });
    await createTask(db, { groupId: gid, createdBy: uid, title: 'Just missed', dueAt: hoursAgo(3) });
    await createTask(db, { groupId: gid, createdBy: uid, title: 'Coming up', dueAt: hoursAhead(48) });
    await createTask(db, { groupId: gid, createdBy: uid, title: 'Someday' });

    const lines = openTaskLines(await loadScanContext(db, uid));
    const find = (t: string) => lines.find((l) => l.includes(t)) ?? '';

    expect(find('Long gone')).toContain('[STALE]');
    expect(find('Just missed')).toContain('[OVERDUE]');
    expect(find('Just missed')).not.toContain('[STALE]');
    expect(find('Coming up')).not.toContain('[');
    expect(find('Someday')).not.toContain('[');
  });

  it('orders dated work above undated regardless of when it was typed', async () => {
    // The bug this pins: ordering by created_at spent the 30-row budget on
    // whatever was typed most recently, so a deadline typed last week lost
    // its place to a someday item typed this morning.
    const dated = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Has a deadline',
      dueAt: hoursAhead(24),
    });
    await db
      .updateTable('tasks')
      .set({ created_at: hoursAgo(500) })
      .where('id', '=', dated.id)
      .execute();
    await createTask(db, { groupId: gid, createdBy: uid, title: 'Typed just now' });

    const lines = openTaskLines(await loadScanContext(db, uid));
    const datedAt = lines.findIndex((l) => l.includes('Has a deadline'));
    const undatedAt = lines.findIndex((l) => l.includes('Typed just now'));

    expect(datedAt).toBeGreaterThanOrEqual(0);
    expect(undatedAt).toBeGreaterThanOrEqual(0);
    expect(datedAt).toBeLessThan(undatedAt);
  });

  // The retired ones are listed by code beside the model's text (ADR 0285);
  // what the scan context must do is drop them from the live list.
  const since = () => new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  it('reports what the sweep retired so the list never shrinks silently', async () => {
    await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Retired yesterday',
      dueAt: hoursAgo(400),
    });
    await __testing.archiveStaleTasks(db);

    expect(await retiredTodosSince(db, uid, since())).toEqual([
      { title: 'Retired yesterday', reason: 'overdue' },
    ]);
    // …and it drops out of the live list at the same time.
    const ctx = await loadScanContext(db, uid);
    expect(openTaskLines(ctx).some((l) => l.includes('Retired yesterday'))).toBe(false);
  });

  it('does not report a retirement the user has since undone', async () => {
    const t = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Pulled back out',
      dueAt: hoursAgo(400),
    });
    await __testing.archiveStaleTasks(db);
    await updateTask(db, t.id, { status: 'open' });

    expect(await retiredTodosSince(db, uid, since())).toEqual([]);
    const ctx = await loadScanContext(db, uid);
    expect(openTaskLines(ctx).some((l) => l.includes('Pulled back out'))).toBe(true);
  });
});
