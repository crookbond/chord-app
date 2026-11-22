/**
 * Prod, 2026-10: a mailbox whose history id had expired (token dead for two
 * months) re-backfilled every pass, ran into Gmail's per-minute quota partway
 * through, threw, and started again at page 1 next time - 48 times in three
 * days, never finishing. A backfill stopped by the quota must keep what it
 * fetched and resume, and must not re-fetch mail already mirrored.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import type { GmailApi, GmailRawMessage } from '@/services/google/gmail-api.js';
import {
  backfillGmail,
  gmailBackfillProgress,
  syncGmailIncremental,
} from '@/services/google/gmail.service.js';
import {
  __resetSyncBackoffForTests,
  backoffRemainingMs,
  gmailKey,
} from '@/services/email/sync-backoff.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const QUOTA =
  "gmail GET /messages/m_p2b 403: Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'";

const raw = (id: string, labels: string[]): GmailRawMessage => ({
  id,
  threadId: `t_${id}`,
  labelIds: labels,
  snippet: id,
  internalDate: String(Date.now() - 60_000),
  historyId: '50',
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'A <a@example.com>' },
      { name: 'To', value: 'you@example.com' },
      { name: 'Subject', value: id },
      { name: 'Message-ID', value: `<${id}@example.com>` },
    ],
    body: { data: Buffer.from(id).toString('base64url') },
  },
});

/** The fake mailbox: ids in list order, three to a page. */
let mailbox: GmailRawMessage[] = [];
let historyExpired = false;
let quotaOn: string | null = null;
const fetched: string[] = [];
const listedTokens: (string | undefined)[] = [];

vi.mock('@/services/google/gmail-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/google/gmail-api.js')>();
  const api: GmailApi = {
    async listMessages({ q, pageToken }) {
      const plain = !/is:unread|in:inbox/.test(q ?? '');
      if (plain) listedTokens.push(pageToken);
      const matching = mailbox.filter(
        (m) =>
          (!/is:unread/.test(q ?? '') || m.labelIds?.includes('UNREAD')) &&
          (!/in:inbox/.test(q ?? '') || m.labelIds?.includes('INBOX')),
      );
      const start = pageToken ? Number(pageToken.slice(1)) : 0;
      const slice = matching.slice(start, start + 3);
      const next = start + 3 < matching.length ? `p${start + 3}` : undefined;
      return { messages: slice.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next };
    },
    async getProfile() {
      return { historyId: '900' };
    },
    async getMessage(id) {
      fetched.push(id);
      if (id === quotaOn) throw new Error(QUOTA);
      return mailbox.find((m) => m.id === id) ?? null;
    },
    async listHistory() {
      return historyExpired ? { notFound: true } : { history: [], historyId: '900' };
    },
    async sendMessage() {
      throw new Error('unused');
    },
    async getAttachment() {
      throw new Error('unused');
    },
    async modifyThread() {},
    async modifyMessages() {},
    async trashThread() {},
    async listLabels() {
      return [];
    },
    async watch() {
      return { historyId: '1', expiration: String(Date.now() + 1000) };
    },
    async stopWatch() {},
    async createLabel() {
      throw new Error('unused');
    },
    async listSendAs() {
      return [];
    },
  };
  return { ...actual, getGmailApi: async () => api };
});

const concurrency = env.GMAIL_FETCH_CONCURRENCY;

