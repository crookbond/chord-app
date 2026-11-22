/**
 * Drift guard for `consolidatePersonalGroupInto` (groups.service.ts).
 *
 * Every table with a `group_id` FK to groups(id) is `ON DELETE CASCADE`, so
 * the consolidation MUST re-point each one before it drops the emptied group
 * — a table the function forgets isn't an orphan, it's silently deleted with
 * the group. This test introspects the live schema's FK set and asserts it
 * exactly equals `ALL_GROUP_ID_FK_TABLES`. Add a group-scoped table without
 * teaching consolidation about it and this fails, instead of prod losing data.
 */
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ALL_GROUP_ID_FK_TABLES } from '@/services/groups.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('personal-group consolidation coverage', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('handles every group_id FK table in the live schema', async () => {
    const rows = await sql<{ tbl: string }>`
      SELECT DISTINCT con.conrelid::regclass::text AS tbl
      FROM pg_constraint con
      WHERE con.contype = 'f' AND con.confrelid = 'groups'::regclass
    `.execute(db);
    const liveTables = new Set(rows.rows.map((r) => r.tbl));
    const handled = new Set(ALL_GROUP_ID_FK_TABLES);

    // Anything in the schema we don't re-point → would be CASCADE-deleted.
    const unhandled = [...liveTables].filter((t) => !handled.has(t));
    expect(unhandled, `group_id FK tables missing from consolidation: ${unhandled.join(', ')}`).toEqual([]);

    // Anything we list that no longer exists → stale entry, surface it too.
    const stale = [...handled].filter((t) => !liveTables.has(t));
    expect(stale, `consolidation lists tables with no live FK: ${stale.join(', ')}`).toEqual([]);
  });
});
