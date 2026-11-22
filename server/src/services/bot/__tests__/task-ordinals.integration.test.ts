/**
 * ADR 0093 — "mark 3-4-5-6 done" must close four tasks, not six.
 *
 * The incident these pin: the bot listed six open tasks, the user asked for
 * four of them by position, and all six were closed. Tool results do not
 * survive a turn, so "3" had no referent and the model re-derived the set from
 * remembered titles. Ordinals are resolved here instead, and a set can only be
 * expressed through them.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { __testing as enumTesting } from '@/services/bot/enumeration.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('complete_task ordinals', () => {
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
        invite_code: 'X0093',
        ingest_email: 'fam-93@chord.app',
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

  /**
   * `listTasks` orders by created_at DESC, so explicit descending timestamps
   * make position 1 the first title — the order the user saw.
   */
  async function seedTasks(titles: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < titles.length; i++) {
      const id = newId('t');
      await db
        .insertInto('tasks')
        .values({
          id,
          group_id: groupId,
          title: titles[i],
          status: 'open',
          created_by: userId,
          created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, titles.length - i)).toISOString(),
        })
        .execute();
      ids.push(id);
    }
    return ids;
  }

  function statusesOf(ids: string[]) {
    return db.selectFrom('tasks').select(['id', 'status']).where('id', 'in', ids).execute();
  }

  const THE_SIX = [
    'Cancel YouTube TV subscription',
    'Papa mom Visa',
    'Contact library for ebook access',
    'Complete Summer Reading',
    'Integrate payments in app',
    'Go see NY Philharmonic',
  ];

  async function listThem() {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_tasks', args: { status: 'open' } },
    });
  }

  it('numbers list_tasks rows from 1 in the order they are returned', async () => {
    await seedTasks(THE_SIX);
    const result = await listThem();
    const rows = (result.data as { tasks: Array<{ n: number; title: string }> }).tasks;
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0].title).toBe(THE_SIX[0]);
    expect(rows[5].title).toBe(THE_SIX[5]);
  });

  it('closes exactly the tasks the user numbered, and leaves the rest open', async () => {
    const ids = await seedTasks(THE_SIX);
    await listThem();

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [3, 4, 5, 6] } },
    });

    expect(result.summary).toMatch(/4 task\(s\) → done/);
    expect(result.cards).toHaveLength(4);
    const byId = new Map((await statusesOf(ids)).map((r) => [r.id, r.status]));
    expect(byId.get(ids[0])).toBe('open');
    expect(byId.get(ids[1])).toBe('open');
    for (const id of ids.slice(2)) expect(byId.get(id)).toBe('done');
  });

  it('writes nothing when there is no enumeration to resolve against', async () => {
    const ids = await seedTasks(THE_SIX);
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [3, 4] } },
    });
    expect((result.data as { reason: string }).reason).toBe('stale_enumeration');
    for (const r of await statusesOf(ids)) expect(r.status).toBe('open');
  });

  it('refuses the whole set when one position is off the end — never a partial write', async () => {
    const ids = await seedTasks(THE_SIX);
    await listThem();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [2, 9] } },
    });
    expect((result.data as { reason: string; unresolved: number[] }).unresolved).toEqual([9]);
    for (const r of await statusesOf(ids)) expect(r.status).toBe('open');
  });

  it('scopes the enumeration to the user who asked', async () => {
    await seedTasks(THE_SIX);
    await listThem();
    const other = newId('u');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: other,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [1] } },
    });
    expect((result.data as { reason: string }).reason).toBe('stale_enumeration');
  });

  it('drops rather than completes when drop is set', async () => {
    const ids = await seedTasks(THE_SIX);
    await listThem();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [1, 2], drop: true } },
    });
    expect(result.summary).toMatch(/→ archived/);
    const byId = new Map((await statusesOf(ids)).map((r) => [r.id, r.status]));
    expect(byId.get(ids[0])).toBe('archived');
    expect(byId.get(ids[1])).toBe('archived');
    expect(byId.get(ids[2])).toBe('open');
  });

  it('reports an already-done position without a second card', async () => {
    const ids = await seedTasks(THE_SIX);
    await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', ids[0]).execute();
    // Unfiltered, so the already-done task is in what the user saw - listed
    // after the open ones (live work first), at whatever position it got.
    const listed = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_tasks', args: {} },
    });
    const rows = (listed.data as { tasks: { n: number; id: string }[] }).tasks;
    const doneAt = rows.find((r) => r.id === ids[0])!.n;
    const openAt = rows.find((r) => r.id !== ids[0])!.n;
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'complete_task', args: { ordinals: [openAt, doneAt] } },
    });
    const data = result.data as { changed: unknown[]; alreadySet: unknown[] };
    expect(data.changed).toHaveLength(1);
    expect(data.alreadySet).toHaveLength(1);
    expect(result.cards).toHaveLength(1);
  });
});

describe('one loose task mutation per turn', () => {
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
        invite_code: 'X0094',
        ingest_email: 'fam-94@chord.app',
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

  async function task(title: string): Promise<string> {
    const id = newId('t');
    await db
      .insertInto('tasks')
      .values({
        id,
        group_id: groupId,
        title,
        status: 'open',
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .execute();
    return id;
  }

  function complete(turnId: string | null, args: Record<string, unknown>) {
    return applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId,
      call: { name: 'complete_task', args },
    });
  }

  it('refuses a second title-resolved completion in the same turn', async () => {
    const a = await task('Call the dentist');
    const b = await task('Book the vet');

    const first = await complete('turn-1', { titleContains: 'dentist' });
    expect(first.summary).toMatch(/→ done/);

    const second = await complete('turn-1', { titleContains: 'vet' });
    expect((second.data as { reason: string }).reason).toBe('batch_requires_ordinals');

    const rows = await db.selectFrom('tasks').select(['id', 'status']).where('id', 'in', [a, b]).execute();
    expect(rows.find((r) => r.id === a)?.status).toBe('done');
    expect(rows.find((r) => r.id === b)?.status).toBe('open');
  });

  it('gives each turn its own allowance', async () => {
    await task('Call the dentist');
    await task('Book the vet');
    expect((await complete('turn-1', { titleContains: 'dentist' })).summary).toMatch(/→ done/);
    expect((await complete('turn-2', { titleContains: 'vet' })).summary).toMatch(/→ done/);
  });

  it('does not cap ordinal-resolved calls — those are server-verified', async () => {
    await task('Call the dentist');
    await task('Book the vet');
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'list_tasks', args: {} },
    });
    expect((await complete('turn-1', { ordinals: [1] })).summary).toMatch(/1 task\(s\) → done/);
    expect((await complete('turn-1', { ordinals: [2] })).summary).toMatch(/1 task\(s\) → done/);
  });

  it('leaves non-conversational callers (no turnId) uncapped', async () => {
    await task('Call the dentist');
    await task('Book the vet');
    expect((await complete(null, { titleContains: 'dentist' })).summary).toMatch(/→ done/);
    expect((await complete(null, { titleContains: 'vet' })).summary).toMatch(/→ done/);
  });
});
