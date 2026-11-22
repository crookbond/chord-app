/**
 * Prod, 29 Oct: a new user's Action Items filled with ~70 suggestions made
 * from the images inside her USPS Informed Delivery emails (scans of postal
 * junk mail): "Apply to Wagner College", "Vote YES on Prop 41", oil-change
 * coupons. Email attachment import (ADR 0071) saved each image through
 * `saveFile`, whose extraction then ran the chat-screenshot classifier on it as
 * if the user had posted it to act on. A file copied out of email must not
 * get those suggestions; a picture a person posts still does.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const proposeContent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/services/bot/content_classifier.js', () => ({ classifyAndProposeContent: proposeContent }));
vi.mock('@/services/bot/trip_classifier.js', () => ({ classifyAndAutoFileAttachment: vi.fn(async () => false) }));

// A scanned postcard: plenty of text, a caption the personal-photo filter lets through.
const SCAN_META = {
  caption: 'Postcard from Wagner College about applying for admission',
  keyFacts: ['Apply at wagner.edu', 'Staten Island, NY'],
  tags: ['postcard', 'college'],
  mimeType: 'image/jpeg',
  sizeBytes: 80_000,
  ocrChars: 420,
};
vi.mock('@/services/attachments.extract.js', () => ({
  extractAndSummarize: vi.fn(async () => ({
    text: 'Make a significant investment in your future. Apply to Wagner College.',
    summary: 'Wagner College admission postcard',
    imageMeta: JSON.stringify(SCAN_META),
  })),
}));

const SCAN = Buffer.alloc(40 * 1024, 7);
vi.mock('@/services/email-accounts/attachment-fetch.js', () => ({
  attachmentPartsFor: vi.fn(async () => [
    { id: 'p1', filename: '1050214376-001.jpg', mimeType: 'image/jpeg', size: SCAN.byteLength },
  ]),
  fetchEmailAttachmentData: vi.fn(async () => ({ buffer: SCAN, mimeType: 'image/jpeg', filename: '1050214376-001.jpg' })),
}));

import type { DB } from '@/db/schema.js';
import { saveFile, requeuePendingExtractions } from '@/services/attachments.service.js';
import { importEmailAttachments } from '@/services/email/attachment-import.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('images copied from email get no screenshot suggestions', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    proposeContent.mockClear();
    db = await openTestDb();
    userId = await createUser(db, 'peace');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedInformedDeliveryEmail(): Promise<string> {
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: 'gt-informed',
        subject: 'Your Daily Digest for Wed, 10/28 is ready to view',
        snippet: 'You have mail and packages arriving soon.',
        from_email: 'uspsinformeddelivery@email.informeddelivery.usps.com',
        last_message_at: now,
        is_unread: 1,
        is_archived: 0,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: 'gm-informed',
        gmail_thread_id: 'gt-informed',
        internal_date: now,
        subject: 'Your Daily Digest for Wed, 10/28 is ready to view',
        snippet: 'You have mail and packages arriving soon.',
        from_email: 'uspsinformeddelivery@email.informeddelivery.usps.com',
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        created_at: now,
      })
      .execute();
    return threadRow;
  }

  it('imports the scan and links it to its email, but suggests nothing from it', async () => {
    const threadRow = await seedInformedDeliveryEmail();

    const res = await importEmailAttachments(db, userId);
    await settleBackgroundWork();

    expect(res.imported).toBe(1);
    const rows = await db.selectFrom('attachments').select(['origin_email_thread_id', 'indexed_at']).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin_email_thread_id).toBe(threadRow);
    expect(rows[0]!.indexed_at).not.toBeNull();
    expect(proposeContent).not.toHaveBeenCalled();
  });

  it('still suggests from a picture a person posted to the chat', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    await saveFile(db, {
      scope: { kind: 'group', groupId: personal.id },
      uploadedBy: userId,
      filename: 'IMG_2231.jpg',
      mimeType: 'image/jpeg',
      buffer: SCAN,
      awaitExtraction: true,
    });
    expect(proposeContent).toHaveBeenCalledTimes(1);
  });

  it('an interrupted email import retried at boot suggests nothing either', async () => {
    const threadRow = await seedInformedDeliveryEmail();
    const personal = await ensurePersonalGroup(db, userId);
    const saved = await saveFile(db, {
      scope: { kind: 'group', groupId: personal.id },
      uploadedBy: userId,
      filename: '1050214376-002.jpg',
      mimeType: 'image/jpeg',
      buffer: SCAN,
      index: false,
      originEmailThreadId: threadRow,
    });
    // Looks like an upload whose extraction was cut off.
    await db
      .updateTable('attachments')
      .set({ index_requested: 1, created_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .where('id', '=', saved.id)
      .execute();

    expect(await requeuePendingExtractions(db)).toBe(1);
    await settleBackgroundWork();

    expect(proposeContent).not.toHaveBeenCalled();
  });
});
