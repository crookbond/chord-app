/**
 * Prod, 2026-10-27 (8:31 PM EST): attachment downloads 404'd on Gmail and
 * Outlook. An email whose body shows a `cid:` image that no stored part
 * carries (a logo the sender references but sends without a Content-ID) was
 * re-read on EVERY open, the one-time upgrade for older rows never settling.
 * Each re-read rewrote the part list, Gmail hands out new attachment ids on
 * every read, and the download looked the reader's id up in the stored list -
 * which no longer had it - and answered 404 without asking Gmail.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { fetchEmailAttachmentData } from '@/services/email-accounts/attachment-fetch.js';
import {
  __addGmailMockMessage,
  __resetGmailMock,
  __rotateGmailMockAttachmentIds,
  __setGmailMockAttachment,
  type GmailRawMessage,
} from '@/services/google/gmail-api.js';
import { backfillGmail, getThread } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'att-ids');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A receipt: its HTML shows the shop's logo by `cid:`, the PDF has no Content-ID. */
function receiptMessage(): GmailRawMessage {
  return {
    id: 'm_receipt',
    threadId: 't_receipt',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Your receipt from Corner Bakery',
    internalDate: String(Date.now() - 3600_000),
    historyId: '9',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Corner Bakery <receipts@cornerbakery.example>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: 'Your receipt' },
        { name: 'Date', value: new Date().toUTCString() },
        { name: 'Message-ID', value: '<m_receipt@cornerbakery.example>' },
      ],
      parts: [
        { mimeType: 'text/html', body: { data: b64('<img src="cid:logo"><p>Thanks for your order.</p>') } },
        {
          mimeType: 'application/pdf',
          filename: 'receipt.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="receipt.pdf"' }],
          body: { attachmentId: 'att_receipt', size: 11 },
        },
      ],
    },
  };
}

async function openedReceipt() {
  __addGmailMockMessage(userId, receiptMessage());
  __setGmailMockAttachment(userId, 'att_receipt', Buffer.from('PDF-RECEIPT'));
  await backfillGmail(db, userId);
  __rotateGmailMockAttachmentIds(userId);
  const row = await db
    .selectFrom('email_messages')
    .select(['id', 'thread_id'])
    .where('user_id', '=', userId)
    .where('gmail_message_id', '=', 'm_receipt')
    .executeTakeFirstOrThrow();
  const open = async () => (await getThread(db, userId, row.thread_id))!.messages.find((m) => m.id === row.id)!;
  return { row, open };
}

it('a second open does not change the attachment ids the reader holds', async () => {
  const { open } = await openedReceipt();
  const first = (await open()).attachments!.map((a) => a.id);
  const second = (await open()).attachments!.map((a) => a.id);
  expect(second).toEqual(first);
});

it('downloads with the id the reader was given, after later opens', async () => {
  const { row, open } = await openedReceipt();
  const shown = (await open()).attachments![0]!;
  await open();
  await open();

  const data = await fetchEmailAttachmentData(db, userId, row.id, shown.id);
  expect(data?.buffer.toString('utf8')).toBe('PDF-RECEIPT');
  expect(data?.filename).toBe('receipt.pdf');
});

it('downloads by an id the stored list no longer has, if Gmail still knows it', async () => {
  const { row } = await openedReceipt();
  await db
    .updateTable('email_messages')
    .set({ attachments_json: JSON.stringify([{ id: 'att_receipt~99', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 11 }]) })
    .where('id', '=', row.id)
    .execute();

  const data = await fetchEmailAttachmentData(db, userId, row.id, 'att_receipt');
  expect(data?.buffer.toString('utf8')).toBe('PDF-RECEIPT');
  expect(data?.filename).toBe('receipt.pdf');
});
