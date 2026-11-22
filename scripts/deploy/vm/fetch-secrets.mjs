// ExecStartPre for chord.service and chord-worker.service (ADR 0211), run as root:
//   ExecStartPre=+/usr/bin/env node /usr/local/lib/chord/fetch-secrets.mjs
// Fetches the named secrets from Secret Manager into a tmpfs file that systemd reads as an
// EnvironmentFile. The values never touch the persistent disk. Prints names and counts, never values.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { fetchAll, parseKeysFile, renderEnvFile } from './secrets-lib.mjs';

const KEYS_FILE = process.env.CHORD_SECRET_KEYS ?? '/usr/local/lib/chord/secret-keys.txt';
const DIR = process.env.CHORD_SECRETS_DIR ?? '/run/chord-secrets';
const OUT = `${DIR}/secrets.env`;
// A restart during a Secret Manager blip may reuse the last good file for this long. A reboot clears
// /run, so a cold start can never run on stale secrets.
const REUSE_MAX_MS = 30 * 24 * 3600 * 1000;

function lastGoodFile() {
  try {
    return existsSync(OUT) && Date.now() - statSync(OUT).mtimeMs < REUSE_MAX_MS;
  } catch {
    return false;
  }
}

async function main() {
  const names = parseKeysFile(readFileSync(KEYS_FILE, 'utf8'));
  if (names.length === 0) {
    console.log('fetch-secrets: no secrets listed, nothing to do');
    return;
  }
  const { entries, failures } = await fetchAll({ names });
  if (failures.length) {
    for (const f of failures) console.error(`fetch-secrets: ${f}`);
    if (lastGoodFile()) {
      console.error('fetch-secrets: WARNING using the previous secrets file from this boot; fix the errors above');
      return;
    }
    console.error('fetch-secrets: refusing to start without every listed secret');
    process.exit(1);
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const tmp = `${OUT}.${process.pid}.tmp`;
  writeFileSync(tmp, renderEnvFile(entries), { mode: 0o600 });
  renameSync(tmp, OUT);
  console.log(`fetch-secrets: wrote ${entries.length} secrets (${entries.map(([n]) => n).join(', ')})`);
}

main().catch((err) => {
  console.error(`fetch-secrets: ${err.message}`);
  process.exit(1);
});
