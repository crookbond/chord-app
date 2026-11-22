/**
 * ADR 0311 addendum - a ✓ or ✕ on a suggestion made offline waits in the
 * phone's send queue and is sent with the queue's Idempotency-Key. When the
 * first attempt reached the server but its answer was lost, the queue sends
 * it again: the repeat must get the first answer, not "already answered" (409),
 * which the queue would show as a failure for something that worked.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { createProposal, getProposal } from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

describe('a suggestion answered from the offline queue', () => {
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
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now })
      .execute();
    groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  });

  afterEach(async () => {
    await settleBackgroundWork();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const post = (path: string, key: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok, 'idempotency-key': key },
      body: JSON.stringify(body),
    });

  const suggestTask = (title: string) =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title },
      provenance: null,
    });

  it('a confirm sent twice with one key makes one to-do and answers the same both times', async () => {
    const p = await suggestTask('Return library books');
    const first = await post(API.proposalConfirm(p.id), 'q-confirm-1');
    expect(first.status).toBe(200);
    await settleBackgroundWork();
    const again = await post(API.proposalConfirm(p.id), 'q-confirm-1');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    const tasks = await db
      .selectFrom('tasks')
      .select('id')
      .where('group_id', '=', groupId)
      .where('title', '=', 'Return library books')
      .execute();
    expect(tasks).toHaveLength(1);
    expect((await getProposal(db, p.id))?.status).toBe('confirmed');
  });

  it('a dismiss sent twice with one key is answered as done both times', async () => {
    const p = await suggestTask('Sign permission slip');
    expect((await post(API.proposalReject(p.id), 'q-reject-1')).status).toBe(204);
    await settleBackgroundWork();
    expect((await post(API.proposalReject(p.id), 'q-reject-1')).status).toBe(204);
    expect((await getProposal(db, p.id))?.status).toBe('rejected');
  });

  it('a different key still learns the suggestion was already answered', async () => {
    const p = await suggestTask('Book dentist');
    expect((await post(API.proposalConfirm(p.id), 'q-a')).status).toBe(200);
    await settleBackgroundWork();
    expect((await post(API.proposalConfirm(p.id), 'q-b')).status).toBe(409);
  });
});
