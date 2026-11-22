import Redis from 'ioredis';

/**
 * One ioredis connection factory for BullMQ (queues/workers only). Always
 * its own connection, never shared with the SSE hub's Redis clients
 * (`services/sse.hub.ts`, ADR 0170) — mixing a subscribe connection with
 * blocking/data commands causes cross-talk between the two systems.
 *
 * `maxRetriesPerRequest: null` is a hard BullMQ requirement: without it,
 * the blocking commands BullMQ relies on throw on any transient Redis
 * hiccup instead of blocking correctly.
 */
export function makeQueueConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

/** How often a worker's repeated error is written while it keeps failing. */
export const QUEUE_ERROR_LOG_INTERVAL_MS = 60_000;

/**
 * A handler for a BullMQ worker's `error` event that cannot flood the log.
 *
 * A worker whose Redis refuses commands (out of memory, cannot persist) emits
 * `error` on every poll, with no pause, for as long as the condition lasts.
 * Logged one line each, three workers wrote 23 GB in three hours and filled
 * the disk, which took the whole service down for a fault that had only
 * stopped background jobs. So: the first error is written at once, and after
 * that at most one line per interval, carrying how many were left out.
 *
 * The line carries the error's message. ioredis reply errors keep it on a
 * non-enumerable property, so logging the object printed the command's
 * arguments and not the one sentence that said what was wrong.
 */
export function queueErrorLogger(
  message: string,
  log: (message: string, meta: Record<string, unknown>) => void,
  now: () => number = Date.now,
): (err: unknown) => void {
  let lastAt: number | null = null;
  let suppressed = 0;
  return (err) => {
    const at = now();
    if (lastAt !== null && at - lastAt < QUEUE_ERROR_LOG_INTERVAL_MS) {
      suppressed += 1;
      return;
    }
    log(message, {
      err: err instanceof Error ? err.message : String(err),
      ...(suppressed > 0 ? { suppressedSinceLast: suppressed } : {}),
    });
    lastAt = at;
    suppressed = 0;
  };
}

/**
 * Throttled `error` logging on every BullMQ object that emits it (Queue,
 * QueueEvents, Worker). An EventEmitter with no `error` listener THROWS the
 * error, which kills the process (the shape of ADR 0227's imapflow crash): a
 * Queue or QueueEvents whose Redis connection drops would take the role down
 * instead of reconnecting. Each emitter gets its own throttle.
 */
export function logQueueErrors(
  label: string,
  emitters: Record<string, { on(event: 'error', fn: (err: Error) => void): unknown }>,
  log: (message: string, meta: Record<string, unknown>) => void,
): void {
  for (const [kind, emitter] of Object.entries(emitters)) {
    emitter.on('error', queueErrorLogger(`${label} ${kind} error`, log));
  }
}

