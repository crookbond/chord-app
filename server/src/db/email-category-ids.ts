/**
 * Re-key `email_categories` to per-user ids (migration 046).
 *
 * `email_categories.id` is a GLOBAL primary key, but `ingestClassification`
 * deletes only the caller's rows — and every classifier derives the same
 * path-shaped id, so every user produced the identical `mk:newsletters`. The
 * first user to classify owned it; every later user's ingest died on the pkey.
 * `storageCategoryId` scopes new writes; this brings the existing rows over.
 *
 * Extracted from the migration list so it can be tested against a real
 * database, the same way `mergeDuplicateLists` and `hardenCalendarIdentity`
 * are.
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from './schema.js';

/**
 * Idempotent: every statement is guarded on the prefix being absent, so a
 * re-run cannot produce `u1:u1:mk:…`.
 *
 * The foreign keys come off for the rewrite and go straight back on. They are
 * immediate, so with them in place rewriting ids first strands the children and
 * rewriting children first points them at rows that do not exist yet — no
 * ordering of plain updates holds. `applyMigrations` runs each `up` without a
 * transaction of its own, so this opens one: a half-rekeyed tree with its
 * foreign keys dropped is not a state to leave behind.
 */
export async function scopeEmailCategoryIds(db: Kysely<DB>): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`ALTER TABLE email_message_categories
      DROP CONSTRAINT IF EXISTS email_message_categories_category_id_fkey`.execute(tx);
    await sql`ALTER TABLE email_categories
      DROP CONSTRAINT IF EXISTS email_categories_parent_id_fkey`.execute(tx);

    await sql`UPDATE email_categories SET
        id = user_id || ':' || id,
        parent_id = CASE WHEN parent_id IS NULL THEN NULL ELSE user_id || ':' || parent_id END
      WHERE left(id, length(user_id) + 1) <> user_id || ':'`.execute(tx);
    await sql`UPDATE email_message_categories SET category_id = user_id || ':' || category_id
      WHERE left(category_id, length(user_id) + 1) <> user_id || ':'`.execute(tx);
    await sql`UPDATE email_threads SET category_id = user_id || ':' || category_id
      WHERE category_id IS NOT NULL
        AND left(category_id, length(user_id) + 1) <> user_id || ':'`.execute(tx);

    await sql`ALTER TABLE email_categories ADD CONSTRAINT email_categories_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES email_categories(id) ON DELETE CASCADE`.execute(tx);
    await sql`ALTER TABLE email_message_categories
      ADD CONSTRAINT email_message_categories_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES email_categories(id) ON DELETE CASCADE`.execute(tx);
  });
}
