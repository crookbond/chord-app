import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

/**
 * Resolve a set of user IDs to display names in a single query. Returns a
 * map of `id → display_name ?? username`. IDs absent from the users table
 * are simply not in the map (callers should fall back to their own
 * placeholder).
 */
export async function loadDisplayNames(
  db: Kysely<DB>,
  userIds: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  );
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('users')
    .select(['id', 'display_name', 'username'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, r.display_name ?? r.username]));
}
