/**
 * The reader marks an email read message by message, as each one is seen:
 * reopening a thread and scrolling through it marks every message, and a
 * message that is never scrolled to stays unread.
 *
 * Prod 2026-11-10: a reply arrived in thread emt_ZfkbOtRTAbZN while it was
 * open, and nothing marked it read, because the reader marked the whole
 * thread once and remembered that it had.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { EmailModifyRequest } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  applyAccountThreadModify,
  connectOutlookAccount,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __failOutlookMockSetRead,
  __outlookMockIsRead,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import {
  __addGmailMockMessage,
  __failGmailMockModify,
  __gmailMockLabels,
  __resetGmailMock,
  type GmailRawMessage,
} from '@/services/google/gmail-api.js';
import { applyThreadModify, backfillGmail } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  __resetGmailMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'msg-read');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

const SUBJECT = 'Re: Media.example catch-up';

function gmailMessage(id: string, minutesAgo: number): GmailRawMessage {
  return {
    id,
    threadId: 't_karl',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: `message ${id}`,
    internalDate: String(Date.now() - minutesAgo * 60_000),
    historyId: '9',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Karl Dale <karl@media.example>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: SUBJECT },
        { name: 'Date', value: new Date(Date.now() - minutesAgo * 60_000).toUTCString() },
        { name: 'Message-ID', value: `<${id}@media.example>` },
      ],
      body: { data: Buffer.from(`body ${id}`, 'utf8').toString('base64url') },
    },
  };
}

async function messages(threadId: string) {
  return db
    .selectFrom('email_messages')
    .select(['id', 'gmail_message_id', 'is_unread'])
    .where('thread_id', '=', threadId)
    .orderBy('internal_date')
    .execute();
}

const threadUnread = async (threadId: string) =>
  (await db.selectFrom('email_threads').select('is_unread').where('id', '=', threadId).executeTakeFirstOrThrow())
    .is_unread;

async function gmailThread() {
  __addGmailMockMessage(userId, gmailMessage('m1', 30));
  __addGmailMockMessage(userId, gmailMessage('m2', 20));
  __addGmailMockMessage(userId, gmailMessage('m3', 10));
  await backfillGmail(db, userId);
  return db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('subject', '=', SUBJECT)
    .executeTakeFirstOrThrow();
}

it('Gmail: marks only the messages that were seen, and the thread once all are', async () => {
  const thread = await gmailThread();
  const [m1, m2, m3] = await messages(thread.id);

  await applyThreadModify(db, userId, thread.id, { markRead: true, messageIds: [m1.id, m2.id] });

  expect((await messages(thread.id)).map((m) => m.is_unread)).toEqual([0, 0, 1]);
  expect(__gmailMockLabels(userId, 'm1')).not.toContain('UNREAD');
  expect(__gmailMockLabels(userId, 'm3')).toContain('UNREAD');
  expect(await threadUnread(thread.id)).toBe(1);

  // Scrolled down to the last one.
  const summary = await applyThreadModify(db, userId, thread.id, { markRead: true, messageIds: [m3.id] });
  expect(summary?.isUnread).toBe(false);
  expect(__gmailMockLabels(userId, 'm3')).not.toContain('UNREAD');
});

it('Gmail: a message id from another thread is ignored', async () => {
  const thread = await gmailThread();
  await applyThreadModify(db, userId, thread.id, { markRead: true, messageIds: ['em_elsewhere'] });
  expect((await messages(thread.id)).map((m) => m.is_unread)).toEqual([1, 1, 1]);
});

it('Gmail: a refused per-message write fails for the caller to retry, and owes no thread-wide write', async () => {
  const thread = await gmailThread();
  const [m1] = await messages(thread.id);
  __failGmailMockModify(userId, 1);

  await expect(
    applyThreadModify(db, userId, thread.id, { markRead: true, messageIds: [m1.id] }),
  ).rejects.toThrow();
  // Queuing "read" for the thread would mark m2 and m3, which nobody saw.
  expect(await db.selectFrom('email_read_writes').selectAll().execute()).toEqual([]);
  expect((await messages(thread.id)).map((m) => m.is_unread)).toEqual([1, 1, 1]);
});

async function outlookThread() {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  for (const [id, minutesAgo] of [
    ['ol-1', 30],
    ['ol-2', 10],
  ] as const) {
    __addOutlookMockMessage(account.id, {
      id,
      conversationId: 'conv-karl',
      subject: SUBJECT,
      bodyPreview: `message ${id}`,
      receivedDateTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      from: { emailAddress: { address: 'karl@media.example', name: 'Karl Dale' } },
      toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
      internetMessageId: `<${id}@media.example>`,
      isRead: false,
    });
  }
  await syncAccount(db, account);
  const thread = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('subject', '=', SUBJECT)
    .executeTakeFirstOrThrow();
  return { account, thread };
}

it('Outlook: marks only the message that was seen', async () => {
  const { account, thread } = await outlookThread();
  const [first] = await messages(thread.id);

  await applyAccountThreadModify(db, userId, account.id, thread.id, { markRead: true, messageIds: [first.id] });

  expect(__outlookMockIsRead(account.id, 'ol-1')).toBe(true);
  expect(__outlookMockIsRead(account.id, 'ol-2')).toBe(false);
  expect((await messages(thread.id)).map((m) => m.is_unread)).toEqual([0, 1]);
  expect(await threadUnread(thread.id)).toBe(1);
});

it('Outlook: a refused per-message write throws and owes no thread-wide write', async () => {
  const { account, thread } = await outlookThread();
  const [first] = await messages(thread.id);
  __failOutlookMockSetRead(account.id, 1);

  await expect(
    applyAccountThreadModify(db, userId, account.id, thread.id, { markRead: true, messageIds: [first.id] }),
  ).rejects.toThrow();
  expect(await db.selectFrom('email_read_writes').selectAll().execute()).toEqual([]);
  expect((await messages(thread.id)).map((m) => m.is_unread)).toEqual([1, 1]);
});

it('messageIds goes only with markRead: true', () => {
  expect(EmailModifyRequest.safeParse({ markRead: true, messageIds: ['em_1'] }).success).toBe(true);
  expect(EmailModifyRequest.safeParse({ markRead: false, messageIds: ['em_1'] }).success).toBe(false);
  expect(EmailModifyRequest.safeParse({ markRead: true, archive: true, messageIds: ['em_1'] }).success).toBe(false);
  expect(EmailModifyRequest.safeParse({ markRead: true, messageIds: [] }).success).toBe(false);
});
