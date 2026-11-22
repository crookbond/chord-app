# 0158 — An itinerary email is an itinerary, wherever it lives

**Status**: accepted
**Date**: 2026-09-11
**Relation**: closes the gap [0132](./0132-a-to-do-is-not-a-list-item.md) and
[0138](./0138-a-flight-we-cannot-name-gets-no-link.md) both deferred ("creating
a travel leg from email … its own ADR"). Reuses the trip classifier from
Phase 2 and the proposal-bundle machinery from
[0009](./0009-iterative-tool-use.md) / [0029](./0029-screenshot-bundle.md)
unchanged.

## Context

An Expedia or Booking.com confirmation never became a trip. The reason was
never that trips are hard — Chord has imported trips from documents for a
year (`classifyAndAutoFileAttachment` in `bot/trip_classifier.ts`: a plain
`classify(filename, text)` → `flight`/`hotel`/`restaurant`/… → `createTrip` /
`addTravelLeg` / `addAccommodation`). It was that **two pipelines do the same
job and only one was fed**:

- **an attachment** (a PDF itinerary) → `saveFile` → extraction →
  `classifyAndAutoFileAttachment` → a trip;
- **an email body** → `afterSync` → `magics.service.ts`, a separate LLM pass
  whose entire vocabulary is `event | task | list` (+ `delivery` / `flight`
  facts). It never calls the trip classifier.

So an Expedia email *with a PDF itinerary attached* already makes a trip
(ADR 0071 → `saveFile`). Booking.com and modern Expedia put the itinerary in
the **HTML body with no attachment** — that mail falls to `magics`, which at
best emits one `create_event` for a flight time, and once filed a **hotel**
confirmation as an `add_list_item`. Prod (`ownertest@gmail.com`): 73 travel
threads mined, **0** trip / leg / accommodation proposals ever.

Two things also had to be true before this was worth wiring, and now are:
`body_text` exists for unopened mail (ADR 0110 — before it, there was nothing
to classify), and the **entire consumer side is already built** — the
proposal-bundle confirm (`create_trip` first, its id injected into the
children, atomic), the Action Items bundle card, the briefing line. Nothing
was reading trip proposals only because nothing was writing them.

## Decision

**A new `afterSync` step runs the *existing* trip classifier on the email
body and stages a proposal bundle — it does not auto-commit.**

- `bot/trip_classifier.ts` exports `classifyTravelDocument` + `zonedDatetime`
  / `toLocalDatetime` (were `__testing`-only). No behaviour change to the
  attachment path.
- `email/trip-extraction.ts` `stageEmailTripProposal(...)`: `classify` the
  body; on `flight` / `hotel`, stage `create_trip` + `add_travel_leg` /
  `add_accommodation` proposals with a shared `bundle_id` and
  `provenance = gmail:<threadId>`. When `findTripByDateRange` already matches
  a trip for those dates, stage the children against that `tripId` and **no**
  `create_trip`. Legs / stays already on the matched trip
  (`findExistingLeg` / `findExistingAccommodation`) are not re-staged.
- Hooked into the `runEmailMagics` per-thread loop as a short-circuit for
  `travel/*`-category threads, **after** the invite-`.ics` probe (an invite is
  authoritative) and **before** the LLM magics extraction. On a staged bundle
  the thread is marked extracted (`kind: 'magic'`, ADR 0137's one-outcome-per-
  thread) and the loop continues — no `create_event` / `flight_json` twin.
- `EMAIL_TRIPS_ENABLED` (default on) gates it.

### Propose, never auto-commit

The attachment path auto-commits because a person deliberately uploaded that
file. An email arrives unbidden, and "Flights under $200" is one classifier
misfire from a phantom trip. The bundle lands in Action Items; one tap
creates the trip and its legs atomically, one tap dismisses it. This is the
"consent posture" ADR 0138 named.

### Scoped to travel categories

`classify` is a per-thread LLM call, so it runs only for threads the
classifier already filed under `travel/` (flights, hotels, itineraries) —
not every thread in the batch. Bounded further by the magics per-run cap and
the once-ever extraction mark. Marketing is filtered twice over: ADR 0127's
bulk deny-list already excludes it from the magics batch, and the classifier
itself requires a full `FlightLeg` (origin + destination + both times) or a
`Hotel` (property + check-in + check-out) — a sale blast has none, so it
returns `other` and nothing is staged.

## Rejected

- **Give `magics` a `trip` suggestion kind.** Duplicates the classifier that
  already exists, and its flight/hotel schemas, and its trip-matching. The
  classifier is the asset; route mail through it.
- **Auto-commit like the attachment path.** An unbidden email is not a
  deliberate upload; a misfire would silently mint a trip.
- **Run `classify` on every thread.** An LLM call per thread in the batch,
  to catch travel mail the classifier already labelled `travel/`.
- **Also import the itinerary as a synthetic attachment.** A file nobody
  attached, carrying a provenance shape (`gmail:<threadId>`) the proposal
  path already expresses directly.

## Addendum — rail, booking IDs, and a link home

Testing against a real prod mailbox surfaced two gaps:

**Rail is a trip.** An Amtrak e-ticket classified as `other` because the
`Flight` schema was aeroplane-only. `FlightLeg` gains an optional `mode`
(`flight`|`train`|`ferry`|`car`|`other`; coach/bus fold to `other`) mapped
onto `travel_legs.mode` by `legMode()`; the classifier prompt is broadened to
"a TRANSPORT booking — plane, train, coach/bus, or ferry". `syncFlightLegEvent`
now also fires for `train` — a scheduled boarding time is calendar-worthy;
`car`/`ferry`/`other` stay out (rarely a fixed time).

**A ticket names the people you travel with.** When the classifier's
`passengerName` is not the account owner (a name check against every form of
the owner's name), the pass also stages an `add_person` proposal through ADR
0076's shared `stagePersonProposal` — Alice, Simon become People, on the
same consent path as every other email-learned person. Dedups against known
people + pending proposals. Extracted to `email/person-proposal.ts` so
`trip-extraction.ts` can call it without closing a
`magics → trip-extraction → person-extraction → magics` import cycle.

**Nothing past ever surfaces.** A "flight change" email for a trip that has
already happened stages nothing; a mid-trip one keeps only the legs still
ahead (`departAt` day ≥ the user's local today) and a trip covering just
those — ADR 0137's posture for a date already lived through, which this pass
bypassed by staging `create_trip`/`add_travel_leg` rather than `create_event`.
A hotel whose checkout is past is skipped. **Also fixed:** the deployed
`create_task` magics path had no such guard — `shouldStageTaskProposal` now
refuses a `dueAt` already past (mirrors `shouldStageEventProposal`), so
"confirm attendance for the Sep 5 reservation" no longer arrives on Sep 11.

**The proposal carried a route and a time and nothing else.** A booking email
has a carrier PNR *and* often a booking-site itinerary/order number (Expedia
`Itinerary #`), plus a passenger. `Flight` gains `itineraryNumber`;
`travel_legs` + `accommodations` gain a `notes` column (migration `069`;
`trip_reservations` already had one) holding "Itinerary <n>" when it differs
from the PNR. `createEvent` gains a `description` (the events row + Google
push already had the column), and `syncFlightLegEvent` composes it —
`Passenger:` / `Confirmation:` / the itinerary line / **a one-tap link back to
the source email** via `providerThreadLink` (ADR 0107), resolved from the
leg's `gmail:<threadId>` provenance (`email/thread-link.ts`, primary +
attached mailboxes). `addTravelLeg`'s calendar sync becomes **awaited**, not
fire-and-forget: a bundle confirm runs it inside a transaction, so the event
insert must land before commit.

## Consequences

- `event_attendees`-style: `trips` gets its first email-derived producer; the
  bundle confirm / Action Items UI / briefing already handle it.
- A `travel/` thread that stages a trip bundle does **not** also get an ADR
  0138 `flight_json` tile fact — the actionable leg supersedes the fact.
- One extra classifier LLM call per `travel/`-category thread, once, until
  marked. `EMAIL_TRIPS_ENABLED=false` disables it whole.
- Removing a leg/stay from a proposed bundle before confirm is not built —
  it is confirm-all or dismiss-all, as every bundle is.
- `createEvent` gains `description`; every existing caller is unaffected
  (absent → `null`, exactly as before).
