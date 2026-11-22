/**
 * Bulk triage (ADR 0128). The contract worth testing is the honest one: a
 * batch that half-worked must not read as a success, and one bad id must not
 * fail the rest.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type EmailBulkModifyResult } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let tok: string;
let userId: string;

async function mintToken(uid: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

/**
 * A thread with a message in it. The message is not decoration: label writes
 * run through `recomputeThread`, which DELETES a thread that has none - so a
 * message-less fixture disappears mid-test and every assertion over it passes
 * vacuously.
 */
async function thread(owner = userId): Promise<string> {
  const now = new Date().toISOString();
  const id = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: owner,
      gmail_thread_id: gid,
      subject: 'hi',
      from_email: 'someone@example.com',
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      is_unread: 1,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: owner,
      thread_id: id,
      gmail_message_id: newId('gm'),
      gmail_thread_id: gid,
      subject: 'hi',
      snippet: 'hi',
      from_email: 'someone@example.com',
      to_emails: JSON.stringify([]),
      cc_emails: JSON.stringify([]),
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      is_unread: 1,
      ics_text: '',
      internal_date: now,
      created_at: now,
    })
    .execute();
  return id;
}

async function bulk(body: unknown): Promise<{ status: number; json: EmailBulkModifyResult }> {
  const res = await fetch(`${base}${API.meEmailThreadsModify}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as EmailBulkModifyResult };
}

beforeEach(async () => {
  __resetGmailMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userId = await createUser(db, 'triage-user');
  tok = await mintToken(userId);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('bulk modify', () => {
  it('marks several threads read in one request', async () => {
    const ids = [await thread(), await thread()];

    const { json } = await bulk({ ids, markRead: true });

    expect(json.updated.sort()).toEqual([...ids].sort());
    expect(json.failed).toEqual([]);
    const rows = await db
      .selectFrom('email_threads')
      .select('is_unread')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_unread === 0)).toBe(true);
  });

  it('archives several threads', async () => {
    const ids = [await thread(), await thread()];

    await bulk({ ids, archive: true });

    const rows = await db
      .selectFrom('email_threads')
      .select('is_archived')
      .where('user_id', '=', userId)
      .execute();
    // Length asserted first: an empty result would satisfy `every` and the
    // test would pass having proved nothing.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_archived === 1)).toBe(true);
  });

  // ADR 0215 — a swipe set to Trash sends `trash: true` through this route.
  it('trashes threads: gone from inbox and archive, pending suggestion retracted', async () => {
    const ids = [await thread(), await thread()];
    const gid = (
      await db.selectFrom('email_threads').select('gmail_thread_id').where('id', '=', ids[0]).executeTakeFirstOrThrow()
    ).gmail_thread_id;
    const { createProposal } = await import('@/services/proposals.service.js');
    const { ensurePersonalGroup } = await import('@/services/groups.service.js');
    const personal = await ensurePersonalGroup(db, userId);
    const prop = await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'Shopping', items: ['milk'] },
      provenance: `gmail:${gid}`,
      targetGroupId: null,
    });

    const { json } = await bulk({ ids, trash: true });

    expect(json.updated.sort()).toEqual([...ids].sort());
    const rows = await db
      .selectFrom('email_threads')
      .select(['is_archived', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.is_archived === 1 && r.gmail_label_ids.includes('TRASH'))).toBe(true);
    const { listThreads } = await import('@/services/google/gmail.service.js');
    expect(await listThreads(db, userId, { mode: 'traditional', limit: 50 })).toHaveLength(0);
    expect(
      await listThreads(db, userId, { mode: 'traditional', folder: 'archive', limit: 50 }),
    ).toHaveLength(0);
    const status = await db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', prop.id)
      .executeTakeFirstOrThrow();
    expect(status.status).toBe('expired');
  });

  it('has no un-trash: `trash: false` is refused', async () => {
    expect((await bulk({ ids: [await thread()], trash: false })).status).toBe(400);
  });

  it('reports what did not change instead of swallowing it', async () => {
    // The honest half: a batch that half-worked must not read as a success.
    const good = await thread();

    const { json } = await bulk({ ids: [good, 'et_nope'], markRead: true });

    expect(json.updated).toEqual([good]);
    expect(json.failed).toEqual(['et_nope']);
  });

  it('never touches another user’s thread, and says it failed', async () => {
    const stranger = await createUser(db, 'stranger');
    const theirs = await thread(stranger);

    const { json } = await bulk({ ids: [theirs], archive: true });

    expect(json.failed).toEqual([theirs]);
    const row = await db
      .selectFrom('email_threads')
      .select('is_archived')
      .where('id', '=', theirs)
      .executeTakeFirst();
    expect(row?.is_archived).toBe(0);
  });

  it('refuses a request that asks for nothing', async () => {
    const { status } = await bulk({ ids: [await thread()] });

    expect(status).toBe(400);
  });

  it('applies Chord labels without a provider modify', async () => {
    // ADR 0141 — local column only; the mock is unused for this patch.
    const ids = [await thread(), await thread()];

    const { json } = await bulk({ ids, addChordLabels: ['Family'] });

    expect(json.updated.sort()).toEqual([...ids].sort());
    expect(json.failed).toEqual([]);
    const rows = await db
      .selectFrom('email_threads')
      .select('chord_label_ids')
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => JSON.stringify(r.chord_label_ids) === JSON.stringify(['Family']))).toBe(
      true,
    );
  });

  it('stores the swipe preference, archive by default', async () => {
    const settings = async () => {
      const res = await fetch(`${base}${API.meSettings}`, { headers: { [SESSION_HEADER]: tok } });
      return ((await res.json()) as { emailSwipeAction: string }).emailSwipeAction;
    };
    const put = (body: unknown) =>
      fetch(`${base}${API.meEmailPrefs}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
        body: JSON.stringify(body),
      });

    expect(await settings()).toBe('archive');
    expect((await put({ emailSwipeAction: 'trash' })).status).toBe(200);
    expect(await settings()).toBe('trash');
    expect((await put({ emailSwipeAction: 'delete' })).status).toBe(400);
    expect(await settings()).toBe('trash');
  });

  it('refuses an empty or oversized set', async () => {
    expect((await bulk({ ids: [], markRead: true })).status).toBe(400);
    expect(
      (await bulk({ ids: Array.from({ length: 101 }, (_, i) => `et_${i}`), markRead: true })).status,
    ).toBe(400);
  });
});
