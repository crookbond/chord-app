/**
 * Two people can classify the same mailbox shapes.
 *
 * `email_categories.id` is a GLOBAL primary key, but `ingestClassification`
 * deletes only the caller's rows — and every classifier derives the same
 * path-shaped id, so every user produced the identical `mk:newsletters`. The
 * first user to classify owned the id; every later user's ingest died on the
 * pkey, rolled back its whole transaction, and was logged at warn.
 *
 * In prod that left three mailboxes — 1,288 threads — silently unclassified for
 * days while a fourth worked perfectly. This test is that bug: without the
 * namespace it fails on the second `ingestClassification` with
 * `duplicate key value violates unique constraint "email_categories_pkey"`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmailClassificationSnapshot } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import {
  ingestClassification,
  storageCategoryId,
} from '@/services/email/classification.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('classification across users', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice-cls');
    bob = await createUser(db, 'bob-cls');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  /** One thread in the user's mailbox, so the assignment has somewhere to land. */
  const seedThread = async (userId: string, gmailThreadId: string) => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: `et_${gmailThreadId}`,
        user_id: userId,
        gmail_thread_id: gmailThreadId,
        subject: 'Money Stuff',
        snippet: 'Who should control Anthropic?',
        from_name: 'Matt Levine',
        from_email: 'noreply@news.bloomberg.com',
        last_message_at: now,
        message_count: 1,
        is_unread: 1,
        is_archived: 0,
        gmail_label_ids: JSON.stringify(['INBOX']),
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  /** The identical tree both users' classifiers independently produce. */
  const snapshot = (userId: string, gmailThreadId: string): EmailClassificationSnapshot => ({
    version: 1,
    userId,
    categories: [
      { id: 'mk:newsletters', parentId: null, title: 'Newsletters', depth: 0 },
      { id: 'mk:newsletters/finance', parentId: 'mk:newsletters', title: 'Finance', depth: 1 },
    ],
    assignments: [
      { gmailThreadId, categoryId: 'mk:newsletters/finance', action: 'informational' },
    ],
  });

  it('both users classify — the second no longer dies on the primary key', async () => {
    await seedThread(alice, 'gt_alice');
    await seedThread(bob, 'gt_bob');

    const first = await ingestClassification(db, alice, snapshot(alice, 'gt_alice'));
    const second = await ingestClassification(db, bob, snapshot(bob, 'gt_bob'));

    expect(first).toMatchObject({ assignments: 1 });
    expect(second).toMatchObject({ assignments: 1 });

    const rows = await db
      .selectFrom('email_threads')
      .select(['user_id', 'category_id', 'classified_at'])
      .orderBy('user_id')
      .execute();
    expect(rows.every((r) => r.classified_at !== null)).toBe(true);
    // Each lands on its OWN leaf, not a shared one.
    expect(new Set(rows.map((r) => r.category_id)).size).toBe(2);
  });

  it("one user's re-ingest leaves the other's tree alone", async () => {
    await seedThread(alice, 'gt_alice');
    await seedThread(bob, 'gt_bob');
    await ingestClassification(db, alice, snapshot(alice, 'gt_alice'));
    await ingestClassification(db, bob, snapshot(bob, 'gt_bob'));

    // Snapshot-replace drops the caller's whole tree first; scoping the delete
    // is only safe because the ids are scoped too.
    await ingestClassification(db, alice, snapshot(alice, 'gt_alice'));

    const bobRows = await db
      .selectFrom('email_categories')
      .select('id')
      .where('user_id', '=', bob)
      .execute();
    expect(bobRows).toHaveLength(2);
    expect(bobRows.map((r) => r.id)).toContain(storageCategoryId(bob, 'mk:newsletters'));
  });

  /**
   * The residue ADR 0106 did not cover. Scoping the ids stopped two DIFFERENT
   * users colliding; it said nothing about ONE user ingesting twice at once,
   * and `afterSync` was doing exactly that — once per connected mailbox. The
   * same `email_categories_pkey` violation kept firing in prod, now between a
   * user and themselves, alongside `deadlock detected` when the two
   * delete-then-insert transactions grabbed rows in opposite orders.
   */
  it('two ingests racing for ONE user do not collide', async () => {
    await seedThread(alice, 'gt_alice');

    const results = await Promise.all([
      ingestClassification(db, alice, snapshot(alice, 'gt_alice')),
      ingestClassification(db, alice, snapshot(alice, 'gt_alice')),
    ]);

    // Both must SUCCEED — one waiting on the other is fine, one dying is not.
    for (const r of results) expect(r).toMatchObject({ assignments: 1 });

    // And the tree that survives is one whole tree, not a half-replaced one.
    const rows = await db
      .selectFrom('email_categories')
      .select('id')
      .where('user_id', '=', alice)
      .execute();
    expect(rows).toHaveLength(2);
    const thread = await db
      .selectFrom('email_threads')
      .select(['category_id', 'classified_at'])
      .where('user_id', '=', alice)
      .executeTakeFirstOrThrow();
    expect(thread.category_id).toBe(storageCategoryId(alice, 'mk:newsletters/finance'));
    expect(thread.classified_at).not.toBeNull();
  });

  it('keeps the parent link inside the same user', async () => {
    await seedThread(alice, 'gt_alice');
    await ingestClassification(db, alice, snapshot(alice, 'gt_alice'));

    const leaf = await db
      .selectFrom('email_categories')
      .select(['id', 'parent_id'])
      .where('user_id', '=', alice)
      .where('depth', '=', 1)
      .executeTakeFirstOrThrow();
    expect(leaf.parent_id).toBe(storageCategoryId(alice, 'mk:newsletters'));
  });
});
