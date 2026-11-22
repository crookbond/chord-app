import { logger } from './config/logging.js';
import { openDb } from './db/index.js';
import { applyMigrations } from './db/migrate.js';
import { ensureDataDirs } from './db/paths.js';
import { startWebRole } from './roles/web.js';
import { startWorkerRole } from './roles/worker.js';
import { bootCrypto } from './db/crypto/master-key.js';
import { stopOnSignal } from './entrypoints/stop-on-signal.js';

/**
 * Dev/CI/sim entrypoint only (ADR 0172). Runs both the web and worker
 * roles in one process against one shared `db` handle, matching this
 * repo's pre-split behavior exactly — `npm run dev`, `npm run sim`, and
 * vitest need no changes to how they invoke the server. Production runs
 * `entrypoints/web.ts` and `entrypoints/worker.ts` as two systemd units.
 */
async function main() {
  await bootCrypto();
  ensureDataDirs();
  const db = openDb();
  await applyMigrations(db);

  const web = await startWebRole(db);
  const worker = await startWorkerRole(db);

  stopOnSignal('server', async () => {
    await worker.stop();
    await web.stop();
  });
}

main().catch((err) => {
  logger.error('fatal during startup', { err });
  process.exit(1);
});
