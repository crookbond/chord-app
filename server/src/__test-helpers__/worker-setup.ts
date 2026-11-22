/**
 * Per-worker vitest setup (registered via `setupFiles`).
 *
 * Integration tests fire-and-forget some async DB work — bot reactions, the
 * two-way Google Calendar push, catchup fan-out — that can still be in flight
 * when a test's `afterEach` runs `closeTestDb` (which destroys the Kysely
 * driver and DROPs the per-test database WITH FORCE). When that late work
 * lands on the torn-down connection it rejects/throws a *benign* error:
 * "driver has already been destroyed", a pg pool-after-end, or a terminated
 * connection. The query promises themselves are caught at their call sites,
 * but the pool/driver can still surface these as a process-level
 * unhandledRejection/uncaughtException — and an unhandled one crashes the
 * forked worker. The parent pool then fails the whole run with
 * ERR_IPC_CHANNEL_CLOSED and *zero* actual test failures.
 *
 * Swallow ONLY those known-benign post-teardown shapes so they can't kill the
 * worker; re-throw everything else so genuine errors still fail the run.
 */
const BENIGN_PATTERNS: RegExp[] = [
  /driver has already been destroyed/i,
  /Cannot use a pool after calling end/i,
  /Connection terminated/i,
  /terminating connection due to administrator command/i,
  /the database system is shutting down/i,
  /Client has encountered a connection error and is not queryable/i,
  /Called end on pool more than once/i,
];

function isBenignTeardownError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? '';
  if (code === 'ERR_IPC_CHANNEL_CLOSED' || code === '57P01') return true;
  const msg =
    err instanceof Error ? `${err.message}` : typeof err === 'string' ? err : String(err);
  return BENIGN_PATTERNS.some((re) => re.test(msg));
}

process.on('unhandledRejection', (reason) => {
  if (isBenignTeardownError(reason)) return;
  // Preserve vitest's default behaviour for real failures.
  throw reason;
});

process.on('uncaughtException', (err) => {
  if (isBenignTeardownError(err)) return;
  throw err;
});
