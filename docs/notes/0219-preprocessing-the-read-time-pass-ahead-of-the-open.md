# 0219 — Preprocessing the read-time pass ahead of the open

**Status**: accepted
**Date**: 2026-10-01

## Context

ADR 0180's read-time magics pass runs a real LLM call the first time a thread
is opened, capped at `EMAIL_READ_TIME_WAIT_MS` (1.5s) before the email shows
anyway. A live benchmark against the running dev server showed this is the
actual bottleneck in "why does opening an email feel slow" — not the mail
sync itself (ADR 0205 already made that return before the AI layer), but the
per-thread, on-demand LLM call that nothing had ever tried to get ahead of.

The two previous read-passes — the background sweep (`runEmailMagics`) and
the read-time pass — are deliberately independent: the sweep applies cost
gates (bulk deny-list, discretionary categories, stale-read window — ADR
0109/0127/0143) that must NOT apply once a human is actually looking at a
message (ADR 0180/0184). That separation is correct and is not revisited
here — but nothing stopped the *interactive* pass itself from running before
the click instead of during it, as long as it is the same function with the
same gates bypassed.

## Decision

New `preprocessReadTimeMagics` (`magics.service.ts`) runs the exact same
`runReadTimeEmailMagics` the open route calls, just triggered earlier:

- **Right after sync** (`runAiPassesInBackground`), in parallel with the
  existing background sweep.
- **Opportunistically on every real thread-open** (never a prefetch — ADR
  0218 already drew that line), fired after the response is sent.

**Bounded, not exhaustive**: each call processes at most
`EMAIL_PREPROCESS_READTIME_BATCH` (default 10) threads — the newest ones
with no `read` mark yet. A 14-day backfill must not turn into one real LLM
call per thread whether or not anyone ever opens it; that is exactly the
unbounded-cost shape ADR 0109/0127/0143/0149 spent real effort avoiding for
the background sweep, and this pass would recreate it for free if left
unbounded.

**Self-advancing window, no stored cursor**: the query is always "the
newest N threads with no `read` mark", full stop. Once the front N are
marked (by this running, or by the reader opening them directly), the
identical call naturally surfaces the next N — there is no window index or
cursor to keep in sync with reality, and nothing to go stale if a mark gets
written some other way.

**In-memory per-user guard** (`preprocessInFlight`, mirrors
`afterSyncRuns`/`mailSyncRounds`'s existing in-process coalescing, same
shape as ADR 0165's reasoning for cheaper work): two triggers landing close
together — a sync finishing right as the reader opens their first email —
would otherwise both see the same unmarked batch and both pay for it.
`runReadTimeEmailMagics`'s own per-thread mark check still bounds the worst
case to "wasted, not wrong" even if this raced, so the guard is a cost
optimization, not a correctness requirement — a DB-level advisory lock
(ADR 0165's heavier tool) was not needed for a single-process, best-effort
cache warm.

## Alternatives considered

- **Preprocess every newly-synced thread** — nothing is ever slow to open,
  but a big backfill pays a real LLM call per thread regardless of whether
  it's ever read. Rejected on the same cost-boundedness grounds as the
  background sweep's own gates.
- **A persisted cursor/offset per user** — more state to keep consistent
  with the mark table for no behavioral gain over "ask the same question
  again"; rejected as unnecessary complexity.
- **A `pg_advisory_xact_lock` guard** (ADR 0165's mechanism) — right for a
  cross-process true race with a correctness consequence (duplicate rows);
  overkill here, where the failure mode is a few wasted LLM calls, not a
  wrong write.
- **Don't build it** — leaves every first-ever open of a never-preprocessed
  thread paying the full on-demand latency; rejected once the benchmark
  showed this was the actual bottleneck, not the sync.

## Consequences

- A fresh backfill's first ~10 threads (by recency) are typically already
  warm by the time a reader opens the inbox; the next ~10 warm up as they
  read through the first batch.
- `EMAIL_PREPROCESS_READTIME_ENABLED=false` returns to purely on-open
  processing (the ADR 0180 behavior, unchanged) — a clean kill switch.
- Existing ADR 0218 tests that assert "nothing is `read`-marked until an
  open/prefetch happens" had to explicitly disable this flag in their own
  setup (`email-sync-ai-after.integration.test.ts`) — they test the
  on-demand path in isolation, and this feature's own correctness (the
  bounded batch, the self-advancing window, the in-flight guard) is pinned
  separately in `preprocess-readtime.integration.test.ts`.
- Does not change the cost or latency of the **compose** (reply-suggestion)
  call — that is tied to a specific instruction typed at the time, not
  something a generic preprocessing pass could precompute.
