/**
 * Prod, 2026-09-23: replying to an Outlook thread was impossible — the composer
 * showed `To: -` and Send stayed greyed out. The message row had subject '',
 * from_email NULL, to_emails [] and internal_date = the sync time. Graph's
 * delta reports a change to an already-delivered message (read elsewhere) as
 * `{ id, isRead }` only, and the sync normalized that as a whole message,
 * overwriting every field the item did not carry.
 *
 * Same prod thread also showed why the images were missing: its only image was
 * `<img src="cid:image626147.jpg@DD2A01E4.8287D995">`, an inline part Graph
 * leaves out of `hasAttachments`, so nothing recorded it and nothing could
 * resolve the reference.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectOutlookAccount,
  getAccountThread,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  __addOutlookMockMessage,
  __changeOutlookMockMessage,
  __resetOutlookMock,
  __setOutlookMockAttachments,
  type GraphMessage,
} from '@/services/email-accounts/outlook-api.js';
import { fetchInlineImage } from '@/services/email/inline-image.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'outlook-partial');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

async function connect() {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  const [account] = await listAccounts(db, userId);
  return account;
}

const received = '2026-09-22T01:37:49.000Z';
const CID = 'image626147.jpg@DD2A01E4.8287D995';

const message = (id: string): GraphMessage => ({
  id,
  conversationId: `conv-${id}`,
  subject: 'Board meeting notes',
  bodyPreview: 'Notes attached below.',
  receivedDateTime: received,
  from: { emailAddress: { address: 'Chair@Example.org', name: 'The Chair' } },
  toRecipients: [{ emailAddress: { address: 'ownertest@hotmail.com' } }],
  ccRecipients: [{ emailAddress: { address: 'treasurer@example.org' } }],
  isRead: false,
  body: {
    contentType: 'html',
    content: `<p>Notes below.</p><img src="cid:${CID}" width="90" height="85.95" border="0" alt="">`,
  },
});

const row = (msgId: string) =>
  db
    .selectFrom('email_messages')
    .selectAll()
    .where('user_id', '=', userId)
    .where('gmail_message_id', 'like', `%${msgId}`)
    .executeTakeFirstOrThrow();

it('a delta item carrying only the changed isRead keeps the sender, recipients, subject and date', async () => {
  const account = await connect();
  __addOutlookMockMessage(account.id, message('m-read'));
  await syncAccount(db, account);

  __changeOutlookMockMessage(account.id, 'm-read', { isRead: true });
  await syncAccount(db, account);

  const r = await row('m-read');
  expect(r.from_email).toBe('chair@example.org');
  expect(r.to_emails).toEqual(['ownertest@hotmail.com']);
  expect(r.cc_emails).toEqual(['treasurer@example.org']);
  expect(r.subject).toBe('Board meeting notes');
  expect(r.internal_date).toBe(received);
  expect(r.is_unread).toBe(0);
});

it('opening a thread repairs a row an earlier partial delta blanked, without un-archiving it', async () => {
  const account = await connect();
  __addOutlookMockMessage(account.id, message('m-inbox'));
  __addOutlookMockMessage(account.id, message('m-archived'));
  await syncAccount(db, account);

  // The exact prod shape: content blanked, location (labels) intact.
  const blank = (id: string, labels: string[]) =>
    db
      .updateTable('email_messages')
      .set({
        subject: '',
        snippet: '',
        from_name: null,
        from_email: null,
        to_emails: '[]',
        cc_emails: '[]',
        gmail_label_ids: JSON.stringify(labels),
      })
      .where('user_id', '=', userId)
      .where('gmail_message_id', 'like', `%${id}`)
      .execute();
  await blank('m-inbox', ['INBOX']);
  await blank('m-archived', []);

  for (const id of ['m-inbox', 'm-archived']) {
    const r = await row(id);
    const detail = await getAccountThread(db, userId, account.id, r.thread_id);
    const msg = detail!.messages.find((m) => m.id === r.id)!;
    expect(msg.fromEmail).toBe('chair@example.org');
    expect(msg.toEmails).toEqual(['ownertest@hotmail.com']);
    expect(msg.subject).toBe('Board meeting notes');
  }
  expect((await row('m-inbox')).gmail_label_ids).toContain('INBOX');
  expect((await row('m-archived')).gmail_label_ids).not.toContain('INBOX');
});

it('an inline cid: image is recorded on thread open and served by its Content-ID', async () => {
  const account = await connect();
  __addOutlookMockMessage(account.id, message('m-logo'));
  __setOutlookMockAttachments(account.id, 'm-logo', [
    {
      id: 'att-inline',
      name: 'image626147.jpg',
      contentType: 'image/jpeg',
      size: 4,
      contentId: `<${CID}>`,
      contentBytes: Buffer.from('JPEG').toString('base64'),
    },
  ]);
  await syncAccount(db, account);

  const r = await row('m-logo');
  const detail = await getAccountThread(db, userId, account.id, r.thread_id);
  const msg = detail!.messages.find((m) => m.id === r.id)!;
  expect(msg.attachments).toEqual([
    expect.objectContaining({ id: 'att-inline', contentId: CID.toLowerCase() }),
  ]);

  // The body's own spelling of the reference, as the client sends it.
  const image = await fetchInlineImage(db, userId, r.id, CID);
  expect(image?.buffer.toString('utf8')).toBe('JPEG');
  expect(image?.mimeType).toBe('image/jpeg');

  // Another user holding a token cannot reach this message.
  const other = await createUser(db, 'someone-else');
  expect(await fetchInlineImage(db, other, r.id, CID)).toBeNull();
});
