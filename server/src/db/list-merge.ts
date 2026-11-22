/**
 * Folding one list into another — the single definition of what "these are
 * the same list" does to the rows.
 *
 * Three callers need it and must not disagree: migration 042 (healing the
 * forks the old case-sensitive `=` left behind), `renameList` (a rename whose
 * new name collides with a list that already exists), and the tests that pin
 * both. It lives under `db/` rather than `services/` so the migration runner
 * can use it without importing upward through the layering.
 */
import { sql, type Kysely } from 'kysely';

import { listNameKey, normalizeText } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB } from './schema.js';

/**
 * Move `dupeId`'s items onto `keeperId` and delete the emptied list.
 *
 * Items the keeper already has (compared with `normalizeText`, the rule
 * `addItem` dedups on) are dropped rather than moved, so a merge cannot
 * produce "Milk" twice. Returns the number of items that moved.
 */
export async function mergeListInto(
  db: Kysely<DB>,
  keeperId: string,
  dupeId: string,
): Promise<number> {
  if (keeperId === dupeId) return 0;

  const keeperItems = await db
    .selectFrom('list_items')
    .select('text')
    .where('list_id', '=', keeperId)
    .execute();
  const seen = new Set(keeperItems.map((i) => normalizeText(i.text)));

  const items = await db
    .selectFrom('list_items')
    .select(['id', 'text'])
    .where('list_id', '=', dupeId)
    .orderBy('created_at', 'asc')
    .execute();

  let moved = 0;
  for (const item of items) {
    const key = normalizeText(item.text);
    if (seen.has(key)) continue;
    seen.add(key);
    await db.updateTable('list_items').set({ list_id: keeperId }).where('id', '=', item.id).execute();
    moved += 1;
  }

  // `catchup_assignments.entity_id` carries no foreign key, so the row would
  // outlive the list it points at.
  await sql`DELETE FROM catchup_assignments
    WHERE entity_type = 'list' AND entity_id = ${dupeId}`.execute(db);
  await db.deleteFrom('lists').where('id', '=', dupeId).execute();
  return moved;
}

/**
 * Migration 042 — fold every group's same-key lists into the oldest.
 *
 * Symmetric resolution (ADR 0094) stops new forks; it does not merge the ones
 * already in the database. Extracted and idempotent so it can be tested
 * directly, the same shape `hardenCalendarIdentity` uses: this is data
 * movement, not DDL, and the case worth asserting is an item both sides hold.
 */
export async function mergeDuplicateLists(db: Kysely<DB>): Promise<void> {
  const lists = await db
    .selectFrom('lists')
    .select(['id', 'group_id', 'name'])
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const byKey = new Map<string, string[]>();
  for (const l of lists) {
    const key = `${l.group_id}\u0000${listNameKey(l.name)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(l.id);
    else byKey.set(key, [l.id]);
  }

  let mergedLists = 0;
  let movedItems = 0;
  for (const ids of byKey.values()) {
    if (ids.length < 2) continue;
    const [keeper, ...dupes] = ids;
    for (const dupe of dupes) {
      movedItems += await mergeListInto(db, keeper, dupe);
      mergedLists += 1;
    }
  }
  if (mergedLists > 0) {
    logger.info(
      `042_merge_duplicate_lists: folded ${mergedLists} duplicate list(s), moved ${movedItems} item(s)`,
    );
  }
}
