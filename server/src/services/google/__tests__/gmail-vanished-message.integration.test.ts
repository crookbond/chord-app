/**
 * A message id returned by messages.list or a history messagesAdded record can
 * be gone by the time messages.get runs (deleted, spam-purged, draft
 * discarded). Gmail 404s the fetch; the sync must skip the ghost instead of
 * throwing the whole run into a 500.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import type { GmailApi, GmailRawMessage } from '@/services/google/gmail-api.js';
import { backfillGmail, syncGmailIncremental } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const rawMessage = (id: string, threadId: string): GmailRawMessage => ({
  id,
  threadId,
  labelIds: ['INBOX', 'UNREAD'],
  snippet: 'hello',
  internalDate: '1700000000000',
  historyId: '5',
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'A <a@example.com>' },
      { name: 'To', value: 'you@example.com' },
      { name: 'Subject', value: 'hi' },
      { name: 'Message-ID', value: `<${id}@example.com>` },
    ],
    body: { data: Buffer.from('hello').toString('base64url') },
  },
});

const alive = rawMessage('m_alive', 't_alive');
let history: { history?: unknown[]; historyId?: string } = { history: [], historyId: '5' };

vi.mock('@/services/google/gmail-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/google/gmail-api.js')>();
  const api: GmailApi = {
    async listMessages() {
      return { messages: [
        { id: 'm_alive', threadId: 't_alive' },
        { id: 'm_ghost', threadId: 't_ghost' },
      ] };
    },
    async getProfile() {
      return { historyId: '5' };
    },
    async getMessage(id) {
      return id === 'm_alive' ? alive : null;
    },
    async listHistory() {
      return history as Awaited<ReturnType<GmailApi['listHistory']>>;
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

describe('gmail sync — message vanished between list and fetch', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'ghost-user');
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    await closeTestDb(db);
  });

  const messageIds = async () => {
    const rows = await db
      .selectFrom('email_messages')
      .select('gmail_message_id')
      .where('user_id', '=', userId)
      .execute();
    return rows.map((r) => r.gmail_message_id).sort();
  };

  it('backfill skips the 404ed message and still completes', async () => {
    const result = await backfillGmail(db, userId);
    expect(result.backfillDone).toBe(true);
    expect(await messageIds()).toEqual(['m_alive']);
    const u = await db
      .selectFrom('users')
      .select(['gmail_backfill_done', 'gmail_history_id'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(u.gmail_backfill_done).toBe(1);
    expect(u.gmail_history_id).toBe('5');
  });

  it('incremental sync skips a history-added id that 404s and advances the cursor', async () => {
    await backfillGmail(db, userId);
    history = {
      history: [{ messagesAdded: [{ message: { id: 'm_ghost2', threadId: 't_ghost2' } }] }],
      historyId: '9',
    };
    const result = await syncGmailIncremental(db, userId);
    expect(result.updated).toBe(0);
    expect(await messageIds()).toEqual(['m_alive']);
    const u = await db
      .selectFrom('users')
      .select('gmail_history_id')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(u.gmail_history_id).toBe('9');
  });
});
