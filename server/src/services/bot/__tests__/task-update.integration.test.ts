/**
 * `update_task` — change an existing task without going through `create_task`
 * (ADR 0149 sanctioned this tool; ADR 0095 noted its absence forced reschedules
 * to masquerade as `create_task`).
 *
 * Pins the rules it shares with `complete_task` (ADR 0093): a SET only through
 * `ordinals`, all-or-nothing resolution, one id/title-resolved mutation per
 * turn — and its own: omitted fields are left as-is, `null` clears a date,
 * status is not touchable here, and reassigning honours the trust gate.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { __testing as enumTesting } from '@/services/bot/enumeration.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('update_task', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    enumTesting.reset();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: userId, username: 'ro', display_name: 'Ro', created_at: now, shadow: 0 })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Fam',
        kind: 'group',
        invite_code: 'X0148',
        ingest_email: 'fam-148@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedTasks(
    rows: Array<{ title: string; details?: string; dueAt?: string; remindAt?: string }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const id = newId('t');
      await db
        .insertInto('tasks')
        .values({
          id,
          group_id: groupId,
          title: rows[i].title,
          details: rows[i].details ?? null,
          status: 'open',
          due_at: rows[i].dueAt ?? null,
          remind_at: rows[i].remindAt ?? null,
          created_by: userId,
          // Descending seconds → position 1 is the first row (listTasks is DESC).
          created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, rows.length - i)).toISOString(),
        })
        .execute();
      ids.push(id);
    }
    return ids;
  }

  function rowsOf(ids: string[]) {
    return db
      .selectFrom('tasks')
      .select(['id', 'title', 'details', 'status', 'due_at', 'remind_at'])
      .where('id', 'in', ids)
      .execute();
  }

  async function listAll() {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_tasks', args: {} },
    });
  }

  const FUTURE = '2027-03-14T18:00:00.000Z';
  const LATER = '2027-04-01T09:00:00.000Z';

  it('reschedules one task by title, leaving its other fields untouched', async () => {
    const [id] = await seedTasks([{ title: 'Book the dentist', details: 'call before noon' }]);
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'dentist', dueAt: FUTURE } },
    });
    expect((res.data as { updated: boolean }).updated).toBe(true);
    const [row] = await rowsOf([id]);
    expect(row.due_at).toBe(FUTURE);
    expect(row.title).toBe('Book the dentist');
    expect(row.details).toBe('call before noon');
    expect(row.status).toBe('open');
  });

  it('clears a due date with an explicit null', async () => {
    const [id] = await seedTasks([{ title: 'Renew passport', dueAt: FUTURE }]);
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'passport', dueAt: null } },
    });
    const [row] = await rowsOf([id]);
    expect(row.due_at).toBeNull();
  });

  it('renames without disturbing the schedule', async () => {
    const [id] = await seedTasks([{ title: 'call plumber', dueAt: FUTURE }]);
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'plumber', title: 'Call the plumber about the leak' } },
    });
    const [row] = await rowsOf([id]);
    expect(row.title).toBe('Call the plumber about the leak');
    expect(row.due_at).toBe(FUTURE);
  });

  it('writes nothing when no field is supplied', async () => {
    const [id] = await seedTasks([{ title: 'Book the dentist', dueAt: FUTURE }]);
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'dentist' } },
    });
    expect((res.data as { reason: string }).reason).toBe('no_fields');
    const [row] = await rowsOf([id]);
    expect(row.due_at).toBe(FUTURE);
  });

  it('refuses an imminent reminder time and changes nothing', async () => {
    const [id] = await seedTasks([{ title: 'Book the dentist' }]);
    const soon = new Date(Date.now() + 60_000).toISOString();
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'dentist', remindAt: soon } },
    });
    expect((res.data as { reason: string }).reason).toBe('bad_remind_time');
    const [row] = await rowsOf([id]);
    expect(row.remind_at).toBeNull();
  });

  it('asks which when a title matches more than one open task', async () => {
    const ids = await seedTasks([{ title: 'Book the dentist' }, { title: 'Book the dentist follow-up' }]);
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'dentist', dueAt: FUTURE } },
    });
    expect((res.data as { candidates: unknown[] }).candidates).toHaveLength(2);
    for (const row of await rowsOf(ids)) expect(row.due_at).toBeNull();
  });

  it('moves a numbered set to a new date, leaving the rest alone', async () => {
    const ids = await seedTasks([
      { title: 'Task A' },
      { title: 'Task B' },
      { title: 'Task C' },
      { title: 'Task D' },
    ]);
    await listAll();
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { ordinals: [2, 4], dueAt: LATER } },
    });
    expect(res.summary).toMatch(/2 task\(s\) updated/);
    const byId = new Map((await rowsOf(ids)).map((r) => [r.id, r.due_at]));
    expect(byId.get(ids[0])).toBeNull();
    expect(byId.get(ids[1])).toBe(LATER);
    expect(byId.get(ids[2])).toBeNull();
    expect(byId.get(ids[3])).toBe(LATER);
  });

  it('refuses the whole set when a position is off the end — never a partial write', async () => {
    const ids = await seedTasks([{ title: 'Task A' }, { title: 'Task B' }]);
    await listAll();
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { ordinals: [1, 9], dueAt: LATER } },
    });
    expect((res.data as { reason: string; unresolved: number[] }).unresolved).toEqual([9]);
    for (const row of await rowsOf(ids)) expect(row.due_at).toBeNull();
  });

  it('will not reassign a set — reassigning is one task at a time', async () => {
    const ids = await seedTasks([{ title: 'Task A' }, { title: 'Task B' }]);
    await listAll();
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { ordinals: [1, 2], assigneeName: 'Ro' } },
    });
    expect((res.data as { reason: string }).reason).toBe('reassign_needs_single');
    for (const row of await rowsOf(ids)) expect(row.status).toBe('open');
  });

  it('shares the one-loose-mutation budget with complete_task', async () => {
    const [a, b] = await seedTasks([{ title: 'Call the dentist' }, { title: 'Book the vet' }]);
    const first = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'dentist', dueAt: FUTURE } },
    });
    expect((first.data as { updated: boolean }).updated).toBe(true);
    const second = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { titleContains: 'vet' } },
    });
    expect((second.data as { reason: string }).reason).toBe('batch_requires_ordinals');
    const rows = await rowsOf([a, b]);
    expect(rows.find((r) => r.id === b)?.status).toBe('open');
  });

  it('does not reassign to an untrusted member — opens a permission request instead', async () => {
    const priya = newId('u');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({ id: priya, username: 'priya', display_name: 'Priya', created_at: now, shadow: 0 })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: priya, role: 'member', tier: 'verified', joined_at: now })
      .execute();
    const [id] = await seedTasks([{ title: 'Buy groceries' }]);

    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'update_task', args: { titleContains: 'groceries', assigneeName: 'Priya' } },
    });
    expect((res.data as { reason: string; permissionRequestId?: string }).reason).toBe('assignee_untrusted');
    expect((res.data as { permissionRequestId?: string }).permissionRequestId).toBeTruthy();
    const [row] = await rowsOf([id]);
    expect(row.status).toBe('open');
    const assigned = await db
      .selectFrom('tasks')
      .select('assignee_id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(assigned?.assignee_id ?? null).toBeNull();
  });

  // Regression: complete_task/update_task used to resolve BOTH taskId and
  // titleContains by scanning listTasks(ForUser) — a 200-row page ordered
  // `created_at DESC` (newest first). ADR 0092 deliberately never
  // auto-archives an undated open task ("renew passport" survives forever),
  // so an old-but-still-open task behind 200+ newer tasks (of any status)
  // silently failed to resolve — by title AND by a known id. getTaskInScope/
  // findTasksByTitle (tasks.service.ts) query directly instead.
  it('resolves an old task behind 200+ newer ones, by title and by id', async () => {
    const [oldId] = await seedTasks([{ title: 'Renew passport' }]);
    // 210 fresh tasks, all created after the old one (seedTasks itself
    // spaces rows a second apart, oldest-created-first in the array — insert
    // these directly with a later created_at so they clearly postdate it).
    const filler = Array.from({ length: 210 }, (_, i) => ({
      id: newId('t'),
      group_id: groupId,
      title: `Buy item ${i}`,
      status: 'open' as const,
      created_by: userId,
      created_at: new Date(Date.UTC(2026, 5, 1, 12, 0, i)).toISOString(),
    }));
    await db.insertInto('tasks').values(filler).execute();

    const byTitle = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-title',
      call: { name: 'update_task', args: { titleContains: 'passport', details: 'apply for renewal' } },
    });
    expect((byTitle.data as { updated: boolean }).updated).toBe(true);

    const byId = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-id',
      call: { name: 'complete_task', args: { taskId: oldId } },
    });
    expect(byId.summary).not.toMatch(/no matching task/);
    const [row] = await rowsOf([oldId]);
    expect(row.details).toBe('apply for renewal');
    expect(row.status).toBe('done');
  });
});
