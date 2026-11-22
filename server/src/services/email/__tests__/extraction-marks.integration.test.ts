/**
 * Durable extraction marks (migration 030): the once-ever mined markers are
 * keyed by gmail_thread_id in email_extraction_marks, NOT on the mirror rows
 * — so a disconnect (mirror wipe) + reconnect re-backfill must not re-mine
 * threads or re-stage proposals the user already saw.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import {
  runPersonExtraction,
  type PersonExtractor,
} from '@/services/email/person-extraction.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('extraction marks survive a mirror wipe', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    // Mock provider so the magics invite probe resolves (unknown message ids
    // → "not an invite") instead of deferring every thread on an OAuth error.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'marks-user');
    return async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      await closeTestDb(db);
    };
  });

  // A re-backfill restores a message with its ORIGINAL arrival time (Gmail
  // internalDate, Graph receivedDateTime, IMAP INTERNALDATE), so both seeds
  // carry the same one. Stamping the second with "now" would read as a new
  // message arriving after the mark, which ADR 0315 rightly re-reads.
  const sentAt = new Date(Date.now() - 3_600_000).toISOString();
  const seedThread = async (gid: string, opts: { categoryId?: string } = {}) => {
    const now = new Date().toISOString();
    const threadId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: gid,
        subject: `Subject ${gid}`,
        snippet: 'snip',
        from_email: 'friend@example.com',
        last_message_at: sentAt,
        category_id: opts.categoryId ?? null,
        ...(opts.categoryId ? { classified_at: now } : {}),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: userId,
        thread_id: threadId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        from_email: 'friend@example.com',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: `Subject ${gid}`,
        snippet: 'snip',
        body_text: 'See you at dinner.',
        internal_date: sentAt,
        created_at: now,
      })
      .execute();
  };

  const wipeMirror = () =>
    db.deleteFrom('email_threads').where('user_id', '=', userId).execute();

  it('person extraction never re-mines a re-backfilled thread', async () => {
    await seedThread('g-person-1');
    const calls: string[] = [];
    const extractor: PersonExtractor = {
      extract: (input) => {
        calls.push(input.subject);
        return Promise.resolve([{ name: 'Sara', relationship: 'friend', confidence: 0.9 }]);
      },
    };

    const first = await runPersonExtraction(db, userId, { extractor });
    expect(first.processed).toBe(1);
    expect(calls).toHaveLength(1);

    // Disconnect wipes the mirror; reconnect re-backfills the SAME thread.
    await wipeMirror();
    await seedThread('g-person-1');

    const second = await runPersonExtraction(db, userId, { extractor });
    expect(second.processed).toBe(0);
    expect(calls).toHaveLength(1); // no second LLM read, no new proposals
  });

  it('magics never re-stage a proposal after wipe + re-backfill', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: 'cat_m',
        user_id: userId,
        parent_id: null,
        title: 'Family',
        depth: 0,
        sort_order: 0,
        updated_at: now,
      })
      .execute();
    await seedThread('g-magic-1', { categoryId: 'cat_m' });

    const extractor: EmailExtractor = {
      extract: () =>
        Promise.resolve({ kind: 'list', listName: 'Shopping', item: 'milk' }),
    };
    const first = await runEmailMagics(db, userId, { extractor });
    expect(first.lists).toBe(1);

    await wipeMirror();
    await seedThread('g-magic-1', { categoryId: 'cat_m' });

    const again = await runEmailMagics(db, userId, { extractor });
    expect(again.processed).toBe(0);

    const proposals = await db
      .selectFrom('proposals')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('proposed_by_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(proposals.n)).toBe(1);
  });
});
