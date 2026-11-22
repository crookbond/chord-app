/**
 * Prod, 2026-10-27: an Outlook attachment opened from the email reader 404'd
 * on every tap. Outlook gives a message a NEW id when it moves folders, and
 * the ids of its attachments change with it (docs/notes/0199). The download
 * asked Graph for the stored message id and the stored attachment id, Graph
 * answered 404, and nothing re-found the message - unlike read, archive and
 * trash, which go through withCurrentGraphId.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  connectOutlookAccount,
  getAccountThread,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import { fetchEmailAttachmentData } from '@/services/email-accounts/attachment-fetch.js';
import {
  __reissueOutlookMockId,
  __resetOutlookMock,
  __setOutlookMockAttachments,
} from '@/services/email-accounts/outlook-api.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const receipt = (id: string) => ({
  id,
  name: 'receipt.pdf',
  contentType: 'application/pdf',
  size: 11,
  contentBytes: Buffer.from('PDF-RECEIPT').toString('base64'),
});

describe('Outlook attachment after the message moved', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'outlook-att');
  });
  afterEach(async () => {
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    await closeTestDb(db);
  });

  /** An Outlook mailbox whose soccer email carries a receipt, opened once in Chord. */
  async function openedWithReceipt() {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    __setOutlookMockAttachments(account.id, 'ol-msg-1', [receipt('att-old')]);
    await syncAccount(db, account);
    await db
      .updateTable('email_messages')
      .set({ attachments_json: null })
      .where('user_id', '=', userId)
      .where('gmail_message_id', 'like', '%ol-msg-1')
      .execute();
    const thread = await db
      .selectFrom('email_threads')
      .select('id')
      .where('account_id', '=', account.id)
      .where('subject', 'like', 'Soccer%')
      .executeTakeFirstOrThrow();
    const detail = await getAccountThread(db, userId, account.id, thread.id);
    const message = detail!.messages.find((m) => m.attachments?.length)!;
    expect(message.attachments![0].id).toBe('att-old');
    return { account, messageId: message.id };
  }

  /** What Outlook does when the message moves: a new message id, new attachment ids. */
  function moveInOutlook(accountId: string) {
    __reissueOutlookMockId(accountId, 'ol-msg-1', 'ol-msg-1-moved');
    __setOutlookMockAttachments(accountId, 'ol-msg-1', []);
    __setOutlookMockAttachments(accountId, 'ol-msg-1-moved', [receipt('att-new')]);
  }

  it('downloads with the id the reader was given', async () => {
    const { account, messageId } = await openedWithReceipt();
    moveInOutlook(account.id);

    const data = await fetchEmailAttachmentData(db, userId, messageId, 'att-old');
    expect(data?.buffer.toString('utf8')).toBe('PDF-RECEIPT');
    expect(data?.filename).toBe('receipt.pdf');
  });

  it('stores the current ids, so the next download goes straight there', async () => {
    const { account, messageId } = await openedWithReceipt();
    moveInOutlook(account.id);
    await fetchEmailAttachmentData(db, userId, messageId, 'att-old');

    const row = await db
      .selectFrom('email_messages')
      .select(['gmail_message_id', 'attachments_json'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    expect(row.gmail_message_id).toMatch(/ol-msg-1-moved$/);
    expect((row.attachments_json ?? []).map((a) => a.id)).toEqual(['att-new']);
    const again = await fetchEmailAttachmentData(db, userId, messageId, 'att-new');
    expect(again?.buffer.toString('utf8')).toBe('PDF-RECEIPT');
  });

  it('still 404s for a message deleted from Outlook', async () => {
    const { account, messageId } = await openedWithReceipt();
    __reissueOutlookMockId(account.id, 'ol-msg-1', 'ol-msg-1-moved');
    __setOutlookMockAttachments(account.id, 'ol-msg-1', []);
    const { __removeOutlookMockMessage } = await import('@/services/email-accounts/outlook-api.js');
    __removeOutlookMockMessage(account.id, 'ol-msg-1-moved');

    expect(await fetchEmailAttachmentData(db, userId, messageId, 'att-old')).toBeNull();
  });
});
