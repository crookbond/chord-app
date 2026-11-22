/**
 * A thread row with no message, and a message the provider no longer has.
 *
 * Reported from prod: the AI views listed emails that "don't exist" and opened
 * to an empty screen. 47 thread rows in prod held no message at all - each
 * created the instant a sync wrote the thread row and then failed to write its
 * message (`created_at = updated_at = last_message_at`, `message_count` 1, no
 * labels), most of them on one day. Nothing ever removed them, and every list
 * showed them as unarchived mail.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __deleteGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import {
  backfillGmail,
  ensureThreadRow,
  getThread,
  listThreads,
  reapEmptyThreads,
} from '@/services/google/gmail.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('threads with nothing in them', () => {
  let db: Kysely<DB>;
  let userId: string;
  let savedBackfillDays: number;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    savedBackfillDays = env.GMAIL_BACKFILL_DAYS;
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = 3650;
    db = await openTestDb();
    userId = await createUser(db, 'reap-user');
    await backfillGmail(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = savedBackfillDays;
    await closeTestDb(db);
  });

  /** The prod shape: the thread row a sync wrote before its message failed. */
  async function shell(gmailThreadId: string, createdAt: string): Promise<string> {
    return ensureThreadRow(db, userId, gmailThreadId, createdAt);
  }

  const exists = async (id: string) =>
    !!(await db.selectFrom('email_threads').select('id').where('id', '=', id).executeTakeFirst());

  const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

  it('lists a message-less thread as mail until it is reaped', async () => {
    const id = await shell('t_shell', minutesAgo(30));
    // The defect: it is in the inbox list with nothing behind it.
    expect((await listThreads(db, userId, { mode: 'traditional' })).some((t) => t.id === id)).toBe(
      true,
    );

    expect(await reapEmptyThreads(db, userId)).toBe(1);

    expect(await exists(id)).toBe(false);
    expect((await listThreads(db, userId, { mode: 'traditional' })).some((t) => t.id === id)).toBe(
      false,
    );
  });

  it('leaves a row that may still be waiting for its message, and real threads', async () => {
    const fresh = await shell('t_inflight', new Date().toISOString());
    const before = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .execute();

    expect(await reapEmptyThreads(db, userId)).toBe(0);

    expect(await exists(fresh)).toBe(true);
    const after = await db
      .selectFrom('email_threads')
      .select('id')
      .where('user_id', '=', userId)
      .execute();
    expect(after).toHaveLength(before.length);
  });

  it('opening a message-less thread reads as not found, and removes it', async () => {
    // Before the fix this returned the row with an empty message list, which
    // the reader drew as a blank email with a reply button.
    const id = await shell('t_shell', minutesAgo(30));

    expect(await getThread(db, userId, id)).toBeNull();
    expect(await exists(id)).toBe(false);
  });

  it('opening an email Gmail has deleted drops it, with whatever it suggested', async () => {
    const group = await ensurePersonalGroup(db, userId);
    const thread = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_fam1')
      .executeTakeFirstOrThrow();
    const messages = await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_message_id'])
      .where('thread_id', '=', thread.id)
      .execute();
    const proposal = await createProposal(db, {
      groupId: group.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Reply about Sunday dinner' },
      provenance: 'gmail:t_fam1',
    });
    // Mail that arrived by incremental sync has no stored body until opened;
    // that open is where the 404 is met.
    await db
      .updateTable('email_messages')
      .set({ body_text: null, body_html: null })
      .where('thread_id', '=', thread.id)
      .execute();
    // Deleted for good at Gmail, and no sync has run to say so.
    for (const m of messages) __deleteGmailMockMessage(userId, m.gmail_message_id);

    expect(await getThread(db, userId, thread.id)).toBeNull();

    expect(await exists(thread.id)).toBe(false);
    const after = await db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', proposal.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('expired');
  });
});
