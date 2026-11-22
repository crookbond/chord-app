/**
 * One full load cycle: fresh throwaway DB + server, the driver, then the
 * profile analysis. Everything lands in <logs-load>/<name>/.
 *
 *   tsx scripts/load/cycle.ts <name> [driver args...] [-- server env K=V ...]
 *
 * Example: tsx scripts/load/cycle.ts i2 --users 500 --levels 8000,3000 --profile-level 1
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const [name, ...rest] = process.argv.slice(2);
if (!name) throw new Error('usage: cycle.ts <name> [driver args] [-- K=V ...]');
const dashIdx = rest.indexOf('--');
const driverArgs = dashIdx >= 0 ? rest.slice(0, dashIdx) : rest;
const serverEnv = Object.fromEntries(
  (dashIdx >= 0 ? rest.slice(dashIdx + 1) : []).map((kv) => [kv.split('=')[0]!, kv.split('=').slice(1).join('=')]),
);

const out = path.resolve(process.cwd(), '../logs-load', name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const BASE = 'http://127.0.0.1:4002';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isWin = process.platform === 'win32';
const tsx = isWin ? 'npx.cmd' : 'npx';

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(BASE + '/api/v1/health', { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function attempt(n: number): Promise<number> {
  if (await healthy()) {
    await fetch(BASE + '/__load/shutdown', { method: 'POST' }).catch(() => undefined);
    await sleep(2500);
  }

  const serverLog = fs.openSync(path.join(out, 'server.out'), 'w');
  const server = spawn(tsx, ['tsx', 'scripts/load/server.ts'], {
    env: {
      ...process.env,
      LOAD_FRESH: '1',
      LOAD_OUT_DIR: out,
      NODE_OPTIONS: `--report-on-fatalerror --report-directory=${out}`,
      ...serverEnv,
    },
    stdio: ['ignore', serverLog, serverLog],
    shell: isWin,
    windowsHide: true,
  });
  for (let i = 0; i < 120 && !(await healthy()); i++) await sleep(1000);
  if (!(await healthy())) throw new Error('server did not come up; see ' + path.join(out, 'server.out'));
  console.log(`[cycle ${name}] attempt ${n}: server up`);

  const driverLog = fs.openSync(path.join(out, 'driver.out'), 'w');
  const driver = spawn(tsx, ['tsx', 'scripts/load/run.ts', '--out', out, '--keep-server', ...driverArgs], {
    env: { ...process.env, NODE_OPTIONS: `--report-on-fatalerror --report-directory=${out}` },
    stdio: ['ignore', driverLog, driverLog],
    shell: isWin,
    windowsHide: true,
  });
  const code: number = await new Promise((r) => driver.on('exit', (c) => r(c ?? 1)));
  console.log(`[cycle ${name}] attempt ${n}: driver exit ${code}`);

  await fetch(BASE + '/__load/shutdown', { method: 'POST' }).catch(() => undefined);
  await sleep(1500);
  server.kill();
  return code;
}

/**
 * The driver has died natively (exit 0xC0000409, no message, no report) at
 * random moments under load at 500 users, in roughly half of runs. It is the
 * client, not the app; until that is understood, a crashed attempt is rerun
 * from a fresh database so a cycle yields a result. Each attempt keeps its log.
 */
const MAX_ATTEMPTS = 3;

async function main() {
  let code = 1;
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    code = await attempt(n);
    if (code === 0) break;
    for (const f of ['driver.out', 'server.out']) {
      if (fs.existsSync(path.join(out, f))) fs.renameSync(path.join(out, f), path.join(out, `attempt${n}-${f}`));
    }
    for (const f of fs.readdirSync(out)) if (/^level-|^setup|^mega|^summary/.test(f)) fs.rmSync(path.join(out, f));
  }

  const prof = path.join(out, 'server.cpuprofile');
  if (code === 0 && fs.existsSync(prof)) {
    const r = spawnSync(tsx, ['tsx', 'scripts/load/analyze-profile.ts', prof, '30'], { encoding: 'utf8', shell: isWin });
    fs.writeFileSync(path.join(out, 'profile.txt'), r.stdout + r.stderr);
  }
  console.log(`[cycle ${name}] done (exit ${code}) -> ${out}`);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
