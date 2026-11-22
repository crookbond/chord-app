/**
 * docs/notes/0199 — a read/unread change is delivered, not dropped.
 *
 * Prod (Sep 2026): every "outlook modify failed" was `graph setRead 404
 * ErrorItemNotFound` on archived mail ("Re: BOOKING CONFIRMATION - Kilima
 * Safari") — Outlook re-issues a message's Graph id when it moves folders, so
 * the stored id was stale and every retry of it failed forever, while Chord
 * showed the thread read and the next sync flipped it back.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

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
  __changeOutlookMockMessage,
  __failOutlookMockSetRead,
  __outlookMockIsRead,
  __resetOutlookMock,
  __reissueOutlookMockId,
} from '@/services/email-accounts/outlook-api.js';
import { READ_RETRY_MAX_ATTEMPTS, flushReadWrites } from '@/services/email/read-writes.js';
import {
  __failGmailMockModify,
  __gmailMockLabels,
  __resetGmailMock,
} from '@/services/google/gmail-api.js';
import { applyThreadModify, backfillGmail, recomputeThread } from '@/services/google/gmail.service.js';
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
  userId = await createUser(db, 'read-writes');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

const SUBJECT = 'Re: BOOKING CONFIRMATION - Kilima Safari';

async function outlookThread(id: string) {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  __addOutlookMockMessage(account.id, {
    id,
    conversationId: `conv-${id}`,
    subject: SUBJECT,
    bodyPreview: 'Your safari is confirmed.',
    receivedDateTime: new Date(Date.now() - 3600_000).toISOString(),
    from: { emailAddress: { address: 'reservations@kilima.example', name: 'Kilima Safari' } },
    toRecipients: [{ emailAddress: { address: 'ownertest@hotmail.com' } }],
    internetMessageId: `<${id}@kilima.example>`,
    isRead: false,
  });
  await syncAccount(db, account);
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'is_unread'])
    .where('user_id', '=', userId)
    .where('subject', '=', SUBJECT)
    .executeTakeFirstOrThrow();
  return { account, thread };
}

const owed = () => db.selectFrom('email_read_writes').selectAll().execute();
const threadUnread = async (threadId: string) =>
  (await db.selectFrom('email_threads').select('is_unread').where('id', '=', threadId).executeTakeFirstOrThrow())
    .is_unread;
const later = (ms: number) => new Date(Date.now() + ms);

it('Outlook: a message moved in Outlook (new Graph id) is still marked read, and its id is refreshed', async () => {
  const { account, thread } = await outlookThread('AAJA5XPKAAAAA');
  __reissueOutlookMockId(account.id, 'AAJA5XPKAAAAA', 'AAJA5XPK-MOVED');

  await applyAccountThreadModify(db, userId, account.id, thread.id, { markRead: true });

  expect(__outlookMockIsRead(account.id, 'AAJA5XPK-MOVED')).toBe(true);
  expect(await threadUnread(thread.id)).toBe(0);
  const row = await db
    .selectFrom('email_messages')
    .select('gmail_message_id')
    .where('thread_id', '=', thread.id)
    .executeTakeFirstOrThrow();
  expect(row.gmail_message_id.endsWith('AAJA5XPK-MOVED')).toBe(true);
  expect(await owed()).toEqual([]);
});

it('Outlook: a refused write is owed, survives a sync, and is delivered by the retry', async () => {
  const { account, thread } = await outlookThread('ol-busy');
  __failOutlookMockSetRead(account.id, 1);

  const summary = await applyAccountThreadModify(db, userId, account.id, thread.id, { markRead: true });
  expect(summary?.isUnread).toBe(false);
  expect(__outlookMockIsRead(account.id, 'ol-busy')).toBe(false);
  expect(await owed()).toEqual([expect.objectContaining({ thread_id: thread.id, desired_unread: 0 })]);

  // A sync reads Outlook's still-unread state back: the thread must not flip.
  __changeOutlookMockMessage(account.id, 'ol-busy', { isRead: false });
  await syncAccount(db, account);
  expect(await threadUnread(thread.id)).toBe(0);

  const r = await flushReadWrites(db, { now: later(2 * 60_000) });
  expect(r.written).toBe(1);
  expect(__outlookMockIsRead(account.id, 'ol-busy')).toBe(true);
  expect(await owed()).toEqual([]);
});

it('Gmail: a refused mark-read is shown read, owed, and delivered by the retry', async () => {
  await backfillGmail(db, userId);
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .executeTakeFirstOrThrow();
  const msg = await db
    .selectFrom('email_messages')
    .select('gmail_message_id')
    .where('thread_id', '=', thread.id)
    .executeTakeFirstOrThrow();
  __failGmailMockModify(userId, 1);

  const summary = await applyThreadModify(db, userId, thread.id, { markRead: true });
  expect(summary?.isUnread).toBe(false);
  expect(__gmailMockLabels(userId, msg.gmail_message_id)).toContain('UNREAD');
  expect((await owed()).length).toBe(1);

  // A sync writing Gmail's stale UNREAD back cannot resurrect it.
  await db
    .updateTable('email_messages')
    .set({ is_unread: 1, gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']) })
    .where('thread_id', '=', thread.id)
    .execute();
  await recomputeThread(db, userId, thread.gmail_thread_id);
  expect(await threadUnread(thread.id)).toBe(0);

  await flushReadWrites(db, { now: later(2 * 60_000) });
  expect(__gmailMockLabels(userId, msg.gmail_message_id)).not.toContain('UNREAD');
  expect(await owed()).toEqual([]);
});

it('gives up after the retry limit and lets the provider state show again', async () => {
  const { account, thread } = await outlookThread('ol-down');
  __failOutlookMockSetRead(account.id, 1000);
  await applyAccountThreadModify(db, userId, account.id, thread.id, { markRead: true });

  let t = Date.now();
  for (let i = 0; i < READ_RETRY_MAX_ATTEMPTS; i++) {
    t += 7 * 60 * 60_000;
    await flushReadWrites(db, { now: new Date(t) });
  }
  expect(await owed()).toEqual([]);
  expect(await threadUnread(thread.id)).toBe(1);
});
