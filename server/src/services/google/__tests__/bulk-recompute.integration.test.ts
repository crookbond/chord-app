/**
 * ADR 0109 — the bulk signal has to reach the row.
 *
 * `recomputeThread` is the one choke point every provider funnels through, so
 * deriving it there is what makes the column true for Gmail, Outlook and IMAP
 * without three implementations.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { recomputeThread } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('bulk on thread recompute', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'bulk-recompute');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const seed = async (
    gid: string,
    messages: { listUnsubscribe?: string | null; labels?: string[] }[],
  ): Promise<void> => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Two weeks left',
        snippet: 'Two weeks left',
        from_email: 'news@christysports.example',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const m of messages) {
      await db
        .insertInto('email_messages')
        .values({
          id: newId('em'),
          user_id: userId,
          thread_id: threadId,
          gmail_message_id: newId('gm'),
          gmail_thread_id: gid,
          from_email: 'news@christysports.example',
          to_emails: JSON.stringify([]),
          cc_emails: JSON.stringify([]),
          subject: 'Two weeks left',
          snippet: 'Two weeks left',
          internal_date: now,
          gmail_label_ids: JSON.stringify(m.labels ?? ['INBOX']),
          list_unsubscribe: m.listUnsubscribe ?? null,
          created_at: now,
        })
        .execute();
    }
  };

  const bulkOf = async (gid: string): Promise<number> => {
    const row = await db
      .selectFrom('email_threads')
      .select('bulk')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .executeTakeFirstOrThrow();
    return row.bulk;
  };

  it('marks a blast, and Gmail’s own tab counts too', async () => {
    await seed('t_header', [{ listUnsubscribe: '<https://x.example/u?id=9>' }]);
    await recomputeThread(db, userId, 't_header');
    expect(await bulkOf('t_header')).toBe(1);

    // The coverage gap the header alone leaves: small senders set none.
    await seed('t_label', [{ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }]);
    await recomputeThread(db, userId, 't_label');
    expect(await bulkOf('t_label')).toBe(1);
  });

  it('leaves ordinary mail alone, and a reply un-bulks the thread', async () => {
    await seed('t_plain', [{ labels: ['INBOX'] }]);
    await recomputeThread(db, userId, 't_plain');
    expect(await bulkOf('t_plain')).toBe(0);

    await seed('t_replied', [
      { listUnsubscribe: '<https://x.example/u?id=9>' },
      { labels: ['SENT'] },
    ]);
    await recomputeThread(db, userId, 't_replied');
    expect(await bulkOf('t_replied')).toBe(0);
  });
});
