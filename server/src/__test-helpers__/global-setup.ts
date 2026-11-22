/**
 * Vitest globalSetup — runs once before any test file.
 *
 *  1. Ensures the `chord_test` parent database exists.
 *  2. Sweeps any `chord_test_t_*` per-test database clones left over
 *     from previous runs (ctrl-c, crash, or `closeTestDb` skipped).
 *  3. (Re)builds the `chord_test_template` database by dropping and
 *     recreating it, then applying every migration. `openTestDb()`
 *     then clones from this template via `CREATE DATABASE … TEMPLATE`
 *     — a fast file-level copy of the catalog directory rather than
 *     a per-test migration replay (which was the dominant cost in
 *     the Postgres test path).
 *
 * Reads `TEST_DATABASE_URL` from process.env (set by vitest.config.ts).
 * Failures here surface as a global vitest startup error rather than a
 * cryptic per-test connect failure.
 */
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

import '../db/pg-types.js';
import type { DB } from '../db/schema.js';
import { applyMigrations } from '../db/migrate.js';
import { TEMPLATE_DB_NAME, adminUrl, urlForDb } from './db.js';

const { Pool } = pg;

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://chord@127.0.0.1:5432/chord_test';

function dbNameFromUrl(url: string): string {
  const u = new URL(url);
  return u.pathname.replace(/^\//, '').split('?')[0];
}

export default async function setup(): Promise<void> {
  const parentDbName = dbNameFromUrl(TEST_URL);

  // Step 1 — ensure the parent test DB exists (kept for back-compat;
  // some legacy tooling still connects directly to chord_test).
  const admin = new pg.Client({ connectionString: adminUrl(TEST_URL) });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [parentDbName],
    );
    if (exists.rows.length === 0) {
      await admin.query(
        `CREATE DATABASE "${parentDbName.replace(/"/g, '""')}"`,
      );
      console.log(`[test-setup] created database ${parentDbName}`);
    }

    // Step 2 — sweep stale clones from prior runs.
    const stale = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'chord_test_t_%'`,
    );
    for (const row of stale.rows) {
      await admin
        .query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`)
        .catch(() => admin.query(`DROP DATABASE IF EXISTS "${row.datname}"`));
    }
    if (stale.rows.length > 0) {
      console.log(`[test-setup] dropped ${stale.rows.length} stale clone(s)`);
    }

    // Step 3a — wipe the template and recreate it empty. We always
    // rebuild from scratch so a stale template (migrations added
    // since the last run) never silently masks a missing column.
    await admin
      .query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}" WITH (FORCE)`)
      .catch(() => admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB_NAME}"`));
    await admin.query(`CREATE DATABASE "${TEMPLATE_DB_NAME}"`);
  } finally {
    await admin.end();
  }

  // Step 3b — apply migrations into the template. Done from a
  // dedicated pool that we destroy immediately so the template has
  // zero active connections by the time openTestDb() runs (CREATE
  // DATABASE … TEMPLATE refuses if anyone is connected).
  const templatePool = new Pool({
    connectionString: urlForDb(TEMPLATE_DB_NAME, TEST_URL),
    max: 1,
  });
  const templateDb = new Kysely<DB>({
    dialect: new PostgresDialect({ pool: templatePool }),
  });
  try {
    await applyMigrations(templateDb);
  } finally {
    await templateDb.destroy();
  }

  console.log(`[test-setup] template ${TEMPLATE_DB_NAME} ready`);
}
