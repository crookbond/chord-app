# 0176 — Mail sync on a BullMQ job queue

**Status**: accepted — implemented (Phase 4 of the scaling effort started by ADR 0170/0172/0174)
**Date**: 2026-09-15

## Context

`sweepMailboxes` (`server/src/services/email/mirror-sweep.ts`) selects up
to `MAIL_SWEEP_BATCH` (20) stale mailboxes per tick and syncs them
**sequentially, one at a time** — each user's whole mailbox sync (Gmail
plus every attached account) finishes before the next one starts. That's
today's de-facto rate limiter: only one mailbox's worth of Gmail/IMAP/LLM-
classifier calls is ever in flight from the sweep. It's also the batch's
throughput ceiling — a handful of slow mailboxes push everyone behind them
further from their own 5-minute freshness window.

## Decision

`sweepMailboxes` hands each candidate to a registered enqueuer when one
exists (`REDIS_URL` set), falling back to the original direct,
sequential call otherwise — same `REDIS_URL`-gated pattern as every
other phase since ADR 0170.

- New `server/src/services/email/mail-sync.queue.ts`:
  `startMailSyncQueue(db, redisUrl)` runs a BullMQ `Worker` with
  `concurrency: env.MAIL_SYNC_QUEUE_CONCURRENCY` (default 3) whose
  processor calls the existing `syncAllUserMail(db, userId)` — a function
  that already existed (`accounts.service.ts`, used today by the Email
  tab's force-sync route) and is *exactly* what `sweepMailboxes`'s old
  inline loop body duplicated (`withMailSyncRound` wrapping
  `maybeSyncGmail` + `maybeSyncAccounts(..., 'full')`). Reusing it instead
  of re-inlining the same three lines a second time was a small
  simplification found while implementing, not part of the original plan.
- `mirror-sweep.ts` gains `setMailSyncEnqueuer(fn | null)` — an injected
  capability, not an import, mirroring ADR 0118's
  `setMailboxSyncRunner` indirection exactly (same shape, same reason:
  keep this module below the provider/queue services in the dependency
  order). `roles/worker.ts` calls it with the queue's `enqueue` function
  when `REDIS_URL` is set, and with `null` on shutdown.
- Job key is `mailsync_${userId}` — **user-scoped**, deliberately narrow.
  It replaces nothing existing; it solves exactly one problem the old
  code didn't have and the queue introduces: the sweep re-selecting a
  user whose previous sweep-triggered sync is still running (and so
  hasn't updated `gmail_synced_at` yet) before the next tick's
  `dueForSweep` query runs again.
- `MAIL_SWEEP_BATCH` keeps its existing meaning ("how many stale
  mailboxes to consider per tick"); new `MAIL_SYNC_QUEUE_CONCURRENCY`
  (default 3, only meaningful with `REDIS_URL` set) now governs how many
  of them actually sync *at once* — a genuine behavior change from full
  sequential, worth watching provider rate-limit headroom on before
  raising further.

## Correcting the original plan's assumption

The plan written before touching this code claimed the new queue would
"replace" `accountSyncs` (`accounts.service.ts`, per-**account**,
ADR 0080's Yahoo-throttle fix) and the outer layer of
`mailSyncRounds`/`afterSyncRuns` (`gmail.service.ts`, per-**user** round
and concurrent-call coalescing). Reading the actual code first showed
that's wrong, and building on the wrong premise would have quietly
weakened protection that's still load-bearing:

- Both existing mechanisms protect a **wider** axis than the new queue
  does — *several different call paths* (this sweep, the Email tab's
  `syncAllUserMail` route, the daily-briefing scan's own direct
  `maybeSyncAccounts`/`maybeSyncGmail` calls in `proactive.service.ts`)
  all reaching the same user's or account's sync at once. The new
  per-user job-id dedup only ever sees calls that go through *this*
  queue — it has no visibility into a route handler or the daily scan
  calling the same functions directly.
- The job processor still calls `syncAllUserMail`, which still opens a
  `withMailSyncRound` and still calls `syncAccount` per attached
  account — so every one of `accountSyncs`, `mailSyncRounds`, and
  `afterSyncRuns` keeps doing exactly what it did before, for exactly
  the reason it was added, regardless of whether the caller is this
  queue's worker, a route handler, or the daily scan. None of them
  needed to change.

## Verification

Two things were checked against real infrastructure rather than assumed,
because Phase 3 (ADR 0174) had already shown that guessing at BullMQ's
exact behavior produces real bugs:

- **BullMQ v6 rejects a custom job id containing `:` outright** ("Custom
  Id cannot contain :") — caught by a throwaway smoke test
  (`redis-memory-server`, `--no-save`, never committed) using the job key
  format this ADR's own first draft used (`mailsync:${userId}`, mirroring
  this codebase's usual `:`-separated cache/lock-key style). Every single
  `enqueue()` call would have thrown in production. Fixed to
  `mailsync_${userId}`.
- **The dedup/concurrency mechanics were verified end to end against a
  real Redis**, not just read from documentation: a duplicate enqueue for
  a user whose job is already `active` is correctly skipped; a
  *different* user's job runs concurrently, unaffected; and after the
  first job completes (`removeOnComplete: true`), the same job id is
  correctly free for reuse. A separate smoke test then ran the real
  `startMailSyncQueue` against a genuinely migrated Postgres database
  with a real user row and confirmed, via `QueueEvents`'s `completed`
  event (not a job-count poll, which can race past `removeOnComplete`),
  that `syncAllUserMail` executed successfully through the full import
  chain.
- `server/src/services/email/__tests__/mirror-sweep.integration.test.ts`
  gained three committed tests for the `setMailSyncEnqueuer` branch: a
  registered enqueuer receives each candidate instead of the sweep
  syncing inline (and the AI layer is never reached, since the enqueuer
  in the test is a no-op spy); clearing the enqueuer restores the
  original inline-sync fallback; and one candidate's enqueue throwing
  doesn't stop the rest of the batch, matching the existing
  per-candidate error isolation.
- Full server test suite passes.

## Alternatives considered

- **Account-scoped job key (`mailsync_${accountId}`)** — the plan's own
  text flagged checking this before collapsing to user-level, since
  ADR 0080's Yahoo throttle is per-account. Rejected once the real
  coalescing picture (above) was clear: per-account protection already
  exists and is untouched (`accountSyncs`); the new queue's job is
  narrower (stop the *sweep* from re-selecting an in-flight *user*), so
  user-scoped is the right — and simpler — granularity for what this
  queue actually needs to solve.
- **Re-inline the sync body in the queue processor**, matching
  `sweepMailboxes`'s old code exactly — rejected in favor of calling the
  already-existing `syncAllUserMail`, which is the identical wrapped
  call with a name; duplicating it a third time (sweep's old inline
  version, the queue processor, `syncAllUserMail` itself) would have
  been the wrong direction.
- **Trust BullMQ's job-id dedup on `add()` alone** — rejected per the
  same caution ADR 0174 already applied: an active job with a given id
  doesn't reliably block a duplicate `add()` across versions, so
  `enqueue()` explicitly checks `getJob` + `getState` first.
