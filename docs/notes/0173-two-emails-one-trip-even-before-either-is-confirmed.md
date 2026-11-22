# 0173 — Two emails, one trip, even before either is confirmed

**Status**: accepted
**Date**: 2026-09-15

## Context

Recovering a real prod trip (ADR 0171) exposed a second, independent bug
while diagnosing the first: a flight confirmation and a hotel confirmation
for the same vacation routinely arrive as two separate emails. ADR 0158
already handles the case where ONE of them arrives after the other has
already been confirmed into a real trip — `findTripByDateRange` finds the
real row and the second email's children attach to it instead of minting a
new `create_trip`.

But `findTripByDateRange` only ever sees **confirmed** trips (real rows in
`trips`). If the mail sweep mines both emails before the user has confirmed
either proposal — the ordinary case, since a sweep runs every 5 minutes and
proposals sit until reviewed — the second email's `stageFlight`/`stageHotel`
finds nothing real yet (the first email's `create_trip` is still a pending,
unconfirmed proposal) and mints its own `create_trip` + bundle. Confirming
both then produces two separate trips for one vacation, exactly the shape
of fragmentation that turned a single Vail trip into a hotel-only shell and
an orphaned pair of flight legs in prod.

## Decision

Extend the SAME date-overlap matching ADR 0158 already applies to
confirmed trips, to also cover **pending, unconfirmed** `create_trip`
proposals in the same group. `findPendingTripBundleId` (`trip-extraction.ts`)
queries `proposals` for a pending `create_trip` row (not expired) whose
staged `startDate`/`endDate` overlap the new email's window; if found, the
new email's children (`add_travel_leg`/`add_accommodation`) are staged
against that **same `bundle_id`**, with no `create_trip` of their own.

This needs no other plumbing: ADR 0009's bundle-confirm already resolves
`WHERE bundle_id = ... AND status = 'pending'` **fresh at confirm time**,
so it doesn't matter that the trip-child proposals were added to the bundle
after the `create_trip` proposal was first staged — whichever proposals
share that `bundle_id` when the user finally taps confirm all commit
together, atomically, with the resulting trip id stamped into each child.

Checked only as a fallback, after the real-trip check finds nothing — a
confirmed trip is always the stronger, preferred match.

## Alternatives considered

- **Require the user to confirm the first bundle before mining the
  second** — would need either delaying the sweep (defeats freshness) or
  refusing to mine a thread whose window might collide with a pending
  proposal (an unbounded wait with no clear resolution — what if the user
  never opens the app?). Matching against pending proposals resolves it
  without asking the user to do anything differently.
- **Merge two ALREADY-CONFIRMED trips after the fact** — a "merge trips"
  operation was considered and rejected: it's strictly harder (reassigning
  legs/accommodations/participants between two real rows, deciding which
  name/dates win, handling one already pushed to Google Calendar) to solve
  a problem that's cheap to prevent at staging time. Not built.
- **Widen `findTripByDateRange` itself to also query `proposals`** —
  rejected: it already has real-trip-only callers outside the email path
  (e.g. `add_travel_leg`'s live bot-tool flow, which should never attach to
  a proposal nobody has agreed to yet). A separate, narrowly-scoped
  function keeps the "only pending, only within this one staging pass"
  behavior from leaking into unrelated callers.

## Consequences

- Two unrelated trips that happen to share overlapping dates (rare, but a
  family with two people travelling separately in the same week) will now
  merge into one bundle if both are mined before either is confirmed. This
  is the exact same risk `findTripByDateRange` already accepts for
  confirmed trips — extending it to pending ones is consistent, not a new
  risk category.
- Only `create_trip` proposals are matched (not arbitrary bundle contents),
  and only within the same group — cross-group merging was never on the
  table (ADR 0004).
- Pinned by `trip-extraction.integration.test.ts`: a flight staged, then an
  overlapping hotel staged, land in one bundle and confirm into one trip
  with both legs and the accommodation; a non-overlapping hotel still mints
  its own.
