import { Queue, Worker } from 'bullmq';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { syncAllUserMail } from '../email-accounts/accounts.service.js';
import { logQueueErrors, makeQueueConnection } from '../queue/redis.js';

const QUEUE_NAME = 'mail-sync';

/**
 * BullMQ v6 rejects a custom job id containing `:` outright ("Custom Id
 * cannot contain :", confirmed against the real library, not assumed) —
 * so this uses `_`, not the `:`-separated style used elsewhere in this
 * codebase for cache/lock keys.
 */
function jobIdFor(userId: string): string {
  return `mailsync_${userId}`;
}

export interface MailSyncQueueHandle {
  /** Enqueue one user's mailbox sync — skips if one is already pending/running. */
  enqueue: (userId: string) => Promise<void>;
  stop: () => Promise<void>;
}

/**
 * BullMQ-backed replacement for `sweepMailboxes`'s sequential
 * one-mailbox-at-a-time loop. `MAIL_SWEEP_BATCH` still bounds how many
 * stale mailboxes are *considered* per tick (`dueForSweep`); this queue
 * only changes how many of them actually sync *at once*
 * (`MAIL_SYNC_QUEUE_CONCURRENCY`), decoupling the two.
 *
 * Job key `mailsync:${userId}` — user-scoped, not account-scoped —
 * because the thing this dedups is narrow: the SWEEP re-selecting a user
 * whose previous sweep-triggered sync hasn't finished (and so hasn't
 * updated `gmail_synced_at`) by the time the next tick's `dueForSweep`
 * runs. It does NOT replace `accountSyncs` (`accounts.service.ts`,
 * per-account, ADR 0080) or `mailSyncRounds`/`afterSyncRuns`
 * (`gmail.service.ts`, per-user round/concurrency coalescing) — those
 * protect a different, wider axis: several call paths (this sweep, the
 * Email tab's force-sync route, the daily-briefing scan) all reaching
 * `syncAllUserMail`/`syncAccount` for the same user or account at once.
 * The job processor below still calls `syncAllUserMail`, so all of that
 * existing coalescing keeps working exactly as it does today, regardless
 * of whether the caller is this queue's worker or one of the others.
 */
export async function startMailSyncQueue(
  db: Kysely<DB>,
  redisUrl: string,
): Promise<MailSyncQueueHandle> {
  const connection = makeQueueConnection(redisUrl);
  const queue = new Queue(QUEUE_NAME, { connection });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { userId } = job.data as { userId: string };
      await syncAllUserMail(db, userId);
    },
    { connection, concurrency: env.MAIL_SYNC_QUEUE_CONCURRENCY },
  );
  logQueueErrors('mail sync queue', { queue, worker }, (m, meta) => logger.error(m, meta));
  worker.on('failed', (job, err) => {
    logger.warn('mail sweep failed for user', {
      userId: (job?.data as { userId?: string } | undefined)?.userId,
      err: err.message,
    });
  });

  return {
    enqueue: async (userId: string) => {
      const jobId = jobIdFor(userId);
      // A duplicate add() with an already-WAITING/DELAYED jobId is a no-op
      // in BullMQ, but an ACTIVE job with that id does not stop a second
      // add() from being silently dropped in every version -- check state
      // explicitly rather than trust add() alone (verified against a real
      // Redis before relying on this, not assumed).
      const existing = await queue.getJob(jobId);
      if (existing) {
        const state = await existing.getState();
        if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized') {
          return;
        }
      }
      await queue.add('sync', { userId }, { jobId, removeOnComplete: true, removeOnFail: true });
    },
    stop: async () => {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}
