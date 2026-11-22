/**
 * Load-test server: the real web + worker roles on a throwaway database, with
 * every outside dependency replaced by a mock that keeps a realistic round-trip
 * time (LLM, Google Calendar, Gmail), and instrumentation wrapped AROUND the
 * app rather than built into it.
 *
 *   tsx scripts/load/server.ts            (LOAD_FRESH=1 to drop + recreate the DB)
 *
 * Control plane, under /__load (never mounted by the real server):
 *   GET  /report          route + SQL + process stats since the last reset
 *   POST /reset           clear the stats
 *   POST /connect         { userId } give a user mock Gmail + calendar access
 *   POST /mail            { userId, n, kind? } deliver new mock mail
 *   POST /profile/start   begin a V8 CPU profile
 *   POST /profile/stop    end it, write <LOAD_OUT_DIR>/server.cpuprofile
 *   POST /shutdown
 */
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// ── environment, before anything reads it ────────────────────────────────────
function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of ['../.env.local', '../.env']) {
    try {
      for (const line of fs.readFileSync(path.resolve(process.cwd(), f), 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !(m[1]! in out)) out[m[1]!] = m[2]!.trim();
      }
    } catch {
      /* optional */
    }
  }
  return out;
}

const fileEnv = readEnvFile();
const seedUrl = process.env.LOAD_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL ?? '';
if (!seedUrl) throw new Error('set LOAD_DATABASE_URL (or TEST_DATABASE_URL in .env.local)');
const dbName = process.env.LOAD_DB_NAME ?? 'chord_perf';
if (!/_(perf|load)$/.test(dbName)) {
  throw new Error(`refusing to run against "${dbName}": the load DB name must end in _perf or _load`);
}
const adminUrl = seedUrl.replace(/\/[^/?]*(\?.*)?$/, '/postgres');
const loadUrl = seedUrl.replace(/\/[^/?]*(\?.*)?$/, `/${dbName}`);

const setDefault = (k: string, v: string) => {
  if (process.env[k] === undefined) process.env[k] = v;
};
process.env.DATABASE_URL = loadUrl;
setDefault('NODE_ENV', 'development');
setDefault('LLM_PROVIDER', 'mock');
setDefault('AUTH_MODE', 'demo');
setDefault('GMAIL_ENABLED', 'true');
setDefault('GMAIL_PROVIDER', 'mock');
setDefault('EMAIL_CLASSIFIER', 'llm');
setDefault('RATE_LIMIT_ENABLED', 'false');
setDefault('DEMO_MODE', '0');
setDefault('LOG_LEVEL', 'info');
setDefault('SERVER_PORT', '4002');
setDefault('SERVER_HOST', '127.0.0.1');
setDefault('GOOGLE_CLIENT_ID', 'load-test-client');
setDefault('GOOGLE_CLIENT_SECRET', 'load-test-secret');
setDefault('LOGS_DIR', path.resolve(process.cwd(), '../logs-load'));
setDefault('DATA_DIR', path.resolve(process.cwd(), '../data-load'));
setDefault('PUSH_ENABLED', 'false');
setDefault('BILLING_ENABLED', 'false');
setDefault('WEATHER_PROVIDER', 'mock');
// Refresh tokens are stored sealed, so the connect step needs a key. Throwaway.
setDefault('MASTER_KEY', Buffer.alloc(32, 9).toString('base64'));

const OUT_DIR = process.env.LOAD_OUT_DIR ?? path.resolve(process.cwd(), '../logs-load/out');
fs.mkdirSync(OUT_DIR, { recursive: true });

const num = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);

