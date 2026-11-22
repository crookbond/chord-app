/**
 * Mirror-provider guard: threads synced under one GMAIL_PROVIDER must never
 * survive a flip to the other (mock fixtures leaking into a real account's
 * reader — docs/tasks/Email-bugsandbacklog.md bug 2).
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail, ensureMirrorProvider } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('ensureMirrorProvider', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'mirror-user');
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    await closeTestDb(db);
  });

  const threadCount = async () => {
    const rows = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    return rows.length;
  };

  const userRow = () =>
    db
      .selectFrom('users')
      .select(['gmail_mirror_provider', 'gmail_backfill_done', 'gmail_history_id'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  it('stamps the provider on backfill and keeps the mirror under the same provider', async () => {
    await backfillGmail(db, userId);
    expect(await threadCount()).toBeGreaterThan(0);
    expect((await userRow()).gmail_mirror_provider).toBe('mock');

    const before = await threadCount();
    await ensureMirrorProvider(db, userId);
    expect(await threadCount()).toBe(before);
    expect((await userRow()).gmail_backfill_done).toBe(1);
  });

  it('wipes the mock mirror when the provider flips to real', async () => {
    await backfillGmail(db, userId);
    expect(await threadCount()).toBeGreaterThan(0);

    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await ensureMirrorProvider(db, userId);

    expect(await threadCount()).toBe(0);
    const u = await userRow();
    expect(u.gmail_mirror_provider).toBe('real');
    expect(u.gmail_backfill_done).toBe(0);
    expect(u.gmail_history_id).toBeNull();
  });
});
