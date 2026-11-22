import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { applyMigrations } from '../db/migrate.js';
import { ensureDataDirs } from '../db/paths.js';
import { startWebRole } from '../roles/web.js';
import { bootCrypto } from '../db/crypto/master-key.js';
import { stopOnSignal } from './stop-on-signal.js';

/**
 * Production entrypoint for the web role (ADR 0172). Runs as its own
 * systemd unit (`chord.service`), separate from the worker role
 * (`chord-worker.service`) — see `roles/web.ts` for what this owns.
 */
async function main() {
  await bootCrypto();
  ensureDataDirs();
  const db = openDb();
  await applyMigrations(db);

  const web = await startWebRole(db);

  stopOnSignal('web', () => web.stop());
}

main().catch((err) => {
  logger.error('fatal during web startup', { err });
  process.exit(1);
});
