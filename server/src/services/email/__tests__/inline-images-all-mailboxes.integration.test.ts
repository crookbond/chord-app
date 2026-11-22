/**
 * ADR 0198 on every mailbox kind, not just the Outlook one the prod report
 * came from: the primary Gmail, a secondary Gmail, Outlook (see
 * outlook-partial-delta.integration.test.ts) and IMAP. Each must record the
 * inline part's Content-ID and serve its bytes by it.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectGmailAccount,
  connectImapAccount,
  getAccountThread,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addImapMockMessage,
  __resetImapMock,
  __setImapMockAttachment,
  parseFetchedMessage,
} from '@/services/email-accounts/imap-api.js';
import { fetchInlineImage } from '@/services/email/inline-image.js';
import {
  __addGmailMockMessage,
  __resetGmailMock,
  __setGmailMockAttachment,
  type GmailRawMessage,
} from '@/services/google/gmail-api.js';
import { backfillGmail, getThread } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  __resetImapMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'inline-all');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

const CID = 'ii_mfq9x2k00';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A Gmail-shaped reply with a pasted photo: multipart/related, the image
 *  part named only by its Content-ID (Gmail's own compose does this). */
function gmailInlineMessage(id: string): GmailRawMessage {
  return {
    id,
    threadId: `t_${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Here is the photo from the game',
    internalDate: String(Date.now() - 3600_000),
    historyId: '9',
    payload: {
      mimeType: 'multipart/related',
      headers: [
        { name: 'From', value: 'Priya <priya@example.com>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: 'Game photo' },
        { name: 'Date', value: new Date().toUTCString() },
        { name: 'Message-ID', value: `<${id}@example.com>` },
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: { data: b64(`<p>Here is the photo from the game</p><img src="cid:${CID}" alt="photo">`) },
        },
        {
          mimeType: 'image/jpeg',
          headers: [
            { name: 'Content-ID', value: `<${CID}>` },
            { name: 'Content-Disposition', value: 'inline' },
          ],
          body: { attachmentId: `att_${id}`, size: 5 },
        },
      ],
    },
  };
}

async function messageRow(gmailMessageLike: string) {
  return db
    .selectFrom('email_messages')
    .select(['id', 'thread_id'])
    .where('user_id', '=', userId)
    .where('gmail_message_id', 'like', `%${gmailMessageLike}`)
    .executeTakeFirstOrThrow();
}

it('primary Gmail: the inline part carries its Content-ID and is served by it', async () => {
  __addGmailMockMessage(userId, gmailInlineMessage('m_photo'));
  __setGmailMockAttachment(userId, 'att_m_photo', Buffer.from('JPEG1'));
  await backfillGmail(db, userId);

  const row = await messageRow('m_photo');
  const detail = await getThread(db, userId, row.thread_id);
  const msg = detail!.messages.find((m) => m.id === row.id)!;
  expect(msg.attachments).toEqual([
    expect.objectContaining({ id: 'att_m_photo', contentId: CID, mimeType: 'image/jpeg' }),
  ]);
  const image = await fetchInlineImage(db, userId, row.id, `cid:${CID}`);
  expect(image?.buffer.toString()).toBe('JPEG1');
});

it('secondary Gmail: same, through the attached account', async () => {
  await connectGmailAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  __addGmailMockMessage(account.id, gmailInlineMessage('m_photo2'));
  __setGmailMockAttachment(account.id, 'att_m_photo2', Buffer.from('JPEG2'));
  await syncAccount(db, account);

  const row = await messageRow('m_photo2');
  const detail = await getAccountThread(db, userId, account.id, row.thread_id);
  const msg = detail!.messages.find((m) => m.id === row.id)!;
  expect(msg.attachments?.[0]?.contentId).toBe(CID);
  const image = await fetchInlineImage(db, userId, row.id, CID);
  expect(image?.buffer.toString()).toBe('JPEG2');
});

it('IMAP: the real parser records the Content-ID of an inline part', async () => {
  const boundary = 'rel-boundary';
  const source = Buffer.from(
    [
      'From: Lincoln Elementary <office@school.example>',
      'To: family@yahoo.example',
      'Subject: Picture day',
      'Message-ID: <yh-200@school.example>',
      'Date: Tue, 22 Sep 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      `Content-Type: multipart/related; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Picture day!</p><img src="cid:logo123@school.example">',
      `--${boundary}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-ID: <logo123@school.example>',
      'Content-Disposition: inline',
      '',
      Buffer.from('PNGBYTES').toString('base64'),
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  );
  const parsed = await parseFetchedMessage({ uid: 200, flags: new Set(), source });
  expect(parsed?.attachments).toEqual([
    expect.objectContaining({ id: 'i0', mimeType: 'image/png', contentId: 'logo123@school.example' }),
  ]);
});

it('IMAP: an inline part stored at sync is served by its Content-ID', async () => {
  await connectImapAccount(db, userId, {
    emailAddress: 'family@yahoo.example',
    password: 'app-password',
    preset: 'yahoo',
  });
  const [account] = await listAccounts(db, userId);
  __addImapMockMessage(account.id, {
    uid: 201,
    flags: [],
    messageId: '<yh-201@school.example>',
    inReplyTo: null,
    references: null,
    subject: 'Picture day logo',
    fromName: 'Lincoln Elementary',
    fromEmail: 'office@school.example',
    toEmails: ['family@yahoo.example'],
    ccEmails: [],
    date: new Date().toISOString(),
    snippet: 'Picture day!',
    bodyText: null,
    bodyHtml: '<p>Picture day!</p><img src="cid:logo123@school.example">',
  });
  __setImapMockAttachment(account.id, 201, 0, {
    filename: 'logo.png',
    mimeType: 'image/png',
    content: Buffer.from('PNGBYTES'),
    contentId: '<logo123@school.example>',
  });
  await syncAccount(db, account);

  const row = await messageRow('201');
  const image = await fetchInlineImage(db, userId, row.id, 'cid:logo123@school.example');
  expect(image?.buffer.toString()).toBe('PNGBYTES');
});
