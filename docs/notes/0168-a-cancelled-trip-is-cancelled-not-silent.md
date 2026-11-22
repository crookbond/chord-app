# 0168 — A cancelled trip is cancelled, not silent

**Status**: accepted
**Date**: 2026-09-14
**Relation**: sibling of [0158](./0158-email-body-through-the-trip-classifier.md)
(the trip classifier this extends) and [0074](./0074-timezone-anchoring-and-invite-reconciliation.md)'s
`METHOD:CANCEL` handling (the calendar-invite analog this deliberately does
**not** reuse — see Rejected).

## Context

Prod (`ownertest@gmail.com`): an American Express Travel email, subject
"Cancellation: your trip to Vail," arrived for a hotel stay already on the
Trips tab (created in June from an uploaded screenshot — Residence Inn by
Marriott Vail, Feb 11–15, 2027). Traced against the actual code (not
guessed):

- The thread's category is a `travel/*` leaf, unarchived, so it hits ADR
  0158's short-circuit in `magics.service.ts` and goes to
  `classifyTravelDocument` — the same classifier a real confirmation email
  would hit.
- `CLASSIFY_SYSTEM`'s schema (`bot/trip_classifier.ts`) has exactly seven
  kinds: flight / hotel / restaurant / movie / recipe / calendar / other.
  **None of them is "cancellation."** The prompt has no notion that a
  travel document might be retracting a booking instead of making one.
- Given this email's content — property name, address, room type,
  check-in/check-out dates — it reads exactly like a hotel confirmation, so
  the model returns `kind:"hotel"` with the same property and dates as the
  original booking.
- `stageHotel` (`email/trip-extraction.ts`) then runs
  `findExistingAccommodation`, which matches on `confirmation` OR
  `(propertyName + checkinDate + checkoutDate)` — in this case it **does**
  match the existing row, so nothing gets (re-)proposed. That outcome is a
  coincidence of this cancellation restating the identical property and
  dates, not a designed behavior: a cancellation with a different
  confirmation code, or a partial cancellation, would instead **stage a
  duplicate accommodation proposal for a trip that no longer exists.**
- Either way, **nothing ever reads "cancelled" and marks anything
  cancelled.** No status column on `trips`/`travel_legs`/`accommodations`
  is written by any path. The Vail trip stays in the database — and in the
  Trips tab — looking exactly as live as it did the day before Amex
  cancelled it.

Two existing cancellation mechanisms in this codebase, and why neither
applies: `.ics METHOD:CANCEL` (ADR 0074 addendum) retracts/cancels a
**calendar event** by UID — this is a plain HTML marketing-style
confirmation email, not an `.ics`. Outlook's native `meetingCancelled`
message type marks a thread handled and stages nothing — also calendar-
invite-specific. Neither touches `trips`/`travel_legs`/`accommodations`,
which have no cancellation concept of any kind.

Distinct from the flight-status side channel (ADR 0138):
`magics.service.ts`'s general extractor already recognizes a `status:
"cancelled"` value on its `flight` block and stores it in
`email_threads.flight_json` — but that's for an *airline's own* delay/
cancel notice about a specific flight, read by the general extractor, never
by the trip classifier, and it never touches the `travel_legs` row itself.
This ADR is about the trip classifier's own blind spot: an OTA/hotel/agency
telling you an entire **booking** — hotel stay or flight — no longer
exists.

**Verified live against the fix**: the real Amex email body, run through
the fixed `classifyTravelDocument`, now returns `{"kind":"cancellation",
"cancelsKind":"hotel","propertyName":"Residence Inn by Marriott
Vail","checkinDate":"2027-02-11","checkoutDate":"2027-02-15","confirmation":
"ZO-AX1057-43807"}` — exactly the fields `applyCancellation` needs to find
and cancel the matching accommodation.

## Decision

**Add an eighth kind, `cancellation`, to the trip classifier**, carrying
just enough identifying information to locate the booking it cancels —
the same fields `findExistingAccommodation`/`findExistingLeg` already
match on, so cancellation lookup reuses their exact matching logic rather
than inventing a second one:

```
{ "kind": "cancellation",
  "cancelsKind": "hotel" | "flight",
  // hotel shape (when cancelsKind is "hotel"):
  "propertyName"?, "checkinDate"?, "checkoutDate"?,
  // flight shape (when cancelsKind is "flight"):
  "legs"?: [ { "origin"?, "destination"?, "departAt"? } ],
  // either shape:
  "confirmation"?, "itineraryNumber"? }
