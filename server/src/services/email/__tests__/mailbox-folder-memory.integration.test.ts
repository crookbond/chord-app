/**
 * A label or folder the user deleted in their mail app stays deleted
 * (ADR 0303 addendum 2026-11-10). Before, every path that used one ran "find
 * by name, create if missing", so deleting a filing rule's folder in Outlook,
 * or a Chord/ label in Gmail, only lasted until the next email that needed it.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { connectImapAccount, connectOutlookAccount, syncAccount } from '@/services/email-accounts/accounts.service.js';
import { __imapMockFiled, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import {
  __deleteOutlookMockFolder,
  __outlookMockFolderNames,
  __resetOutlookMock,
} from '@/services/email-accounts/outlook-api.js';
import { pushChordLabels } from '@/services/email/chord-label-push.js';
import { __resetFilingFailures, addFilingRule, applyFilingRules } from '@/services/email/filing.service.js';
import { forgetGmailLabels } from '@/services/email/gmail-label-cache.js';
import { forgetRemovedFolders, isChordProviderLabel } from '@/services/email/mailbox-folder-memory.js';
import { __deleteGmailMockLabel, __resetGmailMock, getGmailApi } from '@/services/google/gmail-api.js';
import { maybeSyncCategoryLabels } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  __resetOutlookMock();
  __resetImapMock();
  __resetFilingFailures();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'folders');
});
afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

const threadBySubject = (like: string) =>
  db
    .selectFrom('email_threads')
    .select(['id', 'from_email', 'subject', 'is_archived'])
    .where('user_id', '=', userId)
    .where('subject', 'like', like)
    .executeTakeFirstOrThrow();

/** The same sender's mail is back in the inbox (a new message from them). */
async function backInInbox(threadId: string) {
  const inbox = JSON.stringify(['INBOX']);
  await db.updateTable('email_messages').set({ gmail_label_ids: sql`${inbox}::jsonb` }).where('thread_id', '=', threadId).execute();
  await db
    .updateTable('email_threads')
    .set({ is_archived: 0, gmail_label_ids: sql`${inbox}::jsonb` })
    .where('id', '=', threadId)
    .execute();
}

describe('a filing rule whose folder the user deleted', () => {
  it('Outlook: the folder is not made again, and asking again makes it', async () => {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const soccer = await threadBySubject('Soccer%');
    await addFilingRule(db, userId, { from: soccer.from_email!, folder: 'Sports', alsoExisting: true });
    expect(await applyFilingRules(db, userId)).toBe(1);
    expect(__outlookMockFolderNames(account!.id)).toContain('Sports');

    __deleteOutlookMockFolder(account!.id, 'Sports');
    await backInInbox(soccer.id);
    expect(await applyFilingRules(db, userId)).toBe(0);
    expect(await applyFilingRules(db, userId)).toBe(0);

    expect(__outlookMockFolderNames(account!.id)).not.toContain('Sports');
    expect((await threadBySubject('Soccer%')).is_archived).toBe(0);

    await addFilingRule(db, userId, { from: soccer.from_email!, folder: 'Sports', alsoExisting: true });
    expect(await applyFilingRules(db, userId)).toBe(1);
    expect(__outlookMockFolderNames(account!.id)).toContain('Sports');
  });

  it('IMAP: the mailbox is not made again', async () => {
    await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password: 'app-password', preset: 'yahoo' });
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account!);
    const picture = await threadBySubject('Picture day%');
    await addFilingRule(db, userId, { from: picture.from_email!, folder: 'School', alsoExisting: true });
    expect(await applyFilingRules(db, userId)).toBe(1);

    __imapMockFiled(account!.id).delete('School');
    await backInInbox(picture.id);
    expect(await applyFilingRules(db, userId)).toBe(0);

    expect(__imapMockFiled(account!.id).has('School')).toBe(false);
    expect((await threadBySubject('Picture day%')).is_archived).toBe(0);
  });
});

describe('a Chord/ label the user deleted in Gmail', () => {
  it('label push does not make it again; switching push back on does', async () => {
    await db.updateTable('users').set({ chord_label_push_enabled: 1 }).where('id', '=', userId).execute();
    const first = await seedPlainMail(db, userId, { subject: 'Recital' });
    await pushChordLabels(db, userId, first, { addChordLabels: ['Family'] });
    const api = await getGmailApi(db, userId);
    expect((await api.listLabels()).map((l) => l.name)).toContain('Chord/Family');

    __deleteGmailMockLabel(userId, 'Chord/Family');
    const second = await seedPlainMail(db, userId, { subject: 'Bake sale' });
    await pushChordLabels(db, userId, second, { addChordLabels: ['Family'] });
    await pushChordLabels(db, userId, second, { addChordLabels: ['Family'] });
    expect((await api.listLabels()).map((l) => l.name)).not.toContain('Chord/Family');

    await forgetRemovedFolders(db, userId, isChordProviderLabel, 'primary');
    await pushChordLabels(db, userId, second, { addChordLabels: ['Family'] });
    expect((await api.listLabels()).map((l) => l.name)).toContain('Chord/Family');
  });

  it('the category label sync does not make it again, and stops applying the dead id', async () => {
    await db.updateTable('users').set({ gmail_sync_labels_enabled: 1 }).where('id', '=', userId).execute();
    const categoryId = `${userId}:mk:school`;
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({ id: categoryId, user_id: userId, parent_id: null, title: 'School', color: null, icon: null, gmail_label_id: null, updated_at: now })
      .execute();
    const first = await seedPlainMail(db, userId, { subject: 'Field trip form' });
    await db.updateTable('email_threads').set({ category_id: categoryId }).where('id', '=', first).execute();
    expect(await maybeSyncCategoryLabels(db, userId)).toBe(1);

    __deleteGmailMockLabel(userId, 'Chord/School');
    forgetGmailLabels(db, userId);
    const second = await seedPlainMail(db, userId, { subject: 'Picture day' });
    await db.updateTable('email_threads').set({ category_id: categoryId }).where('id', '=', second).execute();
    expect(await maybeSyncCategoryLabels(db, userId)).toBe(0);
    // The category forgot the dead id; a pass that re-reads it still makes nothing.
    expect(await maybeSyncCategoryLabels(db, userId)).toBe(0);

    const api = await getGmailApi(db, userId);
    expect((await api.listLabels()).map((l) => l.name)).not.toContain('Chord/School');
    const cat = await db.selectFrom('email_categories').select('gmail_label_id').where('id', '=', categoryId).executeTakeFirstOrThrow();
    expect(cat.gmail_label_id).toBeNull();
  });
});
