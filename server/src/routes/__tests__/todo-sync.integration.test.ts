/**
 * ADR 0311 addendum - POST /me/todo-sync replays a to-do or list change made
 * offline. A field is written only if it still holds what the phone saw; a
 * field someone else changed meanwhile comes back as a conflict. A queued send
 * repeated with the same Idempotency-Key is done once.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type Task, type TodoSyncRequest, type TodoSyncResult } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { addItem, getItem } from '@/services/lists.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createTask, getTask, updateTask } from '@/services/tasks.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, ensureList, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

describe('todo sync', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'priya');
    tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
    groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  });

  afterEach(async () => {
    await settleBackgroundWork();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const post = (path: string, body: unknown, key?: string, token = tok) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SESSION_HEADER]: token,
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    });

  const sync = async (body: TodoSyncRequest, key?: string): Promise<TodoSyncResult> => {
    const res = await post(API.meTodoSync, body, key);
    expect(res.status).toBe(200);
    return (await res.json()) as TodoSyncResult;
  };

  const newTask = (title = 'Pay water bill', dueAt?: string): Promise<Task> =>
    createTask(db, { groupId, title, createdBy: userId, ...(dueAt ? { dueAt } : {}) });

  it('writes a field nobody else changed', async () => {
    const t = await newTask();
    const r = await sync({ op: { type: 'task.update', taskId: t.id, set: { status: 'done' }, expected: { status: 'open' } } });
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, t.id))?.status).toBe('done');
  });

  it('keeps a field someone else changed and still writes the rest', async () => {
    const t = await newTask('Pay water bill', '2026-11-06T17:00:00.000Z');
    // Offline the phone moved it to Monday and renamed it; meanwhile a family
    // member moved it to Wednesday.
    await updateTask(db, t.id, { dueAt: '2026-11-11T17:00:00.000Z' });
    const r = await sync({
      op: {
        type: 'task.update',
        taskId: t.id,
        set: { dueAt: '2026-11-09T17:00:00.000Z', title: 'Pay water + sewer bill' },
        expected: { dueAt: '2026-11-06T17:00:00.000Z', title: 'Pay water bill' },
      },
    });
    expect(r.outcome).toBe('partial');
    expect(r.conflicts).toEqual([
      { field: 'dueAt', mine: '2026-11-09T17:00:00.000Z', theirs: '2026-11-11T17:00:00.000Z' },
    ]);
    const now = await getTask(db, t.id);
    expect(now?.title).toBe('Pay water + sewer bill');
    expect(Date.parse(now!.dueAt!)).toBe(Date.parse('2026-11-11T17:00:00.000Z'));
  });

  it('reads the same instant in another offset as unchanged', async () => {
    const t = await newTask('Dentist', '2026-11-06T17:00:00.000Z');
    const r = await sync({
      op: {
        type: 'task.update',
        taskId: t.id,
        set: { dueAt: '2026-11-07T17:00:00.000Z' },
        expected: { dueAt: '2026-11-06T12:00:00-05:00' },
      },
    });
    expect(r.outcome).toBe('applied');
  });

  it('counts a field already holding the new value as done', async () => {
    const t = await newTask();
    await updateTask(db, t.id, { status: 'done' });
    const r = await sync({ op: { type: 'task.update', taskId: t.id, set: { status: 'done' }, expected: { status: 'open' } } });
    expect(r).toMatchObject({ outcome: 'applied', conflicts: [] });
  });

  it('"Keep mine" writes over the other change', async () => {
    const t = await newTask();
    await updateTask(db, t.id, { title: 'Pay the water bill today' });
    const r = await sync({
      op: { type: 'task.update', taskId: t.id, set: { title: 'Water bill' }, expected: { title: 'Pay water bill' } },
      force: true,
    });
    expect(r.outcome).toBe('applied');
    expect((await getTask(db, t.id))?.title).toBe('Water bill');
  });

  it('asks before deleting a to-do someone else changed, and deletes on "Keep mine"', async () => {
    const t = await newTask();
    await updateTask(db, t.id, { title: 'Pay water bill - due Friday' });
    const op = { type: 'task.delete' as const, taskId: t.id, expected: { title: 'Pay water bill', status: 'open' as const } };
    const r = await sync({ op });
    expect(r.outcome).toBe('conflict');
    expect(r.conflicts[0]).toMatchObject({ field: 'deleted' });
    expect(await getTask(db, t.id)).not.toBeNull();
    expect((await sync({ op, force: true })).outcome).toBe('applied');
    expect(await getTask(db, t.id)).toBeNull();
  });

  it('a change to a deleted to-do is gone; deleting it again is done', async () => {
    const t = await newTask();
    await db.deleteFrom('tasks').where('id', '=', t.id).execute();
    expect((await sync({ op: { type: 'task.update', taskId: t.id, set: { status: 'done' }, expected: {} } })).outcome).toBe('gone');
    expect((await sync({ op: { type: 'task.delete', taskId: t.id, expected: {} } })).outcome).toBe('applied');
  });

  it('never changes a to-do in a group the user is not in', async () => {
    const other = await createUser(db, 'stranger');
    const theirGroup = (await createGroup(db, { name: 'Theirs', kind: 'group', createdBy: other })).id;
    const t = await createTask(db, { groupId: theirGroup, title: 'Private', createdBy: other });
    expect((await sync({ op: { type: 'task.update', taskId: t.id, set: { title: 'x' }, expected: {} } })).outcome).toBe('gone');
    expect((await sync({ op: { type: 'task.delete', taskId: t.id, expected: {} } })).outcome).toBe('applied');
    expect((await getTask(db, t.id))?.title).toBe('Private');
  });

  it('ticking an item never conflicts; an edited item text does', async () => {
    const list = await ensureList(db, groupId, 'Costco', userId);
    const { item } = await addItem(db, list.id, 'milk');
    await db.updateTable('list_items').set({ checked: 1 }).where('id', '=', item.id).execute();
    const tick = await sync({ op: { type: 'item.update', itemId: item.id, set: { checked: true }, expected: { checked: false } } });
    expect(tick).toMatchObject({ outcome: 'applied', conflicts: [] });
    const untick = await sync({ op: { type: 'item.update', itemId: item.id, set: { checked: false }, expected: { checked: true } } });
    expect(untick.outcome).toBe('applied');
    expect((await getItem(db, item.id))?.checked).toBe(false);

    await db.updateTable('list_items').set({ text: 'oat milk' }).where('id', '=', item.id).execute();
    const edit = await sync({ op: { type: 'item.update', itemId: item.id, set: { text: '2% milk' }, expected: { text: 'milk' } } });
    expect(edit.outcome).toBe('conflict');
    expect(edit.conflicts).toEqual([{ field: 'text', mine: '2% milk', theirs: 'oat milk' }]);
    const del = await sync({ op: { type: 'item.delete', itemId: item.id, expected: { text: 'milk', checked: false } } });
    expect(del.outcome).toBe('conflict');
  });

  it('a create sent twice with one key makes one to-do', async () => {
    const op = { op: { type: 'task.create' as const, tempId: 'tmp_1', groupId, title: 'Book flights' } };
    const first = await sync(op, 'q-abc');
    await settleBackgroundWork();
    const again = await sync(op, 'q-abc');
    expect(again.id).toBe(first.id);
    const rows = await db.selectFrom('tasks').select('id').where('title', '=', 'Book flights').execute();
    expect(rows).toHaveLength(1);
  });

  it('a chat message sent twice with one key posts once', async () => {
    const path = API.groupMessages(groupId);
    const first = await post(path, { body: 'running late, start without me' }, 'q-chat-1');
    expect(first.status).toBeLessThan(300);
    await settleBackgroundWork();
    const again = await post(path, { body: 'running late, start without me' }, 'q-chat-1');
    expect(again.status).toBe(first.status);
    expect(((await again.json()) as { id: string }).id).toBe(((await first.json()) as { id: string }).id);
    const rows = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', groupId)
      .where('body', '=', 'running late, start without me')
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('one user\'s key never answers another user', async () => {
    const op = { op: { type: 'task.create' as const, tempId: 'tmp_1', groupId, title: 'Mine' } };
    await sync(op, 'same-key');
    await settleBackgroundWork();
    const other = await createUser(db, 'sam');
    const otherTok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(otherTok), user_id: other, created_at: now, last_seen_at: now }).execute();
    const res = await post(API.meTodoSync, op, 'same-key', otherTok);
    expect(((await res.json()) as TodoSyncResult).outcome).toBe('gone');
  });
});
