/**
 * Process-wide node-pg type parser overrides.
 *
 * node-pg returns int8/bigint columns as strings by default to avoid
 * JS Number precision loss past 2^53. We never store values that
 * large (counts, ids are short text), and the historical SQLite
 * contract was "count returns a JS number," so service code and tests
 * expect that. Parse OID 20 (int8 / bigint) as Number to keep parity.
 *
 * Imported for side-effect by both `db/index.ts` (production pool)
 * and `__test-helpers__/db.ts` (per-test pool), so any test that
 * boots without going through openDb() still gets the override.
 */
import pg from 'pg';

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
