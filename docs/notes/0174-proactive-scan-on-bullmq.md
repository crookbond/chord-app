# 0174 — Proactive scan on a BullMQ job queue

**Status**: accepted — implemented (Phase 3 of the scaling effort started by ADR 0170/0172)
**Date**: 2026-09-15

## Context

`startProactiveScheduler` (`server/src/services/proactive.service.ts`)
runs the daily-briefing/nudge/mailbox-sweep pipeline on a plain
`setInterval` loop guarded by an in-process `inFlight` boolean. That
guard is a single-process concept: if the worker role (ADR 0172) ever
ran on more than one instance, every instance would independently poll
`proactive_messages` on the same schedule and race to fire the same due
rows — there is no cross-process claim mechanism today.

This is the lowest-risk of the three AI-work queues named in the
original scaling plan (proactive-scan, mail-sync, bot-turn) — one
scheduled batch job, no per-item fan-out, easiest to verify against
`drainOnce`'s existing, unchanged semantics.

## Decision

Replace the `setInterval` + `inFlight` pair with a BullMQ repeatable job
when `REDIS_URL` is set, via `queue.upsertJobScheduler` — BullMQ v6's Job
Scheduler API (the older `add(..., {repeat})` + `removeRepeatable` pair
this session initially wrote against no longer exists in the installed
`bullmq@^6` and doesn't typecheck; confirmed against the library's own
`.d.ts` files, not guessed). A repeatable job registered under a fixed
scheduler id is inherently single-flight cluster-wide — the direct fix
for "N worker instances would each independently poll and race" — with
no leader-election code of our own.

- New `server/src/services/proactive.queue.ts`: `startProactiveQueue(db,
  redisUrl)` seeds today's daily-scan rows (`seedDailyScan`, same
  one-time call the old scheduler made), registers the repeatable
  scheduler (`every: env.PROACTIVE_TICK_MS`), and starts a BullMQ
  `Worker` with `concurrency: 1` whose processor calls the existing,
  unchanged `drainOnce(db)`.
- `roles/worker.ts` branches on `env.REDIS_URL`: set → the new queue;
  unset → the original `startProactiveScheduler`. Dev, CI, and `npm run
  sim` keep needing zero Redis, matching every other `REDIS_URL`-gated
  fallback introduced alongside ADR 0170.
- **A non-blocking session-scoped advisory lock (`withDrainLock`) wraps
  every drain pass**, independent of BullMQ's own repeat/concurrency
  guarantees. `concurrency: 1` already prevents overlap *within one
  worker process*, but the lock is the correctness backstop for once the
  worker role scales past one instance (two different worker processes,
  two different scheduled occurrences, each legitimately claimed by
  BullMQ's own atomic job-claiming — which prevents double-processing
  *the same* job but not two *different* occurrences running at once).
  `db.transaction()` is used purely to pin one Postgres connection for
  the lock's whole lifetime, not for its data-transaction semantics —
  `drainOnce` still runs against the ordinary `db` handle and commits its
  own writes independently.
- `stop()` deliberately does **not** call `removeJobScheduler` — this
  runs on every graceful shutdown, including an ordinary systemd
  restart, and removing the schedule would open a gap where no tick is
  produced until the next process's `upsertJobScheduler` call runs.
  Leaving it in Redis is harmless: `upsertJobScheduler` is idempotent, so
  the next startup neither duplicates it nor needs the old one to still
  exist.

## Verification

- **The advisory lock's correctness is proven against real Postgres, not
  assumed.** `pg_advisory_lock`/`pg_try_advisory_lock` are scoped **per
  database**, not cluster-wide — verified empirically against a live
  instance (a session on a different database never contends, even with
  the identical two-int key; confirmed via `pg_locks`, whose `database`
  column carries a real OID for these rows) before writing the test.
  `openTestDb()`'s recycled handle is a single-connection (`max: 1`)
  pool, and its "nested call" escape hatch hands back a database
  **clone** — neither gives two sessions that can actually contend on
  the same database. `server/src/services/__tests__/proactive-drain-lock.test.ts`
  instead opens two raw connections to one shared, migration-free
  database (advisory locks need no schema) and proves both directions:
  a concurrent call is skipped while the lock is held, and a later call
  succeeds once it's released.
