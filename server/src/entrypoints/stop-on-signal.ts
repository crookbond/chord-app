import { logger } from '../config/logging.js';

/**
 * Stops a role once on SIGINT/SIGTERM and exits 0, so systemd records a
 * requested stop as a success and the crash reporter (ADR 0227) stays quiet.
 * A second signal while stopping (systemd and an operator, or Ctrl-C twice)
 * waits for the first stop instead of running it again. A stop that throws
 * exits 1: that is a real failure worth reporting.
 */
export function stopOnSignal(
  role: string,
  stop: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
): (sig: string) => Promise<void> {
  let stopping: Promise<void> | null = null;
  const handle = (sig: string): Promise<void> => {
    if (stopping) return stopping;
    logger.info(`${role}: shutting down (${sig})`);
    stopping = stop().then(
      () => exit(0),
      (err: unknown) => {
        logger.error(`${role}: shutdown failed`, { err });
        exit(1);
      },
    );
    return stopping;
  };
  process.on('SIGINT', () => void handle('SIGINT'));
  process.on('SIGTERM', () => void handle('SIGTERM'));
  return handle;
}
