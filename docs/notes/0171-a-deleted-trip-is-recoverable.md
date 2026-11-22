# 0171 — A deleted trip is recoverable, and a trip is named for its destination

**Status**: accepted
**Date**: 2026-09-15

## Context

Prod: the user tapped "x" on a trip card titled "Residence Inn by Marriott
Vail" meaning to clear out a single cancelled hotel booking (ADR 0168 had
just badged it CANCELLED). `deleteTrip` was a hard `DELETE FROM trips`
cascading (`ON DELETE CASCADE`) to `travel_legs`/`accommodations`/
`trip_reservations`/`trip_participants` — so the tap also erased two live
Southwest flight legs that had nothing to do with the hotel. The flights
still existed on Google Calendar (ADR 0158's mirror events are independent
rows), but the trip itself, and any record of the itinerary, was gone.

Two compounding defects, both real:

1. **No undo.** Nothing about a trip delete was reversible — the only
   Trips-tab affordance for "this specific booking is done" was the same
   button as "erase the whole trip."
2. **The title was the wrong noun.** `stageHotel`/`ensureTripForHotel`
   named a hotel-only trip after the PROPERTY (`hotel.propertyName`), not the
   destination. A property is one fact about a trip; the trip itself is "the
   time we went to Vail." When the Residence Inn booking was cancelled and
   rebooked at a different hotel, the replacement created a *second*,
   differently-named trip shell for the same dates rather than extending the
   first — so the Trips tab already read as two unrelated bookings before
   the delete ever happened, and the user's "x" tap targeted the wrong one.

## Decision

**A trip is soft-deleted, never hard.** `trips.deleted_at` (nullable, mirrors
`cancelled_at`'s ADR 0168 shape). `deleteTrip` sets it; `restoreTrip` clears
it. Legs/accommodations/reservations are NOT cascaded on delete — they stay
attached, so restoring brings the whole itinerary back with it. The Trips tab
gets a third disclosure bucket alongside "Earlier trips" (ADR 0092's
`isTripArchived`/cancelled fold): **"Deleted trips · N"**, each card showing
a DELETED badge and a "↺ Restore" button in place of the trip-level delete
button. `findTripByDateRange`/`pickActiveTrip` exclude deleted trips (a
rebooking after a delete is a fresh trip, not a silent resurrection).

**Removing one leg/stay is a real delete — but empties into the same
recoverable state.** The actual prod complaint ("I wanted to drop the
cancelled hotel, not the whole trip") needed a scalpel, not the sledgehammer.
New `removeTravelLeg`/`removeAccommodation` hard-delete a single row (no
"Deleted leg" concept — a line item isn't worth its own undo UI), exposed as
a "Remove" link on a row already showing `cancelled` (ADR 0168's badge).
`maybeDeleteEmptyTrip` runs after every removal: if the trip now has zero
legs, zero accommodations, AND zero reservations, it soft-deletes — so
removing everything off a trip one line at a time lands in the same
recoverable "Deleted trips" bucket as tapping the trip-level "x" directly,
rather than leaving an empty, invisible shell. A trip that still holds a
dinner reservation is left alone even with every leg/stay gone (a
reservation is still something to show up for).

**A hotel-only trip is named for the city, not the property.** New optional
`city` field on the trip classifier's `Hotel` schema (`bot/trip_classifier.ts`),
populated by the same LLM call that already reads `propertyName`/`address` —
no second call. `hotelTripCity()` prefers it, falls back to a best-effort
parse of the `address` field (comma-split, dropping state/zip/country
segments and a leading street number), and only falls through to the old
`propertyName` behavior when neither is available. Both hotel-only trip
creation paths — `stageHotel` (email → proposal bundle, ADR 0158) and
`ensureTripForHotel` (attachment auto-file, ADR 0071) — call it, so
`create_trip`'s `name`/`destination` become `Trip to Vail` / `Vail` instead
of the property name / full address. The live bot-tool path (a chat message
that makes the model call `create_trip` directly, no structured classifier
involved) gets the same rule as a **prompt instruction** on the tool
description in both `tools.ts` catalogues (native function-calling and the
text-fence fallback) — there's no server-side hook to correct a name the
model chose itself, so this is the ADR 0100-style "tell the model, and
that's the whole fix" case rather than a code-level guard.

**Addendum — `update_trip`.** Recovering a real prod trip (this ADR's own
motivating case) exposed the gap directly: a trip created with the wrong
year (a source with no printed year — a chat message repeating a hotel
name, in this instance — resolved against the wrong anchor) had no way to
be corrected short of a manual SQL edit, since `create_trip` only creates
and nothing edited a trip's own name/destination/dates afterward.
`updateTrip()` (`trips.service.ts`) patches only the fields supplied,
rejects an inverted date range, and is exposed as a bot tool mirroring
`set_trip_passengers`'s `tripId`/`tripQuery` resolution (exact id, else a
destination/name hint, else candidates to disambiguate) — so "the Vail trip
is actually 2027, not 2026" is now a chat message instead of a database
edit. Deliberately narrow: it does not touch legs/accommodations/
reservations (`add_travel_leg`/`add_accommodation` own those) or
participants (`set_trip_passengers` does).

## Alternatives considered

- **A confirm dialog on the trip-level delete** — doesn't fix the actual
  failure (the user WAS trying to remove something specific; a confirm on
  the wrong action just makes the wrong action slower). Soft-delete +
  recovery fixes it regardless of which button gets tapped.
- **Cascade-delete children but keep a tombstone on the trip row** — would
  still lose the itinerary data on delete; restoring an empty trip shell
  isn't restoring the trip.
- **A dedicated `deleted_at` on `travel_legs`/`accommodations` too** — no
  product need surfaced for undoing a single line-item removal (unlike a
  whole trip, which is the unit someone actually thinks of as "the Vail
  trip"); adds a second soft-delete concept and a second "Deleted" list
  nobody asked for.
- **Regex-only city extraction from `address`, no `city` field** — address
  formats are too varied to parse reliably (a property name with no leading
  street number is indistinguishable from a city in a naive comma-split);
  asking the classifier for the field it already has full context for is
  cheap and correct where the regex is a best-effort fallback at best.
- **A server-side executor guard that rewrites a live-chat `create_trip`
  call's name after the fact** — the executor has no reliable signal that a
  given `create_trip` is "hotel-only" (that's determined by what tool calls
  follow it in the same turn, which haven't happened yet when `create_trip`
  runs); a prompt instruction is the same shape ADR 0102 already uses for
  things only the model can decide correctly.

## Consequences

- `trips.deleted_at` (migration `076`) joins `cancelled_at` as a second
  fire-once-shaped marker on trips; both are independent (a trip can be
  cancelled and later deleted, or deleted while still live).
- The Trips-tab "Trips" count badge now excludes deleted trips (it already
  excluded nothing before, since nothing was ever soft-deleted).
- A cancelled leg/stay's "Remove" link is real, but a soft-deleted trip's
  legs/stays render read-only (no "Remove") — removing pieces off an already
  -deleted trip has no product meaning until it's restored.
- The Vail trip this ADR is about had already been hard-deleted in prod
  before this shipped (cascade already ran) — this ADR prevents the class of
  bug going forward; recovering that specific trip's data is a one-off
  operational fix, not something this migration can undo.
