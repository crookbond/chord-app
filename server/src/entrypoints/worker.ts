import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { applyMigrations } from '../db/migrate.js';
import { ensureDataDirs } from '../db/paths.js';
import { startWorkerRole } from '../roles/worker.js';
import { bootCrypto } from '../db/crypto/master-key.js';
import { stopOnSignal } from './stop-on-signal.js';

/**
 * Production entrypoint for the worker role (ADR 0172). Runs as its own
 * systemd unit (`chord-worker.service`), separate from the web role
 * (`chord.service`) — see `roles/worker.ts` for what this owns.
 */
async function main() {
  await bootCrypto();
  ensureDataDirs();
  const db = openDb();
  await applyMigrations(db);

  const worker = await startWorkerRole(db);
  logger.info('chord worker started');

  stopOnSignal('worker', () => worker.stop());
}

main().catch((err) => {
  logger.error('fatal during worker startup', { err });
  process.exit(1);
});
