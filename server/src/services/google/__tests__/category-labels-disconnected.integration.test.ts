/**
 * Prod, 2026-10-04: a user whose Google grant had been refused logged
 * `apply category label failed … has no Google refresh token on file` once per
 * classified thread on every post-sync pass — 8,640 warnings in a day.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';
import { maybeSyncCategoryLabels } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

describe('category label sync for a disconnected mailbox', () => {
  let db: Kysely<DB>;
  let userId: string;
  const savedProvider = env.GMAIL_PROVIDER;

  beforeEach(async () => {
    // The mock provider answers "has Gmail" for everyone; this is about a
    // real mailbox that has lost its grant.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'google';
    db = await openTestDb();
    userId = await createUser(db, 'label-syncer');
    const now = new Date().toISOString();
    // What `invalid_grant` leaves: label sync still switched on, no token, no scopes.
    await db
      .updateTable('users')
      .set({ gmail_sync_labels_enabled: 1, refresh_token_scopes: null, google_connected_at: now })
      .where('id', '=', userId)
      .execute();
    const categoryId = `${userId}:mk:school`;
    await db
      .insertInto('email_categories')
      .values({
        id: categoryId,
        user_id: userId,
        parent_id: null,
        title: 'School',
        color: null,
        icon: null,
        gmail_label_id: null,
        updated_at: now,
      })
      .execute();
    for (const subject of ['Picture day', 'Field trip form', 'Trivia night']) {
      const threadId = await seedPlainMail(db, userId, { subject });
      await db
        .updateTable('email_threads')
        .set({ category_id: categoryId })
        .where('id', '=', threadId)
        .execute();
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = savedProvider;
    await closeTestDb(db);
  });

  it('does nothing, and logs nothing, when the mailbox has no grant', async () => {
    const warn = vi.spyOn(logger, 'warn');

    const applied = await maybeSyncCategoryLabels(db, userId);

    expect(applied).toBe(0);
    const failures = warn.mock.calls.filter(
      (call) => String(call[0]) === 'apply category label failed',
    );
    expect(failures).toEqual([]);
  });
});
