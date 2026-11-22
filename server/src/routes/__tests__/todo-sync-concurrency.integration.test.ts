/**
 * ADR 0311 addendum - the to-do sync rule when several writers send at the
 * same moment: two people in one family, and one person on two devices. Each
 * writer sends what it saw before anyone changed anything, as two open screens
 * would. Sends go out together (Promise.all), so the assertions hold whichever
 * request the server takes first. The app runs on a handle with a real pool:
 * the default test handle has one connection, so its requests take turns and
 * never overlap. The live-server version of these scenarios
 * is scripts/concurrency (docs/ops/concurrency-tests.md).
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type TodoOp, type TodoSyncResult } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { addItem, getItem } from '@/services/lists.service.js';
import { createGroup, joinGroupByCode } from '@/services/groups.service.js';
import { createTask, getTask } from '@/services/tasks.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeParallelHandle, closeTestDb, createUser, ensureList, openParallelHandle, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

describe('todo sync with writers at the same moment', () => {
  let db: Kysely<DB>;
  let appDb: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let alexId: string;
  let groupId: string;
  let listId: string;
  /** Alex on a phone and a laptop; Sam, a second family member. */
  let phone: string;
  let laptop: string;
  let sam: string;

  const sessionFor = async (userId: string): Promise<string> => {
    const tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
    return tok;
  };

  beforeEach(async () => {
    db = await openTestDb();
    appDb = openParallelHandle(db);
    server = http.createServer(buildApp(appDb));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    alexId = await createUser(db, 'alex');
    const samId = await createUser(db, 'sam');
    groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: alexId })).id;
    const { invite_code } = await db.selectFrom('groups').select('invite_code').where('id', '=', groupId).executeTakeFirstOrThrow();
    await joinGroupByCode(db, samId, invite_code!);
    listId = (await ensureList(db, groupId, 'Groceries', alexId)).id;
    phone = await sessionFor(alexId);
    laptop = await sessionFor(alexId);
    sam = await sessionFor(samId);
  });

  afterEach(async () => {
    await settleBackgroundWork();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeParallelHandle(appDb);
    await closeTestDb(db);
  });

  let keyN = 0;
  const send = async (token: string, op: TodoOp, key = `k-${keyN++}`): Promise<TodoSyncResult | { outcome: number }> => {
    const res = await fetch(`${base}${API.meTodoSync}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: token, 'idempotency-key': key },
      body: JSON.stringify({ op }),
    });
    return res.status === 200 ? ((await res.json()) as TodoSyncResult) : { outcome: res.status };
  };
  const outcomes = (rs: Array<{ outcome: unknown }>) => rs.map((r) => r.outcome).sort();
  const item = async (text: string) => (await addItem(db, listId, text)).item;

  for (const [who, second] of [
    ['two people', () => sam],
    ['one person on two devices', () => laptop],
  ] as const) {
    describe(who, () => {
      it('renaming the same item: one change is kept, the other is asked', async () => {
        const eggs = await item('eggs');
        const rs = await Promise.all([
          send(phone, { type: 'item.update', itemId: eggs.id, set: { text: '12 eggs' }, expected: { text: 'eggs' } }),
          send(second(), { type: 'item.update', itemId: eggs.id, set: { text: 'free-range eggs' }, expected: { text: 'eggs' } }),
        ]);
        expect(outcomes(rs)).toEqual(['applied', 'conflict']);
        const kept = (rs[0].outcome === 'applied' ? '12 eggs' : 'free-range eggs');
        expect((await getItem(db, eggs.id))?.text).toBe(kept);
        const lost = rs.find((r) => r.outcome === 'conflict') as TodoSyncResult;
        expect(lost.conflicts).toEqual([{ field: 'text', mine: expect.any(String), theirs: kept }]);
      });

      it('ticking the same item on both is done once and asks nobody', async () => {
        const milk = await item('milk');
        const tick: TodoOp = { type: 'item.update', itemId: milk.id, set: { checked: true }, expected: { checked: false } };
        expect(outcomes(await Promise.all([send(phone, tick), send(second(), tick)]))).toEqual(['applied', 'applied']);
        expect((await getItem(db, milk.id))?.checked).toBe(true);
      });

      it('a tick and a rename of one item both land', async () => {
        const bread = await item('bread');
        const rs = await Promise.all([
          send(phone, { type: 'item.update', itemId: bread.id, set: { checked: true }, expected: { checked: false } }),
          send(second(), { type: 'item.update', itemId: bread.id, set: { text: 'sourdough' }, expected: { text: 'bread' } }),
        ]);
        expect(outcomes(rs)).toEqual(['applied', 'applied']);
        expect(await getItem(db, bread.id)).toMatchObject({ text: 'sourdough', checked: true });
      });

      it('a rename and a delete of one item: the item never goes with an unseen rename', async () => {
        const apples = await item('apples');
        const rs = await Promise.all([
          send(phone, { type: 'item.update', itemId: apples.id, set: { text: 'green apples' }, expected: { text: 'apples' } }),
          send(second(), { type: 'item.delete', itemId: apples.id, expected: { text: 'apples', checked: false } }),
        ]);
        const stored = await getItem(db, apples.id);
        if (stored) {
          // The rename landed first: the delete must have been asked, not done.
          expect(outcomes(rs)).toEqual(['applied', 'conflict']);
          expect(stored.text).toBe('green apples');
        } else {
          // The delete landed first: the rename finds nothing to change.
          expect(outcomes(rs)).toEqual(['applied', 'gone']);
        }
      });

      it('adding the same item on both makes one item', async () => {
        await Promise.all([
          send(phone, { type: 'item.add', tempId: 'tmp_a', listId, text: 'coffee' }),
          send(second(), { type: 'item.add', tempId: 'tmp_b', listId, text: 'coffee' }),
        ]);
        const rows = await db.selectFrom('list_items').select('id').where('list_id', '=', listId).where('text', '=', 'coffee').execute();
        expect(rows).toHaveLength(1);
      });

      it('a due date and a title on one to-do both land', async () => {
        const t = await createTask(db, { groupId, title: 'Pay bill', createdBy: alexId });
        const rs = await Promise.all([
          send(phone, { type: 'task.update', taskId: t.id, set: { dueAt: '2026-11-12T17:00:00.000Z' }, expected: { dueAt: null } }),
          send(second(), { type: 'task.update', taskId: t.id, set: { title: 'Pay water bill' }, expected: { title: 'Pay bill' } }),
        ]);
        expect(outcomes(rs)).toEqual(['applied', 'applied']);
        expect(await getTask(db, t.id)).toMatchObject({ title: 'Pay water bill', dueAt: '2026-11-12T17:00:00.000Z' });
      });

      it('done on one and dropped on the other: one wins, the other is asked', async () => {
        const t = await createTask(db, { groupId, title: 'Renew permit', createdBy: alexId });
        const rs = await Promise.all([
          send(phone, { type: 'task.update', taskId: t.id, set: { status: 'done' }, expected: { status: 'open' } }),
          send(second(), { type: 'task.update', taskId: t.id, set: { status: 'archived' }, expected: { status: 'open' } }),
        ]);
        expect(outcomes(rs)).toEqual(['applied', 'conflict']);
        expect((await getTask(db, t.id))?.status).toBe(rs[0].outcome === 'applied' ? 'done' : 'archived');
      });

      it('adding the same to-do on both makes two (app creates are not folded, ADR 0095)', async () => {
        await Promise.all([
          send(phone, { type: 'task.create', tempId: 'tmp_a', groupId, title: 'Call plumber' }),
          send(second(), { type: 'task.create', tempId: 'tmp_b', groupId, title: 'Call plumber' }),
        ]);
        const rows = await db.selectFrom('tasks').select('id').where('group_id', '=', groupId).where('title', '=', 'Call plumber').execute();
        expect(rows).toHaveLength(2);
      });
    });
  }

  it('twenty renames of one item at once: exactly one is kept', async () => {
    const eggs = await item('eggs');
    const rs = await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        send([phone, laptop, sam][n % 3], { type: 'item.update', itemId: eggs.id, set: { text: `eggs ${n}` }, expected: { text: 'eggs' } }),
      ),
    );
    const applied = rs.filter((r) => r.outcome === 'applied');
    expect(applied).toHaveLength(1);
    expect(rs.filter((r) => r.outcome === 'conflict')).toHaveLength(19);
    expect((await getItem(db, eggs.id))?.text).toMatch(/^eggs \d+$/);
  });

  it('the same item added by everyone at once is one item, by sync or by the app route', async () => {
    // Found by scripts/concurrency: two adds of "coffee" 0 ms apart made two
    // items, since addItem looked for a match and then inserted, unlocked.
    const adds = await Promise.all([
      ...Array.from({ length: 12 }, (_, n) =>
        send([phone, laptop, sam][n % 3], { type: 'item.add', tempId: `tmp_${n}`, listId, text: n % 2 ? 'Coffee' : 'coffee ' }),
      ),
      ...Array.from({ length: 6 }, (_, n) =>
        fetch(`${base}${API.listItems(listId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SESSION_HEADER]: [phone, laptop, sam][n % 3] },
          body: JSON.stringify({ text: 'coffee' }),
        }).then((r) => ({ outcome: r.status })),
      ),
    ]);
    expect(adds.every((r) => r.outcome === 'applied' || (typeof r.outcome === 'number' && r.outcome < 300))).toBe(true);
    const rows = await db.selectFrom('list_items').select('id').where('list_id', '=', listId).execute();
    expect(rows).toHaveLength(1);
  });

  it('one queued create sent ten times at once with one key makes one to-do', async () => {
    const op: TodoOp = { type: 'task.create', tempId: 'tmp_race', groupId, title: 'Race create' };
    const rs = await Promise.all(Array.from({ length: 10 }, () => send(phone, op, 'race-key')));
    // The first does the work; a repeat that arrives while it runs is told to
    // retry (503), one that arrives after gets the first answer back.
    expect(rs.filter((r) => r.outcome === 'applied').length).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => r.outcome === 'applied' || r.outcome === 503)).toBe(true);
    await settleBackgroundWork();
    const rows = await db.selectFrom('tasks').select('id').where('title', '=', 'Race create').execute();
    expect(rows).toHaveLength(1);
  });
});
