/**
 * Migration 046 — bring existing category rows onto per-user ids.
 *
 * The rows already in a database were written before `storageCategoryId`
 * existed, so they carry the un-namespaced `mk:…` ids that made classification
 * single-user. This moves them without losing a tree, an assignment, or a
 * thread's link to its leaf.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { scopeEmailCategoryIds } from '@/db/email-category-ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('scopeEmailCategoryIds', () => {
  let db: Kysely<DB>;
  let userId: string;

  const now = () => new Date().toISOString();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'legacy-cls');

    // A pre-migration tree: parent + child on bare `mk:` ids.
    await db
      .insertInto('email_categories')
      .values([
        {
          id: 'mk:newsletters',
          user_id: userId,
          parent_id: null,
          title: 'Newsletters',
          depth: 0,
          sort_order: 0,
          updated_at: now(),
        },
        {
          id: 'mk:newsletters/finance',
          user_id: userId,
          parent_id: 'mk:newsletters',
          title: 'Finance',
          depth: 1,
          sort_order: 1,
          updated_at: now(),
        },
      ])
      .execute();

    await db
      .insertInto('email_threads')
      .values({
        id: 'et_legacy',
        user_id: userId,
        gmail_thread_id: 'gt_legacy',
        subject: 'Money Stuff',
        last_message_at: now(),
        message_count: 1,
        is_unread: 1,
        is_archived: 0,
        gmail_label_ids: JSON.stringify(['INBOX']),
        category_id: 'mk:newsletters/finance',
        classified_at: now(),
        created_at: now(),
        updated_at: now(),
      })
      .execute();

    await db
      .insertInto('email_message_categories')
      .values({
        id: 'emc_legacy',
        user_id: userId,
        thread_id: 'et_legacy',
        category_id: 'mk:newsletters/finance',
        assigned_at: now(),
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const ids = async () =>
    (await db.selectFrom('email_categories').select(['id', 'parent_id']).orderBy('depth').execute());

  it('prefixes every id and re-links parents to the moved rows', async () => {
    await scopeEmailCategoryIds(db);

    const rows = await ids();
    expect(rows.map((r) => r.id)).toEqual([
      `${userId}:mk:newsletters`,
      `${userId}:mk:newsletters/finance`,
    ]);
    // A parent link left on the old id would dangle the moment the FK is back.
    expect(rows[1]!.parent_id).toBe(`${userId}:mk:newsletters`);
  });

  it('carries both referencing tables across', async () => {
    await scopeEmailCategoryIds(db);

    const thread = await db
      .selectFrom('email_threads')
      .select(['category_id', 'classified_at'])
      .where('id', '=', 'et_legacy')
      .executeTakeFirstOrThrow();
    expect(thread.category_id).toBe(`${userId}:mk:newsletters/finance`);
    // The thread stays classified — this is a re-key, not a reclassify.
    expect(thread.classified_at).not.toBeNull();

    const assignment = await db
      .selectFrom('email_message_categories')
      .select('category_id')
      .where('id', '=', 'emc_legacy')
      .executeTakeFirstOrThrow();
    expect(assignment.category_id).toBe(`${userId}:mk:newsletters/finance`);
  });

  it('puts the foreign keys back, so a dangling link is refused afterwards', async () => {
    await scopeEmailCategoryIds(db);

    await expect(
      db
        .insertInto('email_message_categories')
        .values({
          id: 'emc_bad',
          user_id: userId,
          thread_id: 'et_legacy',
          category_id: 'mk:does-not-exist',
          assigned_at: now(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('is idempotent — a second run does not double-prefix', async () => {
    await scopeEmailCategoryIds(db);
    await scopeEmailCategoryIds(db);

    const rows = await ids();
    expect(rows.map((r) => r.id)).toEqual([
      `${userId}:mk:newsletters`,
      `${userId}:mk:newsletters/finance`,
    ]);
  });
});
