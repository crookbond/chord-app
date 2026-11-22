/**
 * The email list marks a thread that carries a file, so a row can show a
 * paperclip beside its subject. An image shown inside the body (a logo sent
 * by Content-ID) is not an attachment.
 */
import type { Kysely, KyselyPlugin } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { fillAttachmentFlags } from '@/services/email/attachment-flags.js';
import {
  __addGmailMockMessage,
  __resetGmailMock,
  type GmailRawMessage,
} from '@/services/google/gmail-api.js';
import { backfillGmail, listThreads } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'att-flag');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function message(id: string, subject: string, part: NonNullable<GmailRawMessage['payload']>): GmailRawMessage {
  return {
    id,
    threadId: `t_${id}`,
    labelIds: ['INBOX'],
    snippet: subject,
    internalDate: String(Date.now() - 3600_000),
    historyId: '9',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Shop <shop@example.com>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date().toUTCString() },
        { name: 'Message-ID', value: `<${id}@example.com>` },
      ],
      parts: [{ mimeType: 'text/html', body: { data: b64('<img src="cid:logo"><p>Hi</p>') } }, part],
    },
  };
}

async function seedTwo() {
  __addGmailMockMessage(
    userId,
    message('m_pdf', 'Your receipt', {
      mimeType: 'application/pdf',
      filename: 'receipt.pdf',
      body: { attachmentId: 'att_pdf', size: 11 },
    }),
  );
  __addGmailMockMessage(
    userId,
    message('m_logo', 'Newsletter', {
      mimeType: 'image/png',
      filename: 'logo.png',
      headers: [{ name: 'Content-ID', value: '<logo>' }],
      body: { attachmentId: 'att_logo', size: 4 },
    }),
  );
  await backfillGmail(db, userId);
}

const flags = async () =>
  Object.fromEntries(
    (await listThreads(db, userId, { mode: 'traditional' })).map((t) => [t.subject, t.hasAttachments]),
  );

it('marks a thread with a file, not one whose only part is an inline logo', async () => {
  await seedTwo();
  expect(await flags()).toMatchObject({ 'Your receipt': true, Newsletter: false });
});

it('lists each thread’s files by name, ready to open, and not its inline logo', async () => {
  await seedTwo();
  const threads = await listThreads(db, userId, { mode: 'traditional' });
  const receipt = threads.find((t) => t.subject === 'Your receipt')!;
  expect(receipt.files).toEqual([
    expect.objectContaining({ id: 'att_pdf', filename: 'receipt.pdf', mimeType: 'application/pdf', size: 11 }),
  ]);
  const message = await db
    .selectFrom('email_messages')
    .select('id')
    .where('gmail_message_id', '=', 'm_pdf')
    .executeTakeFirstOrThrow();
  expect(receipt.files![0]!.messageId).toBe(message.id);
  expect(threads.find((t) => t.subject === 'Newsletter')!.files).toBeUndefined();
});

it('fills the mark in for mail stored before it existed', async () => {
  await seedTwo();
  await db.updateTable('email_messages').set({ has_attachments: null }).where('user_id', '=', userId).execute();
  expect(await flags()).toMatchObject({ 'Your receipt': false });

  // The mock mailbox's own sample mail is filled in too.
  expect(await fillAttachmentFlags(db, userId)).toBeGreaterThanOrEqual(2);
  expect(await flags()).toMatchObject({ 'Your receipt': true, Newsletter: false });
  expect(await fillAttachmentFlags(db, userId)).toBe(0);
});

it('fills a whole batch in one write per flag value, not one per message', async () => {
  await seedTwo();
  await db.updateTable('email_messages').set({ has_attachments: null }).where('user_id', '=', userId).execute();
  const pending = await db
    .selectFrom('email_messages')
    .select('id')
    .where('user_id', '=', userId)
    .where('attachments_json', 'is not', null)
    .execute();
  expect(pending.length).toBeGreaterThanOrEqual(3);

  let updates = 0;
  const counter: KyselyPlugin = {
    transformQuery(args) {
      if (args.node.kind === 'UpdateQueryNode') updates += 1;
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  };
  expect(await fillAttachmentFlags(db.withPlugin(counter), userId)).toBe(pending.length);
  expect(updates).toBeLessThanOrEqual(2);
  expect(await flags()).toMatchObject({ 'Your receipt': true, Newsletter: false });
});
