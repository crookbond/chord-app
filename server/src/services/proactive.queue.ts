import { Queue, Worker } from 'bullmq';
import { type Kysely } from 'kysely';
import pg from 'pg';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { drainOnce, seedDailyScan } from './proactive.service.js';
import { logQueueErrors, makeQueueConnection } from './queue/redis.js';

const QUEUE_NAME = 'proactive-scan';
const REPEAT_JOB_NAME = 'drain';
const REPEAT_JOB_ID = 'proactive-drain-tick';
const LOCK_KEY = 'proactive_drain';
const STALE_TICK_CLEAN_LIMIT = 200_000;

/**
 * A tick is finished the moment it has run, and nothing reads it afterwards.
 *
 * BullMQ keeps every completed job unless told otherwise, and this queue adds
 * one every tick: at 15 s that is 5,760 a day. In prod 98,468 of them filled
 * Redis to its memory limit in about seventeen days, after which Redis refused
 * every write. A few failures are kept, since those are worth reading.
 */
export const TICK_JOB_OPTS = { removeOnComplete: true, removeOnFail: { count: 50 } } as const;

export interface ProactiveQueueHandle {
  stop: () => Promise<void>;
}

/**
 * BullMQ-backed replacement for `startProactiveScheduler`'s setInterval
 * loop. A fixed-`jobId` repeatable job is inherently single-flight
 * cluster-wide — the direct fix for "N worker instances would each
 * independently poll and race" — with no new leader-election code. The
 * worker role stays pinned to one instance through this phase (ADR 0172),
 * so today this is correctness insurance for later scaling, not a
 * behavior change. Only used when `REDIS_URL` is set; `roles/worker.ts`
 * falls back to the original `startProactiveScheduler` otherwise.
 */
export async function startProactiveQueue(
  db: Kysely<DB>,
  redisUrl: string,
): Promise<ProactiveQueueHandle> {
  logger.info(`proactive queue starting tick=${env.PROACTIVE_TICK_MS}ms`);
  // Seed today's daily scan rows (one per user with a personal group).
  // Idempotent — won't insert if a row already exists for today.
  seedDailyScan(db).catch((err) => logger.error('seedDailyScan failed', { err }));

  const connection = makeQueueConnection(redisUrl);
  const queue = new Queue(QUEUE_NAME, { connection });
  // BullMQ v6's Job Scheduler API (upsertJobScheduler) replaced the older
  // add(..., {repeat}) + removeRepeatable pair. "Upsert" makes this
  // idempotent across restarts — no accumulating duplicate schedules.
  await queue.upsertJobScheduler(REPEAT_JOB_ID, { every: env.PROACTIVE_TICK_MS }, {
    name: REPEAT_JOB_NAME,
    opts: TICK_JOB_OPTS,
  });
  // Ticks finished before the options above existed are still in Redis, and
  // nothing else removes them. Best-effort: the queue works without it.
  queue.clean(0, STALE_TICK_CLEAN_LIMIT, 'completed').catch((err: unknown) => {
    logger.warn('proactive queue: could not clear old finished ticks', {
      err: (err as Error).message,
    });
  });

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      await withDrainLock(env.DATABASE_URL, () => drainOnce(db));
    },
    { connection, concurrency: 1 },
  );
  logQueueErrors('proactive queue', { queue, worker }, (m, meta) => logger.error(m, meta));

  return {
    // Deliberately does NOT remove the job scheduler here — this stop()
    // runs on every graceful shutdown (including an ordinary systemd
    // restart), and removing the schedule would open a gap where no tick
    // is produced until the next process's upsertJobScheduler call runs.
    // Leaving it in Redis is harmless: upsertJobScheduler is idempotent, so
    // the next startup neither duplicates it nor needs it to still exist.
    stop: async () => {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}

/**
 * Non-blocking session-scoped advisory lock around one drain pass — the
 * real mutual-exclusion backstop (not BullMQ's repeat-job internals, which
 * this phase doesn't rely on for correctness) once the worker role ever
 * scales past one instance.
 *
 * The lock lives on its OWN short-lived connection, outside the app pool, the
 * way ADR 0280's leadership locks do. It used to pin a pool connection (a
 * `db.transaction()` held open) for the whole drain, so every drain ran with
 * one connection fewer, and with a one-connection pool the drain could not
 * run at all: its own queries waited for the connection the lock was holding.
 * `fn` uses the ordinary app handle and commits its own writes.
 */
async function withDrainLock(connectionString: string, fn: () => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString });
  client.on('error', (err) => logger.warn('proactive drain lock connection error', { err: err.message }));
  await client.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1), 0) AS locked',
      [LOCK_KEY],
    );
    if (result.rows[0]?.locked !== true) {
      logger.debug('proactive drain already running elsewhere, skipping this tick');
      return;
    }
    try {
      await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1), 0)', [LOCK_KEY]);
    }
  } finally {
    // Ending the session also releases the lock if the unlock above failed.
    await client.end().catch(() => {});
  }
}

export const __testing = { withDrainLock, LOCK_KEY };
