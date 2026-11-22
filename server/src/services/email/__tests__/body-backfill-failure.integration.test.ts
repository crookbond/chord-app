/**
 * A provider failure (Gmail's per-minute quota, a network error) during the
 * body backfill wrote body_excerpt = '' - "we looked and there was no text" -
 * so the message never re-entered the queue and the AI passes never saw its
 * body. A failed fetch must leave the message to be asked again.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let behaviour: 'quota' | 'text' = 'quota';
vi.mock('@/services/email-accounts/message-text.js', () => ({
  fetchFullBodyText: async () => {
    if (behaviour === 'quota') throw new Error("gmail GET 429: Quota exceeded for quota metric 'Queries'");
    return 'Your order of 2 tickets is confirmed for Friday.';
  },
}));

const { backfillBodyExcerpts } = await import('@/services/email/body-backfill.js');

describe('body backfill when the provider fails', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'backfill');
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({ id: threadRow, user_id: userId, gmail_thread_id: 't_quota', subject: 'Tickets', snippet: 'Your order', last_message_at: now, created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: 't_quota',
        subject: 'Tickets',
        snippet: 'Your order',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        internal_date: now,
        created_at: now,
      })
      .execute();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const excerpt = async () =>
    (await db.selectFrom('email_messages').select('body_excerpt').where('gmail_thread_id', '=', 't_quota').executeTakeFirstOrThrow())
      .body_excerpt;

  it('leaves the message unread after a failed fetch, and fills it on the next pass', async () => {
    behaviour = 'quota';
    await backfillBodyExcerpts(db, userId, { limit: 10 });
    expect(await excerpt()).toBeNull();

    behaviour = 'text';
    const r = await backfillBodyExcerpts(db, userId, { limit: 10 });
    expect(r.filled).toBe(1);
    expect(await excerpt()).toContain('2 tickets');
  });

  it('settles a message that keeps failing, so the queue moves on', async () => {
    behaviour = 'quota';
    for (let i = 0; i < 5; i++) await backfillBodyExcerpts(db, userId, { limit: 10 });
    expect(await excerpt()).toBe('');
  });
});