- **The BullMQ wiring itself is verified against a real Redis, not just
  typechecked.** No Redis server exists on this dev machine, so a
  throwaway smoke script used `redis-memory-server` (a real, portable
  Redis binary spun up for the one run, installed with `--no-save` and
  never committed) against the real `chord_test_proactive_bullmq`
  database. Result: `getJobSchedulers()` showed `iterationCount: 8` over
  a 3-second, 500ms-tick window (the schedule fires correctly),
  `getJobCounts()` showed `active` never exceeding 1 (the `Worker`'s
  `concurrency: 1` prevented overlap as designed), and `stop()` closed
  the worker/queue/connection without hanging. The only failures were
  `drainOnce` hitting "relation does not exist" against the
  intentionally schema-less smoke database — expected, not a defect.
- Full server test suite passes with `REDIS_URL` unset (the fallback
  path, unchanged from before this ADR).

## Alternatives considered

- **Trust BullMQ's repeat/concurrency semantics alone, no advisory
  lock** — rejected per the original plan's own instruction: verify the
  overlap behavior before relying on it as the *sole* mechanism. The
  smoke test above showed `concurrency: 1` behaving correctly for a
  single worker instance, but that guarantee stops being sufficient the
  moment the worker role scales past one instance — the lock is what
  extends correctness to that case without inventing new coordination.
- **Remove the job scheduler on every `stop()`** — rejected: creates a
  gap on ordinary restarts for no benefit, since `upsertJobScheduler` is
  idempotent and doesn't need the old registration cleared first.
- **A nested `openTestDb()` call for the second lock-test session** —
  looked like the obvious fix for "need two live databases" (the
  existing escape hatch's own docstring), and is wrong here specifically
  because advisory locks don't cross databases — confirmed by testing,
  not assumed, after an earlier draft of this test passed for the wrong
  reason (timing, not real contention) and had to be rewritten.
- **A guessed fixed delay to synchronize the two lock-test sessions** —
  tried first, failed unpredictably under real round-trip latency on a
  loaded dev machine; replaced with a deterministic `pg_locks` poll and,
  in the main contention test, restructuring so the non-blocking
  try-lock is awaited to completion before the lock-holder is released,
  removing the race outright rather than tuning a delay.

## Consequences

- `drainOnce`'s own semantics (20-row limit, sequential `fireOne`,
  trailing `archiveStaleTasks` + `sweepMailboxes`) are completely
  unchanged — this ADR only changes *how* and *how safely* the pass gets
  scheduled and run.
- No behavior change today: the worker role stays pinned to one instance
  (ADR 0172), so this is correctness insurance for later scaling, same
  framing as ADR 0172 itself.
- Mail-sync and bot-turn queues (the remaining two from the original
  scaling plan) are not addressed here.

## Addendum 2026-10-03 — a tick is removed once it has run

Prod went down for about three hours. The scheduler above was created with
no job options, and BullMQ keeps every completed job unless told otherwise.
One tick every 15 seconds is 5,760 a day; 98,468 had accumulated when Redis
reached its 128 MB limit (`maxmemory-policy noeviction`, which BullMQ needs)
and began refusing writes.

That alone would only have stopped background jobs. What took the service
down was the logging: each of the three queue workers emits `error` on every
poll while Redis refuses, with no pause, and each handler wrote one line.
23.5 GB of the same three lines filled the 30 GB disk in about three hours,
after which neither service could start (they could not open a log file) and
Redis could not save. The lines also said nothing useful — an ioredis reply
error keeps its message on a non-enumerable property, so the object printed
the command's arguments and not "OOM command not allowed".

- The tick's template now carries `removeOnComplete: true` and
  `removeOnFail: { count: 50 }` (`TICK_JOB_OPTS`). The mail-sync and bot-turn
  queues already removed both; this was the only queue that did not.
- On start the queue clears finished ticks left by a version that kept them.
- Every worker's `error` handler, and the SSE hub's two Redis connections,
  go through `queueErrorLogger` (`services/queue/redis.ts`): the first error
  is written at once, then at most one line a minute with a count of what was
  left out, carrying the error's message.

Not changed: log rotation is by age, not total size, so some other unbounded
writer could still fill the disk. There is no alert on disk space or on Redis
memory; either would have caught this days earlier.
