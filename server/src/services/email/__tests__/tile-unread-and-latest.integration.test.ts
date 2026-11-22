/**
 * The Cards view orders categories by unread mail first, then by whichever
 * received mail most recently. `attention` cannot drive that: it also counts
 * read threads that carry a pending suggestion. So a tile reports its unread
 * count and its newest thread's time on their own.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { getTiles, ingestClassification } from '@/services/email/classification.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('a tile reports unread mail and its newest thread', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'tile-unread');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const seed = async (gid: string, unread: number, at: string, archived = 0): Promise<void> => {
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
        gmail_thread_id: gid,
        subject: gid,
        snippet: gid,
        is_unread: unread,
        is_archived: archived,
        last_message_at: at,
        created_at: at,
        updated_at: at,
      })
      .execute();
  };

  it('counts unread threads and takes the newest time, per category and rolled up', async () => {
    await seed('school_old', 1, '2026-09-01T10:00:00.000Z');
    await seed('school_new', 0, '2026-09-20T10:00:00.000Z');
    await seed('bank_a', 0, '2026-09-10T10:00:00.000Z');
    // Archived mail is out of every listing, so it must not count or set the time.
    await seed('bank_archived', 1, '2026-09-30T10:00:00.000Z', 1);

    const res = await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [
        { id: 'c:family', parentId: null, title: 'Family', depth: 0 },
        { id: 'c:school', parentId: 'c:family', title: 'School', depth: 1 },
        { id: 'c:bank', parentId: null, title: 'Bank', depth: 0 },
      ],
      assignments: [
        { gmailThreadId: 'school_old', categoryId: 'c:school' },
        { gmailThreadId: 'school_new', categoryId: 'c:school' },
        { gmailThreadId: 'bank_a', categoryId: 'c:bank' },
        { gmailThreadId: 'bank_archived', categoryId: 'c:bank' },
      ],
    });
    expect('assignments' in res).toBe(true);

    const { tiles } = await getTiles(db, userId, null, { deep: true });
    const family = tiles.find((t) => t.title === 'Family')!;
    const school = family.children!.find((t) => t.title === 'School')!;
    const bank = tiles.find((t) => t.title === 'Bank')!;

    expect(school.unread).toBe(1);
    expect(school.lastMessageAt).toBe('2026-09-20T10:00:00.000Z');
    // The parent holds no mail of its own; both values come from its child.
    expect(family.unread).toBe(1);
    expect(family.lastMessageAt).toBe('2026-09-20T10:00:00.000Z');

    expect(bank.unread).toBe(0);
    expect(bank.lastMessageAt).toBe('2026-09-10T10:00:00.000Z');
  });
});
