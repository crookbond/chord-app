# 0183 — A leg/accommodation can move without its whole trip

**Status**: accepted
**Date**: 2026-09-17

## Context

ADR 0171 made a mis-dropped whole-trip merge recoverable, but only for a
drop discovered *immediately after* (the Undo toast) — and only ever moved
an entire trip. Two real needs it didn't cover: fixing a mis-drop noticed
later, and splitting ONE leg or accommodation out of a trip (a merged trip,
or one where a single item was simply filed wrong) without dragging
everything else along with it.

`mergeTrips` (ADR 0171's sibling) already re-parents rows in bulk inside a
transaction and folds the source away via `maybeDeleteEmptyTrip` once it's
empty. The obvious next step is the same shape at row granularity — move
just one `travel_legs` or `accommodations` row — rather than a "split"
concept, a "de-merge", or a reservation-style destructive delete-and-recreate.

## Decision

`moveTravelLeg` / `moveAccommodation` (`trips.service.ts`) re-parent one row
onto a different, already-existing trip, transactionally:

- Strict group scope on **both** trips (the item's current trip and the
  target) — a caller can't reach across groups by only proving membership
  in one.
- Widen the **target's** date range the same way `addTravelLeg` widens it
  for a freshly-added leg (min/max against the moved item's own dates).
  The **source's** dates are left alone — it may still cover other items
  that justify its current window, and shrinking it back down would need
  its own re-derivation pass nothing else in this ADR needs.
- Fold the source away via the existing `maybeDeleteEmptyTrip` if the moved
  item was its last leg/accommodation/reservation — same recoverable
  soft-delete every other trip-emptying path already uses (ADR 0171).
- Moving onto the item's own current trip is a no-op that still returns
  success (`sourceTripDeleted: false`), rather than a special-cased error —
  simpler for both the mobile drag handler and the bot tool, neither of
  which can always tell in advance whether the drop target IS the source.

Three surfaces, one underlying operation:

1. **Server**: `POST .../legs/:legId/move` and `.../accommodations/:accomId/move`
   (body `{ targetTripId }`), mirroring the existing per-item DELETE routes'
   auth/broadcast shape exactly (`tripDeleted` for a source the move emptied
   out, `tripUpdated` otherwise, plus `tripUpdated` for the target).
2. **Mobile**: a per-row long-press-drag on the Trips tab, alongside the
   existing whole-card drag-to-merge (ADR 0171).
3. **Bot tools**: `move_leg` / `move_accommodation`, resolving the item by
   the same descriptor shape `set_leg_passenger` already uses, and the
   target trip the same exact-name-or-ask way `update_trip`'s `resolveTripId`
   already does — no new resolution vocabulary for the model to learn.

### Gesture composition (mobile)

A leg/accommodation row now sits *inside* a card that is itself a
long-press-then-pan drag target (whole-trip merge). Both gestures would
otherwise start evaluating on the same touch. Rather than a mode toggle or
a visually separate drag-handle icon (either changes what a long-press on a
row already means, or shrinks the hit target to something fiddly), the row's
`Gesture.Pan()` calls `.blocksExternalGesture(cardPan)` — once the row's own
long-press activates, the enclosing card's pan gesture is cancelled, so one
touch is never read as both "move this leg" and "merge this whole trip".
The card's own gesture object is threaded down (`DraggableTripCard` →
`TripCard` → `DraggableTripRow` via a `rowDrag` prop bundle) rather than
rebuilt, so there's exactly one `cardPan` instance to block.

Row-dragging reuses the whole-card drag's `DropRect`/`hitTestRect`/
`currentHit` hit-testing and TripsSection's `cardRefs` map of card rects
(refactored into a shared `measureCardRects(ids)` under both
`measureDropTargets` and the new `measureRowTargets`) — a row's own rect is
measured locally (it isn't a registered card ref), but the set of drop
*targets* is the same live-trip-cards-in-this-group set the card drag
already computes, just excluding the row's own card by tripId instead of by
looking a dragged id up in `trips` (a leg/accommodation id isn't a trip id).

Offered only where the whole-card drag already is: live (non-archived,
non-deleted) trips. A past or deleted trip is read-only history, not a drag
source, for either granularity.

## Alternatives considered

- **A visible drag-handle icon per row**, sized and positioned to sit
  outside the card's own drag-sensitive area — avoids the gesture-priority
  question entirely, but a hit target that small is worse UX than "long-press
  the row you mean", and the codebase's existing long-press-anywhere-on-the-
  card pattern (ADR 0171) already sets the expectation.
- **A single unified drag gesture** that inspects what it landed on
  (row vs. card chrome) to decide card-merge vs. row-move — collapses two
  independently-reasoned-about actions into one state machine, and makes a
  future third draggable thing (e.g. a reservation) a change to that one
  gesture's branching logic instead of a new, independent `DraggableTripRow`.
- **Widening the source trip's dates down after a move** (shrink-to-fit) —
  rejected as unnecessary complexity: a trip's date range is otherwise only
  ever widened, never narrowed, and a stale-wide window on a trip that still
  holds other items is a pre-existing, harmless imprecision (visible gaps
  are computed from what's actually placed on the trip, not from the date
  range alone).
- **A reservation `move_reservation` tool/gesture too** — out of scope: the
  task that prompted this only asked for legs and accommodations, and
  reservations aren't part of the whole-trip merge gesture's mental model
  the way legs/accommodations are (ADR 0171 already folds all three on
  merge, but nothing today lets a user single out one reservation the way
  they can a leg or a stay).

## Consequences

- `findMatchingAccommodations` is new (`trips.service.ts`) — `findMatchingLegs`
  had no accommodation-side counterpart until `move_accommodation` needed one
  to resolve a stay by descriptors the same way `set_leg_passenger` resolves
  a leg.
- The SSE broadcast shape for a move is `tripUpdated`/`tripDeleted`, not a
  dedicated `travel_leg.moved` event — mirrors the existing per-item DELETE
  routes, which already broadcast at the trip level rather than the item
  level; nothing about a move needed a finer-grained event than a delete
  already gets by without.
- `.blocksExternalGesture` is exercised for the first time in this codebase
  (the only prior gesture, ADR 0171's whole-card drag, had no sibling
  gesture to conflict with) — the next nested-gesture case should reuse this
  same relation rather than re-deriving it.
