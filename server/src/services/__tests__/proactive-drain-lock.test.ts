/**
 * `withDrainLock` — the non-blocking advisory-lock backstop around one
 * proactive-drain pass (`proactive.queue.ts`). Only meant to matter once
 * the worker role scales past one instance, so it needs two genuinely
 * separate Postgres SESSIONS to prove anything.
 *
 * `pg_advisory_lock`/`pg_try_advisory_lock` are scoped PER DATABASE, not
 * cluster-wide — confirmed empirically against a live Postgres instance
 * before writing this (a session on a different database never contends,
 * even holding the identical two-int key). `openTestDb()`'s recycled
 * handle is a single-connection (`max: 1`) pool, and its "nested call"
 * escape hatch hands back a database CLONE, not a second connection to
 * the SAME database — so neither gives two sessions that can actually
 * contend. This test opens two raw connections to one shared, migration-
 * free database instead (advisory locks need no schema at all).
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';

import '@/db/pg-types.js';
import type { DB } from '@/db/schema.js';
import { TEST_URL } from '@/__test-helpers__/db.js';
import { __testing } from '@/services/proactive.queue.js';

function rawDb(): Kysely<DB> {
  const pool = new Pool({ connectionString: TEST_URL, max: 1 });
  pool.on('error', () => {});
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Poll `pg_locks` for the exact key `withDrainLock` takes, rather than a
 * fixed delay — a guessed sleep proved unreliable against real round-trip
 * latency while developing this test.
 */
async function waitForDrainLockHeld(db: Kysely<DB>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype = 'advisory' AND objid = 0
        AND classid = hashtext(${__testing.LOCK_KEY})
    `.execute(db);
    if ((rows.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for the drain lock to be held');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('withDrainLock', () => {
  const opened: Kysely<DB>[] = [];

  afterAll(async () => {
    await Promise.all(opened.map((db) => db.destroy()));
  });

  it('a concurrent call is skipped while another session holds the lock', async () => {
    // Each call opens its own lock session (a separate connection).
    const dbCheck = rawDb();
    opened.push(dbCheck);

    const order: string[] = [];
    let releaseA: () => void = () => {};
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const runA = __testing.withDrainLock(TEST_URL, async () => {
      order.push('a-start');
      await gateA;
      order.push('a-end');
    });

    await waitForDrainLockHeld(dbCheck);

    // B's try-lock is non-blocking and must resolve entirely on its own —
    // await it to completion BEFORE releasing A, so it genuinely runs
    // while A still holds the lock rather than racing A's release.
    await __testing.withDrainLock(TEST_URL, async () => {
      order.push('b-ran'); // must never happen while A holds the lock
    });

    releaseA();
    await runA;

    expect(order).toEqual(['a-start', 'a-end']);
  });

  it('a later call succeeds once the earlier one has released the lock', async () => {
    const order: string[] = [];
    await __testing.withDrainLock(TEST_URL, async () => {
      order.push('one');
    });
    await __testing.withDrainLock(TEST_URL, async () => {
      order.push('two');
    });

    expect(order).toEqual(['one', 'two']);
  });

  it('does not take a connection from the pool the drain itself uses', async () => {
    // The app pool here has ONE connection. The lock used to pin a pool
    // connection for the whole drain, so the drain's own first query waited
    // on the lock's connection forever.
    const app = rawDb();
    opened.push(app);
    let ran = false;
    const drain = __testing.withDrainLock(TEST_URL, async () => {
      await sql`SELECT 1`.execute(app);
      ran = true;
    });
    const guard = new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 10_000));
    expect(await Promise.race([drain.then(() => 'done' as const), guard])).toBe('done');
    expect(ran).toBe(true);
  });
});