async function main() {
  const pg = (await import('pg')).default;

  if (process.env.LOAD_FRESH === '1') {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    // Autovacuum may be working in the database we are dropping, and FORCE cannot
    // terminate it (a different role owns that process): wait it out and retry.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query(`drop database if exists ${dbName} with (force)`);
        break;
      } catch (err) {
        if (attempt >= 15) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await admin.query(`create database ${dbName}`);
    // e.g. LOAD_DB_SETTINGS="synchronous_commit=off,jit=off": per-database, no restart.
    for (const kv of (process.env.LOAD_DB_SETTINGS ?? '').split(',').filter(Boolean)) {
      const [k, v] = kv.split('=');
      await admin.query(`alter database ${dbName} set ${k} = '${v}'`);
      console.log(`[load-server] ${dbName}: ${k} = ${v}`);
    }
    await admin.end();
    fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
    console.log(`[load-server] recreated ${dbName}`);
  }

  // Watch every pool the app opens, without editing the app: db/index.ts reads
  // `pg.Pool` at import time, so swap it in first.
  const trace = await import('./perf-trace.js');
  const RealPool = pg.Pool;
  let poolSeq = 0;
  (pg as unknown as { Pool: unknown }).Pool = class extends RealPool {
    constructor(cfg?: ConstructorParameters<typeof RealPool>[0]) {
      super(cfg);
      trace.watchPool(`pool${poolSeq++}`, this);
    }
  };

  // Mock round-trip times. Zero would measure only our own CPU, which flatters
  // everything that waits on an outside service in production.
  const { MockLlmService } = await import('../../src/services/llm/mock.service.js');
  const firstToken = num('LOAD_LLM_FIRST_TOKEN_MS', 700);
  const completeMs = num('LOAD_LLM_COMPLETE_MS', 500);
  const wordMs = num('LOAD_LLM_WORD_MS', 20);
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * (0.7 + Math.random() * 0.6)));
  const realComplete = MockLlmService.prototype.complete;
  MockLlmService.prototype.complete = async function (this: unknown, ...a: Parameters<typeof realComplete>) {
    await sleep(completeMs);
    return realComplete.apply(this as never, a);
  };
  const realStream = MockLlmService.prototype.stream;
  MockLlmService.prototype.stream = async function* (this: unknown, ...a: Parameters<typeof realStream>) {
    await sleep(firstToken);
    for await (const c of realStream.apply(this as never, a)) {
      yield c;
      if (wordMs !== 20) await sleep(wordMs - 20 > 0 ? wordMs - 20 : 0);
    }
  };

  const { installFakeGoogle, fakeGoogleStats, resetFakeGoogleStats } = await import('./fake-google.js');
  installFakeGoogle({ latencyMs: num('LOAD_GOOGLE_LATENCY_MS', 80) });

  const { logger } = await import('../../src/config/logging.js');
  const { openDb } = await import('../../src/db/index.js');
  const { applyMigrations } = await import('../../src/db/migrate.js');
  const { ensureDataDirs } = await import('../../src/db/paths.js');
  const { buildApp } = await import('../../src/app.js');
  const { initBotPersonas } = await import('../../src/services/bot-personas.service.js');
  const { registerEnabledConnectors } = await import('../../src/services/connectors/init.js');
  const { connectorRegistry } = await import('../../src/services/connectors/registry.js');
  const { startWorkerRole } = await import('../../src/roles/worker.js');
  const { sseHub } = await import('../../src/services/sse.hub.js');
  const { persistRefreshToken } = await import('../../src/services/google/oauth.service.js');
  const { __pushGmailMockArrival } = await import('../../src/services/google/gmail-api.js');
  const express = (await import('express')).default;

  ensureDataDirs();
  const db = openDb({ log: trace.kyselyLog });
  const tMig = performance.now();
  await applyMigrations(db);
  console.log(`[load-server] migrations ${(performance.now() - tMig).toFixed(0)} ms`);

  await initBotPersonas(db);
  const inner = buildApp(db);
  registerEnabledConnectors(db);
  await connectorRegistry.initializeAll(db);

  // ── control plane ──────────────────────────────────────────────────────────
  const { mailFor } = await import('./mail-fixtures.js');
  const control = express.Router();
  control.use(express.json({ limit: '1mb' }));

  control.get('/report', (_req, res) => {
    res.json({ ...trace.report(), google: fakeGoogleStats().calls });
  });
  control.post('/reset', (_req, res) => {
    trace.reset();
    resetFakeGoogleStats();
    res.json({ ok: true });
  });
  control.post('/connect', async (req, res, next) => {
    try {
      const ids: string[] = req.body.userIds ?? [req.body.userId];
      const scopes =
        'openid email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify';
      for (const id of ids) await persistRefreshToken(db, id, `load-refresh-${id}`, scopes);
      res.json({ connected: ids.length });
    } catch (err) {
      next(err);
    }
  });
  control.post('/mail', (req, res) => {
    const { userId, n = 1, kind } = req.body as { userId: string; n?: number; kind?: string };
    for (let i = 0; i < n; i++) __pushGmailMockArrival(userId, mailFor(userId, kind));
    res.json({ delivered: n });
  });

  let session: inspector.Session | null = null;
  control.post('/profile/start', (_req, res) => {
    session = new inspector.Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: 250 });
    session.post('Profiler.start');
    res.json({ ok: true });
  });
  control.post('/profile/stop', (_req, res) => {
    if (!session) {
      res.status(409).json({ error: 'not profiling' });
      return;
    }
    const s = session;
    session = null;
    s.post('Profiler.stop', (err, { profile }) => {
      if (err) {
        res.status(500).json({ error: String(err) });
        return;
      }
      const file = path.join(OUT_DIR, 'server.cpuprofile');
      fs.writeFileSync(file, JSON.stringify(profile));
      s.disconnect();
      res.json({ file });
    });
  });
  control.post('/shutdown', (_req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 200);
  });

  const outer = express();
  outer.set('trust proxy', 1);
  outer.use('/__load', control);
  outer.use(trace.timingMiddleware);
  outer.use(inner);

  const worker = await startWorkerRole(db);
  trace.startSampler();

  const port = Number(process.env.SERVER_PORT);
  const server = outer.listen(port, process.env.SERVER_HOST!, () => {
    logger.info(`load server on http://${process.env.SERVER_HOST}:${port} (db ${dbName})`);
    console.log(`[load-server] ready on :${port}`);
  });
  // Hundreds of long-lived SSE sockets plus bursts of new ones.
  server.keepAliveTimeout = 65_000;

  const stop = async () => {
    await worker.stop().catch(() => undefined);
    sseHub.closeAll('shutdown');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('[load-server] fatal', err);
  process.exit(1);
});
