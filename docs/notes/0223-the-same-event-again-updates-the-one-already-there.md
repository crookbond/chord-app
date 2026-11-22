# 0223 — The same event again updates the one already there

Status: accepted (2026-10-02)

## Context

One flight was ending up as several calendar events.

- Several emails describe one flight (the booking, the e-ticket, a change
  notice), each worded differently, and each could become its own event. The
  only duplicate check lived in the bot's `create_event` handler and needed an
  identical title within an hour (`findSimilarEvent`), so "Flight to Delhi"
  and "AI 102 JFK→DEL" at the same minute were two events.
- An itinerary with two passengers makes one travel leg per passenger
  (ADR 0190), and `syncFlightLegEvent` keyed the calendar event to the leg id,
  so one flight with two passengers was always two events (the behaviour
  ADR 0185 recorded as working as designed).
- The conflict nudge runs after creation, so the twins were then reported as
  conflicting with each other.

Owner direction: the creation logic itself, not the model, should notice that
an event being created matches one already there and update that one.

## Decision

**One deterministic test, at the one place every event is created.**
`createEvent` runs `mergeIntoSameEvent` before inserting. The rule is
`isSameEvent` (`services/events/same-event.ts`, pure, unit-tested). Two events
are the same only when all of these hold:

1. Same owner.
2. The same start instant, and the same end instant when both have one.
   Compared as instants, so `21:30-05:00` equals `02:30Z`.
3. Not on two explicitly different calendars. An unspecified or `primary`
   target says nothing either way.
4. The same subject:
   - both are flights (a leg's own event, a flight number, or a flight word in
     the title) and they do not name different flight numbers or different
     routes; or
   - the titles share most of their meaningful words, or one contains the
     other, and their locations do not disagree.

Strict on time, loose on wording, because the wording is the part every email
changes. A flight at a different time is a reschedule, which the booking
reconciliation (ADR 0190) already owns.

**On a match the existing event is updated, not joined by a twin**
(`mergeEventDetails`): a missing end time or location is filled, the
descriptions are merged line by line (each passenger gets a block: one line with their own confirmation beside the name, then their own itinerary number and email link as bullets under it, so two bookings on one flight never read as a pile of unlabelled numbers; the older
"Passengers: A, B" list is still read; a source link appears once), and a
title that names the flight replaces one that does not. Nothing already there
is overwritten. The update is pushed to Google only when something changed.
`createEvent` returns the existing event with `merged`:
`updated` | `unchanged` | `covered`.

