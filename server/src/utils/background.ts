/**
 * Work started without awaiting it (a calendar push after a create, the To
 * Do's mirror, a key-health write). It runs exactly as before; a test can now
 * wait for it to finish instead of sleeping a guessed number of milliseconds,
 * which passes on a fast machine and fails on a loaded CI runner.
 */
import { logger } from '../config/logging.js';

const pending = new Set<Promise<unknown>>();

/** Nobody awaits this work, so a failure is logged here or nowhere: callers
 *  that handle their own errors pass an already-caught promise. */
export function runInBackground(work: Promise<unknown>, label = 'background work'): void {
  const tracked = work.then(
    () => undefined,
    (err: unknown) => {
      logger.error(`${label} failed`, {
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    },
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Resolves once nothing started with runInBackground is still running,
 *  including work started by the work being waited for. */
export async function settleBackgroundWork(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
