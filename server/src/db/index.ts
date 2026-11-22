import { Kysely, PostgresDialect, type LogConfig } from 'kysely';
import pg from 'pg';

import './pg-types.js';
import { attachContentCrypto } from './crypto/index.js';
import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { ensureDataDirs } from './paths.js';
import type { DB } from './schema.js';

const { Pool } = pg;

/**
 * Open a Kysely handle backed by a node-postgres connection pool.
 *
 * Pool size defaults to 10 per process (`DB_POOL_MAX`), sized for the
 * original one-process-on-one-VM deploy where concurrent in-flight queries
 * during a bot turn were bounded by the tool loop. ADR 0172 splits the
 * server into a web role and a worker role, each its own process with its
 * own pool — so total connections against Postgres is now (number of
 * running processes) x `DB_POOL_MAX`. Check the VM's configured
 * `max_connections` before raising the default.
 *
 * ADR 0038 — sqlite was retired in favor of Postgres on the same VM.
 * `DATA_DIR` still anchors uploaded files; only the DB moved.
 */
export interface OpenDbOptions {
  /**
   * Kysely query logging. Off by default; the load-test harness passes a
   * callback here to time every query without touching any call site.
   */
  log?: LogConfig;
}

export function openDb(opts: OpenDbOptions = {}): Kysely<DB> {
  ensureDataDirs();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
  });
  // node-pg emits 'error' on behalf of idle clients whose connection drops
  // (DB restart, network blip, server-side termination). Without a listener
  // that becomes an uncaught exception and crashes the process — log instead;
  // the pool reconnects on the next query.
  pool.on('error', (err) => logger.error('pg pool error (idle client)', { err: err.message }));
  // ADR 0201 — every handle opens sealed values on the way out of a query.
  // Key lookups get a small pool of their own (see ContentCrypto.keys).
  const keyPool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.CONTENT_KEY_POOL_MAX,
  });
  keyPool.on('error', (err) => logger.error('pg key pool error (idle client)', { err: err.message }));
  return attachContentCrypto(new Kysely<DB>({ dialect: new PostgresDialect({ pool }), log: opts.log }), {
    keyDb: new Kysely<DB>({ dialect: new PostgresDialect({ pool: keyPool }) }),
  });
}
