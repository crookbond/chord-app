// Run one command with the app's full environment, for operator tasks on the VM (ADR 0211):
//   chord-with-env npm run migrate
//   chord-with-env npm run wrap:master-key --workspace=server
// The app's non-secret settings come from /srv/chord/.env and its secrets from Secret Manager, both
// held only in the child's memory (nothing is written to disk). Started by the wrapper under sudo so
// it can read the secrets; the command itself is dropped back to the invoking user.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { fetchAll, parseEnvFile, parseKeysFile } from './secrets-lib.mjs';

const APP_DIR = process.env.CHORD_APP_DIR ?? '/srv/chord';
const KEYS_FILE = process.env.CHORD_SECRET_KEYS ?? '/usr/local/lib/chord/secret-keys.txt';

async function main() {
  const cmd = process.argv.slice(2);
  if (cmd.length === 0) {
    console.error('usage: chord-with-env <command> [args...]');
    process.exit(2);
  }
  const uid = Number(process.env.SUDO_UID);
  const gid = Number(process.env.SUDO_GID);
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0) {
    console.error('chord-with-env: run it as your own user (it uses sudo itself); refusing to run the command as root');
    process.exit(2);
  }

  const env = {
    PATH: `${APP_DIR}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : '/tmp',
    NODE_ENV: 'production',
    DATA_DIR: '/var/lib/chord/data',
    LOGS_DIR: '/var/lib/chord/logs',
  };
  const envFile = `${APP_DIR}/.env`;
  if (existsSync(envFile)) for (const [k, v] of parseEnvFile(readFileSync(envFile, 'utf8'))) env[k] = v;

  if (existsSync(KEYS_FILE)) {
    const names = parseKeysFile(readFileSync(KEYS_FILE, 'utf8'));
    const { entries, failures } = await fetchAll({ names });
    if (failures.length) {
      for (const f of failures) console.error(`chord-with-env: ${f}`);
      process.exit(1);
    }
    for (const [k, v] of entries) env[k] = v;
  }

  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env, uid, gid, cwd: process.cwd() });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (err) => {
    console.error(`chord-with-env: could not start ${cmd[0]}: ${err.message}`);
    process.exit(127);
  });
}

main().catch((err) => {
  console.error(`chord-with-env: ${err.message}`);
  process.exit(1);
});