```

`stageEmailTripProposal` gains a new branch: on `kind:"cancellation"`, call
**`applyCancellation`** (new, `email/trip-extraction.ts`) instead of
`stageFlight`/`stageHotel`. Unlike a new booking, a cancellation is
**applied directly, not staged as a proposal** — the same posture ADR
0074's `applyInviteCancellation` already takes for calendar invites: a
cancellation notice is itself the confirmation (Amex already told the
user), so there's nothing left to confirm, and asking "do you want to
un-book your own cancelled trip?" reads as broken, not careful.

`applyCancellation`:

1. Finds the trip via `findTripByDateRange` using whatever dates the
   cancellation carries (hotel check-in/out, or the earliest/latest leg
   date), scoped to the user's own groups.
2. Matches the specific accommodation/leg via new, looser matchers
   (`findAccommodationToCancel`/`findLegToCancel`) — property+dates / route+
   date **checked first**, confirmation-alone only as a fallback. Order is
   load-bearing, not incidental: an outbound and return leg routinely SHARE
   one PNR, so if a cancellation names a specific route+date, matching on
   confirmation first would risk cancelling whichever leg a query with no
   `ORDER BY` happens to return first — not the one actually named. The
   round-trip Denver test fixture happens to share `confirmation: 'ABC123'`
   across both legs, which is what surfaced the ordering risk on review —
   worth being deliberate about here rather than leaving it to query order.
3. **A match found** → sets `cancelled_at` (new nullable column, migration
   `075`, on `trips`/`travel_legs`/`accommodations` — `trip_reservations`
   deliberately not touched, since nothing cancels a reservation today) on
   that row. If every leg and accommodation on the trip is now cancelled,
   also sets `trips.cancelled_at` — a trip is cancelled when nothing about
   it is still happening, derived rather than asked, mirroring how
   `getTripStatus` already derives its narrative. A trip that still has a
   live (uncancelled) leg or stay never auto-cancels, even if one of its
   bookings just did.
4. **No match found** → a safe no-op. The booking this cancels was never
   in Chord (maybe filed by a different family member's mailbox, maybe
   never forwarded), and there is nothing to mark — same asymmetry ADR
   0133 already names for tracking numbers: a missed cancellation costs
   nothing extra (the trip was never shown as live in the first place), a
   wrong match would cancel someone else's still-real trip.
5. Marks the thread extracted either way (ADR 0137 — one outcome per
   thread).

`findTripByDateRange` gains `WHERE cancelled_at IS NULL`: a **rebooking**
for the same dates and destination must create a fresh trip, not attach
itself to the one just cancelled — the two are unrelated bookings that
happen to share a date range.

**Surfaced, not just stored.** A cancelled-but-still-shown trip is the
ADR 0102/0107 failure in a new place — silently keeping the row correct in
the database while the Trips tab keeps rendering it as a normal upcoming
plan is not meaningfully different from not recording the cancellation at
all, from the family's point of view:

- `Trip.cancelledAt` / `TravelLeg.cancelledAt` / `Accommodation.cancelledAt`
  exposed through the existing DTOs (no new endpoint).
- The Trips tab renders a **"Cancelled"** badge on a cancelled trip and
  folds it into the existing "▸ Earlier trips" disclosure alongside past
  trips (`isTripArchived`'s collapsed section) — it no longer needs
  attention as an upcoming plan, but stays visible and searchable, never
  deleted.
- `magics-context.ts`'s world snapshot and `findUpcomingFlights` (the
  bot's `upcomingFlightsBlock`, ADR 0138) both exclude cancelled trips/legs
  — the bot must not casually mention a trip that no longer exists as
  something upcoming.
- **A partial cancellation — hotel cancelled with flights still booked, or
  the reverse — also gets a proactive nudge**, not just a badge someone
  might notice later. Extended separately in
  [ADR 0169](./0169-a-partial-cancellation-leaves-a-gap-to-flag.md), which
  reuses the existing proactive-message machinery so the nudge inherits
  correct WhatsApp/quiet-hours gating rather than reintroducing ADR 0137's
  bug.

## Consequences

- Fixes the failure class for both hotel and flight cancellations sent by
  an OTA/agency/hotel directly (Amex Travel, Booking.com, Expedia,
  Marriott, etc.) — anything the trip classifier would otherwise
  misclassify as a fresh confirmation.
- Does **not** cover an airline's own flight-cancellation notice (already
  a different, narrower mechanism — ADR 0138's `flight_json.status`) or a
  partial itinerary change (rebooked to a different flight/room) — those
  read as `kind:"hotel"`/`kind:"flight"` today and are handled by the
  existing dedup-or-propose path; teaching the classifier to recognize a
  *changed* (not cancelled) booking is a separate, harder problem (which
  field changed, and does the old one get cancelled or updated) — left for
  its own ADR if it turns out to matter in practice.
- **Does not retroactively fix the Vail trip already sitting stale from
  before this shipped.** Its thread already carries an `email_extraction_marks`
  row from the earlier "hotel, dup-matched, no-op" pass. Re-running that
  specific thread through the fixed classifier is a one-off operational
  step (clear its `'magic'` mark, let the next magics pass re-mine it) —
  same deferred-follow-up shape ADR 0167 left for its own three burned
  threads.
- **Does not retract a still-pending (unconfirmed) proposal for the same
  booking** — if a cancellation email arrives before the user ever
  confirmed the original booking proposal, `applyCancellation` finds
  nothing in `accommodations`/`travel_legs` (the row doesn't exist yet) and
  no-ops; the stale proposal stays pending until its normal 72h TTL
  (ADR 0009) expires it. Narrower than it could be, but this race — booked
  and cancelled before anyone looked at the Action Items card — is rare
  enough, and matching it would mean searching pending proposals' `args`
  JSON for the same identifying fields, a second matcher this ADR chose
  not to build for an edge case with a short-lived (72h) blast radius.
- A cancellation whose identifying details don't quite match the original
  booking (different confirmation format, slightly reworded property name)
  silently does nothing rather than guessing — accepted under the same
  ADR 0133 asymmetry cited above.
- **Email-body path only.** `classifyAndAutoFileAttachment` (the uploaded-
  screenshot/PDF path) now explicitly recognizes `kind:"cancellation"` and
  does nothing with it (same as `other`) rather than auto-filing — its
  `else` branch previously assumed "not flight" meant "hotel," which a
  cancellation result would have broken. Applying a cancellation from an
  uploaded document (someone screenshots a cancellation email instead of
  forwarding it) is a real but rarer case, left for a follow-up if it comes
  up in practice.

## Rejected

- **Reusing `applyInviteCancellation`'s UID-keyed retraction** — that
  mechanism keys on an iCalendar UID that only exists for `.ics` invites;
  a marketing-style cancellation email has no UID to key on, so identity
  has to come from the same property/date/confirmation fields a booking
  itself carries.
- **Staging the cancellation as a proposal for the user to confirm** — the
  cancellation already happened (Amex/the hotel/the airline decided it,
  not Chord), so a confirm step asks the user to approve something that
  isn't a decision.
- **Hard-deleting the trip/leg/accommodation row on cancellation** — loses
  the record of what was booked and when it fell through, which a family
  might still want to reference (insurance claim, refund follow-up,
  rebooking reference) — the same reasoning ADR 0092 already applied to
  tasks (`archived`, never hard-deleted).
- **Teaching the classifier to also detect a *changed* (not cancelled)
  booking in this same change** — a strictly harder problem (which fields
  changed, cancel-the-old-and-add-new vs. update-in-place) that would
  double this ADR's surface for a case not yet seen in prod; noted above
  as a candidate follow-up, not built here.