**An event that came from Google is left alone.** If the match was pulled from
a calendar (an airline's own invite), nothing is created and nothing is
edited: `covered`.

**One calendar event per flight.** A flight's event is found by what it is
(leg-made, same departure instant, same route by `placesMatch`), not by a leg
id, so every passenger's leg leads to the same event and adds its passenger.
When one passenger's flight moves and others stay, their name comes off the
old event and they join or create the event at the new time; when the last
passenger moves and nothing is at the new time, the event itself moves, as
before.

**A child's flight** (a managed persona's event, titled "Maya — …" on the
parent's calendar, ADR 0151) matches the parent's event for the same flight
and adds the child to its passenger list.

**Where each step sits.**

| Step | What happens |
|---|---|
| Suggestion staging | `isSameSuggestedEvent` and the covered-by-existing sweep also use `isSameEvent`, so a second email about an event already suggested or already on the calendar shows no new card. |
| Creation | Match → update the existing event. No match → create. |
| Conflict nudge | Only after a real create. A merged event raises none, and the bot is told to say the event was already there. |

So the user is alerted only when the events are not safely the same: the same
time but a different flight number, route, place or calendar, or times that
merely overlap.

**Not touched by the check:** repeating events, all-day entries, and anything
arriving with its own identity (a Google or device pull, an invite, an
imported `.ics`). They reconcile by key. A group event is compared only with
events in that group, so one member's private event at the same time cannot
swallow the copies the other members should get.

## Consequences

- Existing duplicates are left as they are (owner decision). Old per-passenger
  leg events keep their `chord:travel_leg:<legId>` key and are still found by it.
- Removing or cancelling a leg still does not touch its calendar event; that
  gap predates this change.
- `updateEvent` accepts a `description`.
- A false positive is possible in principle: two different meetings of one
  owner at the exact same start and end with near-identical titles. That is
  the case the rule is meant to merge.

## Rejected

- **Asking the model whether two events match** — the answer must be the same
  every time, and it runs on every create.
- **A time tolerance** — "about the same time" is how a rescheduled flight
  would be swallowed into the old one.
- **Requiring matching titles** — the reported duplicates differ exactly there.
- **Editing a Google-originated event** — it is not ours; pushing our wording
  onto an airline's invite is the ADR 0103 mistake.
- **A flight key stored on the event** — a schema change to record what the
  event's own time and route already say.
- **A cleanup script for existing duplicates** — owner chose to leave history.

## Addendum 2026-11-10: same time, same people = one meeting

Owner rule. Prod: Mark Clark's invite "Follow up: Neural Ads/ Post Oak
Group" synced into the Outlook calendar at 15:27:03; an email card
"Introductory Meeting with Mark Clark" was staged at 15:27:14 for the same
10:30-11:00 with Mark as guest, and confirming it made a second event that
invited Mark to his own meeting. The titles share no words, so the rule above
said "different".

- `isSameEvent` returns true when both sides list people and every address
  on one side is on the other (`samePeople`), checked BEFORE the calendar
  and title tests: the meeting is the same on whichever calendar it sits.
  Subset, not equality, because a new event's invitees never include the user
  while a pulled event's list does (and its organizer).
- Where the people come from: a pulled event keeps the guests and organizer
  its calendar lists in new `events.guest_emails` (migration 145, lowercased,
  written by the Google and Outlook pulls). It is a read-only copy for this
  test and is never sent: ADR 0295 still holds, the calendar owns the list.
  A new event's people are its invitees.
- Applied at all three doors: staging (`shouldStageEventProposal` makes no
  card for a meeting already on the calendar), the sweep
  (`retractProposalsCoveredByExistingEvents` withdraws one already staged),
  and the confirm (`createEvent` merges; for someone else's event it is
  `covered`, no guest change is attempted, and the ADR 0315 chat note says
  the meeting was already there and no invitations went out).
- With nobody listed on either side, the title rule decides as before.

Not covered: events pulled before migration 145 have no `guest_emails` until
the calendar re-sends them, and a Chord-only event (never pushed) has no
guest list to compare.

## Addendum 2026-11-19: a flight is on the calendar once

Reported: Delta DL2503 ORD→LGA showed 4-5 times on one calendar. Three causes,
each fixed:

1. **The calendar drew each flight twice**, as its calendar event and again as
   the trip's leg block. `legsNotOnCalendar` (kernel `calendar-layout.ts`)
   leaves a leg out when an event the viewer sees departs at the same moment
   and is that flight: leg-made (`chord:travel_leg:`), filed under the leg's
   trip (a family member's pulled copy), or naming its flight number or route.
   The event is kept (calendar colour, opens for editing). Day, week and list
   views.
2. **Remove left the flight's event behind.** `removeTravelLeg` deleted the leg
   only; two of the Southwest WN2909 / WN4501 Family events were left over that
   way. `releaseLegFlightEvent` now deletes the event, or, when someone else is
   still on that flight, takes only this passenger off it and hands an event
   keyed to this leg to one of them. The mailbox clean-up (ADR 0312) uses the
   same step, so disconnecting one mailbox no longer deletes a flight event
   another mailbox's passenger is still on.
3. **A booking with no reference was never joined.** The flight was first added
   in chat (no booking reference, 9:20 PM ET); Delta moved it five minutes and
   its email (HLA4A2) made a second leg on another chat's trip.
   `rescheduleSameFlight` (trips.service) treats the same traveler on the same
   flight number (by designator, else digits) and route, departing within 12
   hours, on any live trip in any group the user belongs to, as that flight:
   updated in place (time, a missing booking reference and notes) with its
   event. Two different booking references never match; more than one
   candidate matches nothing. Used by the email path (before trip matching),
   the uploaded-ticket path (before the trip shell is made) and `addTravelLeg`
   (a card staged before the booking existed, the bot tool).

Existing duplicates in prod were cleaned up by hand on 2026-11-19.
