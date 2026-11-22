/**
 * A thread row that has its messages but was never filled in from them.
 *
 * Reported from prod (13 Oct): asked to delete or mark the email "Job Offer",
 * the bot offered "5 recent emails with no subject" and could not find
 * "Google still disconnected day 4". All 110 of that user's threads, and 279
 * of another's, had an empty subject, no sender, no search index and a
 * `last_message_at` equal to the instant the row was written, while every
 * message inside them carried its real subject. `ensureThreadRow` writes the
 * row empty and only `recomputeThread` fills it, once at the end of a sync
 * pass; a pass stopped before that step left the rows empty, and later passes
 * skip messages already mirrored, so nothing ever filled them.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail, listThreads, repairUnfilledThreads } from '@/services/google/gmail.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { searchEverything } from '@/services/search.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('threads never filled in from their messages', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let savedBackfillDays: number;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    savedBackfillDays = env.GMAIL_BACKFILL_DAYS;
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = 3650;
    db = await openTestDb();
    userId = await createUser(db, 'unfilled-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await backfillGmail(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = savedBackfillDays;
    await closeTestDb(db);
  });

  /** The prod row: exactly what `ensureThreadRow` writes, messages intact. */
  async function strand(gmailThreadId: string): Promise<string> {
    const at = new Date(Date.now() - 30 * 60_000).toISOString();
    const row = await db
      .updateTable('email_threads')
      .set({
        subject: '',
        snippet: '',
        from_name: null,
        from_email: null,
        blind_words: null,
        blind_grams: null,
        blind_from: null,
        last_message_at: at,
        created_at: at,
        updated_at: at,
      })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const thread = (id: string) =>
    db
      .selectFrom('email_threads')
      .select(['subject', 'from_email', 'last_message_at', 'created_at'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

  const searchSubject = async (q: string) =>
    (await searchEverything(db, { userId, groupId, crossGroup: true, query: q, categories: ['emails'] })).emails;

  it('shows as untitled mail until the next sync fills it in', async () => {
    const id = await strand('t_fam1');

    // What the bot was handed in prod: a hit it could not tell from the others.
    const hits = await searchSubject('Sunday dinner');
    expect(hits.find((h) => h.id === id)?.subject).toBe('(no subject)');
    const list = await listThreads(db, userId, { mode: 'traditional' });
    expect(list.find((t) => t.id === id)?.subject).toBe('');

    // A later pass skips messages it already has, so before the fix it never
    // revisited the row; the repair at the end of every sync does.
    await backfillGmail(db, userId);
    expect((await thread(id)).subject).toBe('Sunday dinner?');
    expect((await searchSubject('Sunday dinner')).find((h) => h.id === id)?.subject).toBe('Sunday dinner?');
  });

  it('is filled in from its messages by the repair that runs on every sync', async () => {
    const id = await strand('t_fam1');

    expect(await repairUnfilledThreads(db, userId)).toBe(1);

    const after = await thread(id);
    expect(after.subject).toBe('Sunday dinner?');
    expect(after.from_email).toBe('grandma@example.com');
    expect(after.last_message_at).not.toBe(after.created_at);
    const hits = await searchSubject('Sunday dinner');
    expect(hits.find((h) => h.id === id)?.subject).toBe('Sunday dinner?');
    // Nothing left to repair, and filled threads are never touched.
    expect(await repairUnfilledThreads(db, userId)).toBe(0);
  });

  it('leaves a row whose sync may still be running', async () => {
    const id = await strand('t_fam1');
    const now = new Date().toISOString();
    await db
      .updateTable('email_threads')
      .set({ last_message_at: now, created_at: now })
      .where('id', '=', id)
      .execute();

    expect(await repairUnfilledThreads(db, userId)).toBe(0);
    expect((await thread(id)).subject).toBe('');
  });
});