describe('gmail backfill after an expired history id', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'mock';
    // One fetch at a time, so the quota error lands at a known message.
    (env as { GMAIL_FETCH_CONCURRENCY: number }).GMAIL_FETCH_CONCURRENCY = 1;
    __resetSyncBackoffForTests();
    db = await openTestDb();
    userId = await createUser(db, 'ben-like');
    mailbox = [raw('m_old', ['INBOX', 'UNREAD']), raw('m_stale', ['INBOX'])];
    historyExpired = false;
    quotaOn = null;
    fetched.length = 0;
    listedTokens.length = 0;
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    (env as { GMAIL_FETCH_CONCURRENCY: number }).GMAIL_FETCH_CONCURRENCY = concurrency;
    await closeTestDb(db);
  });

  const stored = async () =>
    (
      await db
        .selectFrom('email_messages')
        .select(['gmail_message_id', 'is_unread'])
        .where('user_id', '=', userId)
        .orderBy('gmail_message_id')
        .execute()
    ).map((r) => `${r.gmail_message_id}${r.is_unread ? '*' : ''}`);

  const userRow = () =>
    db
      .selectFrom('users')
      .select(['gmail_history_id', 'gmail_synced_at', 'gmail_backfill_done'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  it('stops at the quota, keeps what it fetched, and resumes without re-fetching', async () => {
    // The mailbox as it was when the token died.
    await backfillGmail(db, userId);
    const before = await userRow();
    expect(before.gmail_backfill_done).toBe(1);
    expect(await stored()).toEqual(['m_old*', 'm_stale']);

    // Two months later: m_old was read in Gmail, m_stale deleted, mail arrived.
    historyExpired = true;
    mailbox = [
      raw('m_old', ['INBOX']),
      raw('m_p1a', ['INBOX', 'UNREAD']),
      raw('m_p1b', ['INBOX']),
      raw('m_p2a', ['INBOX']),
      raw('m_p2b', ['INBOX']),
      raw('m_p2c', ['INBOX']),
      raw('m_p3a', ['INBOX']),
    ];
    quotaOn = 'm_p2b';
    fetched.length = 0;

    // Pass 1: returns cleanly instead of throwing.
    const first = await syncGmailIncremental(db, userId);
    expect(first.backfillDone).toBe(false);
    expect('pausedBy' in first).toBe(false);
    expect(fetched).not.toContain('m_old');
    expect(await stored()).toEqual(['m_old*', 'm_p1a*', 'm_p1b', 'm_p2a', 'm_stale']);
    const paused = await userRow();
    // The current historyId is stored before any page, so a cut-off backfill
    // still lets incremental sync resume from it.
    expect(paused.gmail_history_id).toBe('900');
    expect(paused.gmail_synced_at).toBe(before.gmail_synced_at);
    expect(await gmailBackfillProgress.get(db, userId)).toMatchObject({ pageToken: 'p3', phase: 'fetch' });
    expect(backoffRemainingMs(gmailKey(userId))).toBeGreaterThan(0);

    // Pass 2: picks up at page 2, fetches only what is still missing.
    quotaOn = null;
    fetched.length = 0;
    listedTokens.length = 0;
    const second = await syncGmailIncremental(db, userId);
    expect(second.backfillDone).toBe(true);
    expect(listedTokens[0]).toBe('p3');
    expect(fetched.sort()).toEqual(['m_p2b', 'm_p2c', 'm_p3a']);
    // m_stale was deleted during the gap; m_old was read in Gmail.
    expect(await stored()).toEqual(['m_old', 'm_p1a*', 'm_p1b', 'm_p2a', 'm_p2b', 'm_p2c', 'm_p3a']);
    const done = await userRow();
    expect(done.gmail_history_id).toBe('900');
    expect(done.gmail_synced_at).not.toBe(before.gmail_synced_at);
    expect(await gmailBackfillProgress.get(db, userId)).toBeNull();
    expect(backoffRemainingMs(gmailKey(userId))).toBe(0);
  });

  it('a pass cut off by the quota never reverse-deletes', async () => {
    await backfillGmail(db, userId);
    historyExpired = true;
    mailbox = [raw('m_old', ['INBOX']), raw('m_new', ['INBOX'])];
    quotaOn = 'm_new';
    await syncGmailIncremental(db, userId);
    // m_stale is absent from Gmail, but the snapshot was not complete.
    expect(await stored()).toEqual(['m_old*', 'm_stale']);
  });
});
