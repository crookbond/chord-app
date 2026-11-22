/**
 * The email list paged on `last_message_at < cursor` alone, so threads that
 * shared a timestamp across a page edge were skipped. Outlook stores whole
 * seconds, which makes ties ordinary. The cursor now carries the id as well.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { normalizeGraphMessage } from '@/services/email-accounts/outlook.service.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('email list paging', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'paging');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns every thread when several share the time at a page edge', async () => {
    const at = '2026-10-26T09:15:00Z';
    for (let i = 0; i < 5; i++) {
      await db
        .insertInto('email_threads')
        .values({
          id: newId('emt'),
          user_id: userId,
          gmail_thread_id: `t${i}`,
          subject: `Thread ${i}`,
          snippet: '',
          last_message_at: at,
          gmail_label_ids: JSON.stringify(['INBOX']),
          created_at: at,
          updated_at: at,
        })
        .execute();
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const rows = await listThreads(db, userId, { mode: 'traditional', limit: 2, cursor });
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1]!;
      cursor = `${last.lastMessageAt}|${last.id}`;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it('still accepts an older app’s bare timestamp cursor', async () => {
    const rows = await listThreads(db, userId, { mode: 'traditional', cursor: '2026-10-26T09:15:00Z' });
    expect(rows).toEqual([]);
  });

  it('stores an Outlook time the way every other provider does', () => {
    const m = normalizeGraphMessage('acc1', {
      id: 'm1',
      conversationId: 'c1',
      receivedDateTime: '2026-10-26T09:15:00Z',
    } as never);
    expect(m.internalDate).toBe('2026-10-26T09:15:00.000Z');
  });
});
