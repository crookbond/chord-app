# 0221 — Speculative preprocessing is not a real open

**Status**: accepted
**Date**: 2026-10-01

## Context

Prod (`ownertest@gmail.com`, 5 connected mailboxes going back to July): a burst
of 33 `create_task` proposals in one hour, sourced from email threads with
`last_message_at` as old as **2026-07-19** — read, unarchived, genuinely
settled mail, several already handled through some other channel. The user
noticed the obligation list filling up with stale, already-resolved items
and asked what produced them.

`preprocessReadTimeMagics` (ADR 0219, shipped earlier the same session)
warms the ADR 0180 read-time pass ahead of a real open by finding "the
newest `limit` threads with no `read` mark yet" and running the full
extraction+staging pass on them — deliberately with no stored cursor, so
once the front of that set is marked, the identical query naturally
surfaces the next batch. That self-advancing property was the intended
design (ADR 0219's "no cursor" decision) and is not the defect. The defect
is what ADR 0219 borrowed along with the pass: `runReadTimeEmailMagics`
(ADR 0180) deliberately bypasses the background sweep's own eligibility
gates — the unread/7-day-age rule (ADR 0143), the bulk deny-list (ADR 0127),
the discretionary-broadcast exclusion (ADR 0179) — on the reasoning that
"none of those gates' reasoning holds once a person already has the
message open." That reasoning is specific to an actual human looking at an
actual thread right now. `preprocessReadTimeMagics` runs on a fire-and-forget
basis after every sync and opportunistically on every thread open — for a
*different* batch of threads nobody is looking at. Given enough sync/open
ticks (a sync happens as often as every 5 minutes, ADR 0144/0159), the
"newest unmarked" query marches, batch by batch, straight through the
unread-but-settled backlog this user had accumulated over months — with
none of the gates that would have correctly left it alone.

## Decision

`preprocessReadTimeMagics`'s candidate query now applies the same
eligibility rules `runEmailMagics` (the background sweep) already uses:
`is_unread = 1 OR last_message_at >= minableSince()` (ADR 0143),
`minablePredicate` (ADR 0127's bulk gate), and exclusion of
`discretionaryBroadcastCategoryIds` (ADR 0179). A speculative warm-up earns
no exception from rules that exist to decide what's actually still owed.
`runReadTimeEmailMagics` itself — the path a genuine thread-open actually
calls — is untouched; ADR 0180's bypass stays correct for the case it was
written for.

## Alternatives considered

- **Bound the preprocessing batch by age only** (e.g. "never look more than
  N days back") — simpler, but duplicates a number (`EMAIL_MINE_READ_MAX_AGE_DAYS`)
  instead of reusing the predicate, and misses the bulk/discretionary cases
  entirely (an old, unread newsletter would still get a speculative pass).
- **Add a `category_id IS NOT NULL` requirement**, mirroring
  `runEmailMagics` exactly — dropped: `minablePredicate` already handles a
  null category via `coalesce`, and requiring classification first would
  needlessly delay warming a just-synced, not-yet-classified thread for no
  correctness gain.
- **Remove the self-advancing "no cursor" design entirely** (track a
  cursor, stop advancing past a point) — overcorrects; ADR 0219's own
  reasoning for no cursor still holds for RECENT mail, which is the case
  this function exists to warm. The bug was never about how far it looks,
  only about re-litigating settled policy while doing so.

## Consequences

Preprocessing still warms the newest unread/recent mail exactly as before
(unaffected — those threads already pass the added gates trivially). It no
longer walks into a backlog of old, read, settled mail and stages fresh
obligations for things already handled elsewhere. Pinned by a new
integration test (old+read thread excluded; recent+read and old+unread
threads still included) — confirmed to fail without the fix and pass with
it. The already-created proposals from tonight's burst are not retracted by
this change; they're ordinary pending proposals and can be rejected like
any other.
