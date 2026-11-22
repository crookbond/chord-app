/**
 * Label sync read the newest N classified threads and skipped, in JS, the
 * ones already carrying their category label. Once the newest N were all
 * labelled, every pass read the same N and did nothing: an older classified
 * thread never got its `Chord/<category>` label however many passes ran.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock, getGmailApi } from '@/services/google/gmail-api.js';
import { maybeSyncCategoryLabels } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

describe('category label sync reaches older threads', () => {
  let db: Kysely<DB>;
  let userId: string;
  const savedProvider = env.GMAIL_PROVIDER;
  const savedEnabled = env.GMAIL_ENABLED;
  let LABEL = '';
  let oldThread = '';

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    db = await openTestDb();
    userId = await createUser(db, 'label-older');
    await db.updateTable('users').set({ gmail_sync_labels_enabled: 1 }).where('id', '=', userId).execute();
    // The stored id names a label Gmail really has: one it does not have is a
    // label the user deleted (ADR 0303 addendum), and is not applied.
    LABEL = (await (await getGmailApi(db, userId)).createLabel('Chord/School')).id;
    const categoryId = `${userId}:mk:school`;
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: categoryId,
        user_id: userId,
        parent_id: null,
        title: 'School',
        color: null,
        icon: null,
        gmail_label_id: LABEL,
        updated_at: now,
      })
      .execute();
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    // Three recent threads already labelled, one older one not.
    for (let i = 1; i <= 3; i++) {
      const id = await seedPlainMail(db, userId, { subject: `Recent ${i}`, at: day(i) });
      await db
        .updateTable('email_threads')
        .set({ category_id: categoryId, gmail_label_ids: JSON.stringify(['INBOX', LABEL]) })
        .where('id', '=', id)
        .execute();
    }
    oldThread = await seedPlainMail(db, userId, { subject: 'Older form', at: day(30) });
    await db
      .updateTable('email_threads')
      .set({ category_id: categoryId })
      .where('id', '=', oldThread)
      .execute();
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = savedProvider;
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = savedEnabled;
    await closeTestDb(db);
  });

  it('labels the older thread even when the newest ones fill the batch', async () => {
    const applied = await maybeSyncCategoryLabels(db, userId, { limit: 3 });
    expect(applied).toBe(1);
    const row = await db
      .selectFrom('email_threads')
      .select('gmail_label_ids')
      .where('id', '=', oldThread)
      .executeTakeFirstOrThrow();
    expect(row.gmail_label_ids).toContain(LABEL);
  });
});
