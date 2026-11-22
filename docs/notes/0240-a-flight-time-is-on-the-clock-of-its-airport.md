# 0240 — A flight time is on the clock of its airport

Status: accepted (2026-10-11).

## Context

Reported: a flight leaving Delhi at 1:50am local and landing in New York at
9:00am, for a user in New York, went on the calendar as 1:50am to 9:00am New
York time — a 7h10 flight that is really 17h40 and starts at 3:20pm the day
before. The arrival was right only because it lands in the reader's own zone.

A ticket prints two times on two different clocks. ADR 0074's rule — a bare
datetime gets the user's offset — is right for "dinner at 7" and wrong for a
departure. A dry run through each way a flight is filed showed the departure
getting the reader's clock in three of them:

- **Trip classifier** (uploaded ticket, itinerary email — ADR 0158).
  `departZone`/`arriveZone` are optional in the model's reply. When one was
  missing, `zonedDatetime` fell back to the reader's zone without saying so.
- **Chat `add_travel_leg`.** The tool had no field for whose clock a time was
  on, and the system prompt tells the model to put the user's offset on every
  datetime. There was no way for this path to be right.
- **General email extractor** (`magics.service.ts`), for flight mail the trip
  classifier does not take. Its timezone rule reads every time in the email as
  the user's, so both the suggested `create_event` and the stored flight facts
  (ADR 0138) carried the departure in the user's zone.

## Decision

**Each end of a leg is anchored to its own airport, and the airport is looked
up, not asked for.**

- `kernel/src/airport-zone.ts` — `airportTimeZone(place)` maps the metro keys
  `resolveMetro` already produces to an IANA zone, so an IATA code, an airport
  name or a city all resolve, and every airport in one metro shares a zone.
  An unknown place answers `null`.
- `legDatetime(raw, place, statedZone, readerOffset, readerTz)`
  (`bot/trip_classifier.ts`) picks the zone: the airport table first, then the
  zone the model stated (if the runtime accepts it), then the reader's zone as
  before. The table comes first because it is the same answer every time; the
  model's zone is used only where the table has none.
- A value that already carries an offset is re-anchored **only when that
  offset is the reader's own** on that date. That is the one mistake a model
  makes here. `Z`, the airport's own offset, or any third offset was chosen on
  purpose and is left alone.
- All three paths call it: the trip classifier's leg sites, the executor's
  `add_travel_leg` case (before trip matching, so matching sees the right
  instant), and `anchorFlightTimes` in the email extractor, which also moves
  the suggested event when its start/end are the flight's departure/arrival.
- Prompts say the same thing: `add_travel_leg` gains optional
  `departZone`/`arriveZone` and its description says the times are the
  origin's and destination's local clock; the email extractor's timezone rules
  gain a travel exception.

## Consequences

- The reported flight lands as Nov 9 3:20pm to Nov 10 9:00am New York time on
  all three paths. Tests cover each and were seen failing with the old
  symptom (`01:50:00-05:00`) with the fix switched off.
- **Existing legs and events are not corrected.** A leg already stored with
  the reader's offset keeps it; fixing those is a separate one-off.
- **An airport outside the table with no stated zone still falls back to the
  reader's zone** on the unattended paths (upload, email). The table covers
  the hubs in `airport-metro.ts`; a regional field is a one-line addition.
- A model that *converts* a departure into the user's time (rather than
  stamping the printed time with the user's offset) would now be moved the
  wrong way. The prompts tell it not to; nothing can tell the two apart from
  the value alone.

Same pattern, not fixed here — each needs a venue's zone, which no table
gives (it would take geocoding an address):

- `bot/trip_classifier.ts` restaurant and movie times (`toLocalDatetime` with
  the uploader's zone): a dinner booked in Paris by someone in New York.
- `add_reservation.dateTime` in chat (`normalizeDatetimes` with the asker's
  zone): the same case on a trip.
- A non-travel `create_event` for something in another city.

Hotel check-in/out are dates, not instants, so they are not affected.

## Rejected

- **Requiring the zone from the model** (make `departZone` mandatory, refuse
  without it). The model is the part that got it wrong; a lookup does not.
- **Refusing a chat leg whose airport is unknown.** It would block a
  same-zone train or a regional flight to fix a case the fallback already
  handles as well as before.
- **Re-anchoring every offset-carrying value to the airport's zone.** A
  correct `Z` or converted time would be moved; only the reader's own offset
  is a known mistake.
- **Model's zone before the table.** Two answers for one airport depending on
  the reply, and the wrong one wins exactly when the model is wrong.
- **Correcting stored legs in the same change.** A stored `-05:00` on a
  Delhi departure is indistinguishable from a deliberate one without the
  source; that needs its own pass with a report first.
