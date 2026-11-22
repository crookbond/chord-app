/**
 * Prod, 2026-10-26: "apply category label failed ... gmail POST /labels 409:
 * Label name exists or conflicts", 237 times in a day. ensureLabel found a
 * label only by its exact name, while Gmail treats names that differ only in
 * case or spacing as the same label. A category titled "Kids & school" next
 * to an existing "Chord/Kids & School" was created again on every pass, and
 * refused every time, so its threads never got the label.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock, getGmailApi } from '@/services/google/gmail-api.js';
import { ensureLabel, maybeSyncCategoryLabels } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

describe('a Gmail label that already exists', () => {
  let db: Kysely<DB>;
  let userId: string;
  const savedProvider = env.GMAIL_PROVIDER;
  const savedEnabled = env.GMAIL_ENABLED;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    db = await openTestDb();
    userId = await createUser(db, 'label-exists');
    await db.updateTable('users').set({ gmail_sync_labels_enabled: 1 }).where('id', '=', userId).execute();
  });

  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = savedProvider;
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = savedEnabled;
    await closeTestDb(db);
  });

  it('is used when only its case differs, not created again', async () => {
    const existing = await (await getGmailApi(db, userId)).createLabel('Chord/Kids & School');
    const categoryId = `${userId}:mk:kids`;
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({ id: categoryId, user_id: userId, parent_id: null, title: 'Kids & school', color: null, icon: null, gmail_label_id: null, updated_at: now })
      .execute();
    const thread = await seedPlainMail(db, userId, { subject: 'Field trip form' });
    await db.updateTable('email_threads').set({ category_id: categoryId }).where('id', '=', thread).execute();

    expect(await maybeSyncCategoryLabels(db, userId)).toBe(1);
    const category = await db.selectFrom('email_categories').select('gmail_label_id').where('id', '=', categoryId).executeTakeFirstOrThrow();
    expect(category.gmail_label_id).toBe(existing.id);
    const row = await db.selectFrom('email_threads').select('gmail_label_ids').where('id', '=', thread).executeTakeFirstOrThrow();
    expect(row.gmail_label_ids).toContain(existing.id);
  });

  it('is found when it was made in Gmail after the label list was read', async () => {
    const api = await getGmailApi(db, userId);
    await api.createLabel('Chord/Bills');
    await ensureLabel(db, userId, 'Chord/Bills'); // found: the list is read and remembered
    const madeInGmail = await api.createLabel('Chord/Groceries');

    expect(await ensureLabel(db, userId, 'Chord/Groceries')).toBe(madeInGmail.id);
  });
});
