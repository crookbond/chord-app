import { defineConfig } from 'vitest/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Read .env.local so the test runner picks up the developer's
// `DATABASE_URL` credentials (password for windows-native PG, etc.).
// We can't piggyback on `server/src/config/env.ts`'s loader: vitest
// runs with NODE_ENV=test, which intentionally skips .env.local for
// *application* config. Test infrastructure still needs the DB URL,
// so we read it here and forward only what we need into the worker
// env block below.
//
// ESM has no `__dirname` — derive from `import.meta.url`. Without this,
// the dotenv call below silently fails and the default DB URL (no
// password) is used, which pg rejects with "client password must be a
// string" on a windows-native PG that needs auth.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(HERE, '..', '.env.local');

// Parse .env.local into a local object — do NOT call dotenv.config(),
// which would write every variable into process.env and pollute test
// workers (BOT_MENTION_ALIASES, AUTH_MODE, etc. would override what
// the test suite expects). We only want DATABASE_URL to compute the
// test DB URL.
let parsedLocal: Record<string, string> = {};
if (fs.existsSync(envLocalPath)) {
  parsedLocal = dotenv.parse(fs.readFileSync(envLocalPath, 'utf8'));
}
// Explicit TEST_DATABASE_URL wins as-is. Otherwise derive from
// DATABASE_URL by swapping the db name to chord_test.
//
// globalSetup runs in the *main* process, not workers, so the URL has
// to live on process.env (test.env only reaches workers). Without
// this, globalSetup would connect with no password and fail as
// "SCRAM: client password must be a string" on any PG that needs auth.
const explicitTestUrl =
  process.env.TEST_DATABASE_URL ?? parsedLocal.TEST_DATABASE_URL;
const databaseUrl = parsedLocal.DATABASE_URL ?? process.env.DATABASE_URL;
process.env.TEST_DATABASE_URL =
  explicitTestUrl ??
  (databaseUrl
    ? databaseUrl.replace(/\/([^/?]+)(\?|$)/, '/chord_test$2')
    : 'postgresql://chord@127.0.0.1:5432/chord_test');
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globals: false,
    include: [
      'src/**/__tests__/**/*.test.ts',
      'scripts/**/__tests__/**/*.test.ts',
    ],
    // Timing tests run alone, in `vitest.perf.config.ts`: beside four other
    // workers they measure the neighbours (ADR 0201).
    exclude: ['**/node_modules/**', 'src/**/__tests__/**/*perf*.test.ts'],
    environment: 'node',
    // Per-test database is template-cloned (~20-40ms) and PG round-trips
    // replace the old in-process SQLite calls. Stress tests with ~100
    // inserts can still cross 10s on a windows-native cluster.
    testTimeout: 30_000,
    // Each worker holds a long-lived admin pg.Client (see __test-helpers__/db.ts)
    // whose open socket keeps the worker event loop alive, so vitest force-
    // terminates workers at shutdown. That termination races the parent's
    // tinypool `send`, which surfaced as an intermittent ERR_IPC_CHANNEL_CLOSED
    // unhandled rejection that failed the run with zero test failures. Generous
    // teardown/hook windows let in-flight DROP DATABASE (WITH FORCE) and worker
    // shutdown settle before the pool gives up on them.
    teardownTimeout: 30_000,
    // `openTestDb` recycles one database per worker (see __test-helpers__/db.ts),
    // so the common hook empties it in place and finishes in ~23ms. The window
    // stays generous for the two paths that still issue a real CREATE DATABASE
    // — the first open in a worker, and a nested second handle — which measure
    // 2.4-7.4s each and are what blew the old 30s ceiling under load.
    hookTimeout: 120_000,
    // Explicit so a future vitest default can't silently switch pools under us.
    // `threads` was measured on the same 12-file subset and came out slower
    // (483s vs 402s); `isolate: false` is faster still on paper but crashes the
    // run with "Terminating worker thread", so it is deliberately not used.
    pool: 'forks',
    // Worker count was pinned at 2 while every test paid a ~1s database reset —
    // the cluster saturated, and going wider made each test slower by almost as
    // much as the extra parallelism bought. With the reset down to ~23ms that
    // ceiling is gone: on 6 cores, 5 workers measured 103s against 130s at 2,
    // with per-test time unchanged. Top-level since Vitest 4, which silently
    // ignores the old `poolOptions.forks.maxForks` and falls back to cores - 1:
    // ONE worker on CI's 2-core runner. CI passes `--maxWorkers` per shard.
    maxWorkers: 5,
    globalSetup: ['./src/__test-helpers__/global-setup.ts'],
    // Per-worker guard that swallows benign post-teardown DB errors so a stray
    // late rejection can't crash a forked worker (which the parent pool then
    // reports as ERR_IPC_CHANNEL_CLOSED with zero real test failures).
    setupFiles: ['./src/__test-helpers__/worker-setup.ts', './src/__test-helpers__/clock-probe.ts'],
    // Force the mock LLM + deterministic log level for integration tests.
    // Must be set here so `config/env.ts` picks them up on first import.
    // NODE_ENV=test gates the `.env.local` skip in `config/env.ts` so
    // per-developer overrides (alias renames, AUTH_MODE swaps, etc.)
    // don't leak into the test suite.
    env: {
      NODE_ENV: 'test',
      LLM_PROVIDER: 'mock',
      LOG_LEVEL: 'warn',
      // The image preload (ADR 0225) starts un-awaited behind every sync and
      // fetches from the network; a test that wants it turns it on itself.
      EMAIL_IMAGE_PRELOAD: 'false',
      // ADR 0283 — the consent tests turn it on; everything else tests the
      // feature it covers, not the consent gate.
      AI_CONSENT_REQUIRED: 'false',
      TEST_DATABASE_URL,
    },
  },
  resolve: {
    alias: {
      '@chord/kernel': path.resolve(HERE, '../kernel/src/index.ts'),
      '@chord/kernel/': path.resolve(HERE, '../kernel/src/') + '/',
      '@': path.resolve(HERE, 'src'),
    },
  },
});
