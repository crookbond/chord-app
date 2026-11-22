/**
 * The ⓘ on a to-do mined from mail opens that email in Chord: its
 * `gmail:<threadId>` provenance resolves to the viewer's own thread row -
 * still after the email went to Trash, never to someone else's mailbox.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type EmailThreadDetail, type EmailThreadSummary } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { __settleAfterSyncForTests } from '@/services/google/gmail.service.js';
import { __resetLlmCacheForTests } from '@/services/llm/factory.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

describe('GET /me/email/source-thread', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tok = await mintToken(db, await createUser(db, 'mail-user'));
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    __resetLlmCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const get = (path: string, token = tok) =>
    fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: token } });
  const post = (path: string, body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
      body: JSON.stringify(body),
    });
  const lookup = (provenance: string, token = tok) =>
    get(`${API.meEmailSourceThread}?provenance=${encodeURIComponent(provenance)}`, token);

  async function firstThread(): Promise<{ id: string; gmailId: string }> {
    await post(API.meEmailSync);
    await __settleAfterSyncForTests();
    const threads = (await (await get(API.meEmailThreads)).json()) as EmailThreadSummary[];
    const id = threads[0]!.id;
    const row = await db
      .selectFrom('email_threads')
      .select('gmail_thread_id')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return { id, gmailId: row.gmail_thread_id };
  }

  it('resolves a to-do\'s gmail provenance to the thread, and that thread opens', async () => {
    const { id, gmailId } = await firstThread();
    const res = await lookup(`gmail:${gmailId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId: id });
    expect((await get(API.meEmailThread(id))).status).toBe(200);
  });

  it('still resolves and opens after the email was moved to Trash', async () => {
    const { id, gmailId } = await firstThread();
    expect((await post(API.meEmailThreadModify(id), { trash: true })).status).toBe(200);

    const res = await lookup(`gmail:${gmailId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ threadId: id });
    const opened = await get(API.meEmailThread(id));
    expect(opened.status).toBe(200);
    const detail = (await opened.json()) as EmailThreadDetail;
    expect(detail.thread.id).toBe(id);
    expect(detail.messages.length).toBeGreaterThan(0);
  });

  it('404s once the email is no longer mirrored', async () => {
    const { id, gmailId } = await firstThread();
    await db.deleteFrom('email_messages').where('thread_id', '=', id).execute();
    await db.deleteFrom('email_threads').where('id', '=', id).execute();
    expect((await lookup(`gmail:${gmailId}`)).status).toBe(404);
  });

  it("never resolves another user's thread", async () => {
    const { gmailId } = await firstThread();
    const other = await mintToken(db, await createUser(db, 'someone-else'));
    expect((await lookup(`gmail:${gmailId}`, other)).status).toBe(404);
  });

  it('404s a provenance that is not an email', async () => {
    expect((await lookup('chat:m_123')).status).toBe(404);
    expect((await lookup('')).status).toBe(404);
  });
});
