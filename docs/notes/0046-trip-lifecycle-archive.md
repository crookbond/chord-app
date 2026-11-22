# 0046 — Trip lifecycle: archive past trips (and their files)

**Status**: accepted
**Date**: 2026-06-08

## Context

The Trips tab (`mobile/app/catchup/[tab].tsx` → `TripsSection`) and the
Files tab (`FilesSection`) both list everything ever created, forever.
Once a trip is over, its card and the documents it was built from (the
forwarded PNR, hotel confirmation, boarding-pass screenshot) keep taking
up space at the top of the list with no way to tuck them away. The
backlog captured this as "Trip file lifecycle — what happens to trip
files after a trip expires (retain / archive / delete?) — currently
undefined."

We want past trips out of the way by default but never destroyed: a
family wants last summer's trip (and its receipts) to still be there when
they go looking, just not cluttering "what's next."

The trip data model already encodes the only signal we need — every trip
has `startDate`/`endDate` (IsoDate), and the server's `pickActiveTrip`
already treats `end_date < today` as "past." Files relate to trips through
`TravelLeg.sourceDocId` / `Accommodation.sourceDocId` (set by
`trip_classifier.ts` when a flight/hotel doc is auto-filed).

## Decision

"Archive" is a **view-layer** concept derived from dates, not a stored
flag — no schema change, no migration, nothing to keep in sync.

- A trip is **archived** once its last day has passed: `endDate < today`
  (UTC `YYYY-MM-DD`, matching `pickActiveTrip`).
- A file is **archived** when it is the `sourceDocId` of a leg/stay
  belonging to an archived trip. (Other files are unaffected.)

Both tabs adopt a **calendar metaphor**: archived items render *above*
the live ones, and on open the shared `ScrollView` auto-scrolls down to
the live/archived boundary so archived items sit just above the fold.
They're hidden by default; **scroll up** to bring them back into view.
No tap-to-expand, no separate screen — exactly how a calendar hides last
week.

The classification + the archived-source-doc set are pure functions in
`kernel/src/trip-lifecycle.ts` (`isTripArchived`, `archivedSourceDocIds`),
unit-tested in the server workspace — same pattern as
`calendar-layout.ts` and `lists-bucketing.ts`.

The Files tab now also loads trips (`TAB_DEPS.files` gains `'trips'`) so
it can compute the archived-source-doc set client-side.

## Alternatives considered

- **A stored `archived_at` column on `trips`.** Rejected — the archive
  state is a pure function of `endDate` and the clock; persisting it adds
  a column, a migration, and a daily job to flip it, all to cache
  something a one-line date comparison already gives us. Revisit only if
  we want *manual* archive/un-archive independent of dates.
- **Delete trip files on expiry.** Rejected outright — the whole point is
  retention. Receipts and confirmations are exactly what people come back
  for. Deletion stays an explicit user action (ADR 0037).
- **Collapsible "Earlier trips" disclosure instead of auto-scroll.**
  Considered and viable (simpler, no layout measurement), but the
  auto-scroll calendar metaphor is what was asked for and reads as more
  natural — past is *behind* you, scroll back to find it.
- **Cutoff by upload date for files (not trip linkage).** Rejected —
  "relevant files" means trip-linked, not "old." A document uploaded long
  ago for an upcoming trip should stay live.

## Consequences

- Zero persistence cost; archive state is always correct relative to the
  clock with no backfill or cron. A trip silently archives the day after
  it ends.
- The Files tab now depends on trips data; `tabReady` waits on both. A
  file with no trip linkage (most uploads) is never archived by this
  rule — that's intended.
- Auto-scroll relies on measuring the live/archived boundary
  (`measureLayout` + `scrollTo`) after layout. It runs once per tab open
  and degrades gracefully: if measurement fails, the list simply stays at
  the top with archived items visible — no crash, no data loss.
- A trip that spans "today" (`startDate <= today <= endDate`) is **not**
  archived; it stays live until the day after `endDate`.
- Out of scope: manual archive/un-archive, per-trip file retention
  policies, and archiving non-trip files. Captured in the backlog if we
  want them later.
