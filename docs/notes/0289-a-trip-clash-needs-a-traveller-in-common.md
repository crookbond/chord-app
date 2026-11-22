# ADR 0289 — A trip clash needs a traveller in common

**Status:** Accepted (2026-10-22)

## Context

Two places tell the user an event clashes with a trip:

- the morning briefing's `CONFLICTS` list (`loadScanContext`,
  `proactive.service.ts`), which said an event "falls during the trip" when its
  day was inside the trip's dates;
- the check that runs when a trip is added (`loadNudgeContext`), which gave the
  model every blocking event within two days of the trip start
  (`NEIGHBORS`) and every other trip covering that day (`TRIP_OVERLAPPING`).

Both decided on time alone. A parent's dentist appointment was reported as a
clash with a child's school trip, though the parent is not going. The trip often
says who is travelling (ADR 0190: legs carry `persona_id` / `passenger_name`,
plus `trip_participants`), so time alone is wrong whenever that is known.

## Decision

A clash with a trip needs BOTH the time and a person in common. When the trip
names nobody, time alone decides, as before. One module,
`server/src/services/trips/trip-conflict.ts`, answers it for both places.

- **Who is on a trip** (`loadTripTravelers`): members in `trip_participants`, a
  live leg's `persona_id` (a user id), and the names on its live tickets.
  Cancelled legs are left out. The booker is NOT a traveller (ADR 0190).
- **Who an event is for** (`loadEventPeople`): its assignee — a member
  (`assignee_id`) or a managed family member by persona name and linked account
  (ADR 0151) — else the owner of that calendar copy (ADR 0040).
- **Plus the title**: a traveller whose FIRST name is a whole word of the title
  ("Ben soccer") is in it. First name only — a family shares a surname, and
  "Doe family dinner" is about no one traveller.
- **Matching**: same user id, or names that are the same words in any order, or
  one a shorter subset of the other ("Ada" vs ticket "DOE/ADA MS"), using
  `chain.ts`'s ticket-name handling.
- **Trip vs trip** (new-trip check): overlapping trips clash only if someone is
  on both; if either names nobody, time alone.

The briefing filters its "falls during the trip" lines; the new-trip check
filters `NEIGHBORS` and `TRIP_OVERLAPPING` before the model sees them, so the
model is never handed a non-clash to judge.

## Consequences

- An unassigned event with a family member's name only as a surname, a nickname,
  or not at all is judged by its owner. "Pick up Ben from airport" still
  clashes (title names him); "School concert" on a child's trip, owned by a
  parent who is not travelling, no longer does.
- A same-first-name stranger on a ticket matches a member's first name — the
  safe direction (an extra warning, never a missed one).
- The event-created nudge (kind `event`) is deterministic and has never looked
  at trips; unchanged.

## Addendum 2026-10-23 — a ticket is its travellers' time

The rule above covered an event against a TRIP. A trip's tickets also sit on
the booker's calendar as events (`external_uid` = `chord:travel_leg:<legId>`),
and two of those overlapping were still a clash by time alone: the prod
briefing said "Tomorrow's Oct 24 Amtrak and flights overlap" for two
different travellers' tickets, and Ben's flight was busy time for his
parent.

- **Event vs event** (`eventsClash`): two of the user's own events still clash
  on time. A ticket clashes with another ticket only if someone is on both
  trips (`tripsClash`), and with an ordinary event only if that event's
  person is travelling (`eventClashesWithTrip`) — the same rule as above.
- **Busy time** (`ticketsForOthers`): a ticket on a trip that names its
  travellers, none of them the user, is not the user's busy time. Applied in
  `computeConflicts` (the event-created nudge, `find_conflicts`) and
  `busyIntervalsInWindow` (`get_my_availability`, the reply drafter, the email
  extractor's free slots), and a ticket created for someone else raises no
  nudge at all. A trip that names nobody is still treated as the user's.
- **The add-time check** (`loadNudgeContext` `NEIGHBORS`): for a new event,
  someone else's ticket is left out; for a new trip, a ticket among the
  neighbours is judged by its own trip's travellers (`ticketTravelers`,
  `tripsClash`), not by the calendar's owner.
- **Shown as free** (`trips/ticket-free-busy.ts`): a ticket's event is one
  copy on the booker's calendar (an event with an external uid is not fanned
  out); it is stored `transparency = 'transparent'` when the trip names its
  travellers and the booker is not one of them, `'opaque'` otherwise, and
  queued for the push — so Google, Outlook and the phone show someone else's
  flight as free and a real clash is easy to see. Set when the ticket's
  event is made or updated (`syncFlightLegEvent`) and re-checked hourly from
  the proactive tick for upcoming tickets, which catches travellers changed
  any other way and fixes tickets made before this. Enforced both ways on
  ticket events (Chord made them), so a traveller added later gets busy
  back. The Google push sends the stored value; the phone mirror sets
  `availability` FREE/BUSY (same call on iOS and Android).

## Addendum 2026-10-24 — the same journey under another name; titles retired

The prod briefing the morning after still said "Amtrak 101 NYP→PHL overlaps
Amtrak Northeast Regional Train and Flight to Toronto YYZ" (Ben's train;
the Stones' flight) and "Send Ben Money ... falls during Ben's Chicago
trip". The addendum above was deployed and working: the clash came from the
OTHER entries. Amtrak's own invite ("Amtrak Northeast Regional Train from New
York to Philadelphia") and a Google entry "Flight to Toronto YYZ" carry no
`chord:travel_leg:` uid, so they were the owner's own events and clashed with
each other on time alone.

- **Same journey, any name** (`ticketTrips`, `legMatchStrength`): an entry
  with no leg uid is a ticket when a live leg, on a trip in a group its owner
  belongs to, departs within 10 minutes of it AND its title/location names
  that leg's flight/train number or destination (by metro, `resolveMetro`, or
  the code as a word). Naming only the origin is weaker and loses to a
  destination match; two trips equally good leave it an ordinary event. Used
  by the briefing, `computeConflicts`, `busyIntervalsInWindow` and the
  add-time check wherever they pass the event's start/title/owner.
- **The link is stored, and the user's word wins** (migration `122`,
  `events.trip_id` + `events.trip_link`): what the matcher finds is saved on
  the entry (`'auto'`), so it is worked out once, not every morning. The user
  can correct it in chat with `set_event_trip` ("the Toronto flight is the
  Stones' trip", "the 8:45 flight is mine, not travel") - stored as
  `'user'` (`trip_id` NULL = not travel), which the matcher never
  overwrites. One writer, `setEventTrip`: the user's own calendar copy, a
  live trip in a group they belong to (from the personal chat any of their
  groups, from a shared chat that chat's trips only, ADR 0032/0096). Order
  read: the user's answer, then a leg's own entry, then a stored match (while
  its trip is live), then the matcher. Event lists carry `tripId`,
  `tripName`, `tripTravelers`, and the calendar's event sheet and web hover
  say "✈️ Part of the <trip> trip · <names> travelling" (same on iOS,
  Android and web). Correcting is chat-only on purpose: the sheet shows the
  link, editing it in the app is not built.
- **One journey written twice is no clash**: two entries of the same trip
  never clash (`OverlapSide.ticketTripId`), and the briefing lists such a
  second entry once, under the leg's own entry.
- **Titles no longer make someone a traveller.** The rule "a traveller's
  first name in the title" is retired: "Send Ben Money" is the parent's
  errand during Ben's trip, not something Ben misses (owner: nothing on
  my calendar conflicts with a trip I am not on). Instead the event's MAKER
  joins its owner (`loadEventPeople`), so a child's own event shared to the
  family still counts as theirs. Assigning an event to the traveller
  (`assignee_id` / persona) still makes it theirs.
- **Free rule** (ADR 0040, `computeTransparency`): an event of 5 minutes or
  less is free (was strictly under 5); and the briefing now passes all-day
  events as all-day, which it had been leaving out, so a full-day entry
  blocked the whole day.

Also from that briefing, outside this ADR: the weather now comes first,
above the birthdays (amends ADR 0272's order), and the email count line gives
each category's UNREAD count — it printed each category's total threads after
"6 unread —".

## Addendum 2026-11-11 - a trip that names nobody asks who is going

Prod: a family "Trip to Ann Arbor" with no tickets had nobody recorded as
travelling, so the new-trip check fell back to time alone and flagged the
booker's own "John and Yash" and "Get skis", unable to say whose trip it
was. John answered in his personal chat ("Trip to Ann Arbor is Ben
Doe") and got "need disambiguation". Three causes:

- **Nowhere to store the answer.** `trip_participants.persona_id` is a USER
  id, and `assignPassengersToTrip` only writes names onto existing legs, so
  a family member without a Chord account (a managed persona, ADR 0151) on
  a trip with no tickets was stored nowhere. **Anyone can be a traveller**
  (owner): family or a friend, with or without an account. New
  `trip_named_travelers` (trip, `name_key` = the name's token set, `name`,
  optional `personas.id`; one row per person; migration `147`);
  `services/trips/travelers.ts` `resolveTripTraveler` looks a name up among
  the trip's GROUP's members and personas (exact name, else the one person a
  first or fuller name fits; several or none = kept as typed by
  `travelerByName`, never pinned to the wrong person), and
  `addTripTravelers` writes members to `trip_participants` and everyone else
  to the new table, on the trip itself, with or without tickets; a name said
  again later with a persona behind it gets linked. Read by
  `loadTripTravelers` (clashes) and `whoseTrips` (wording); copied on merge
  and regroup; on `share_trip` (or a persona deleted) the persona link is
  dropped and the name kept. `set_trip_passengers` and `set_leg_passenger`
  use it, in the trip's own group; the result lists names saved by name
  only (`byNameOnly`). A name-only traveller has no calendar, so they clash
  with nobody's events.
- **The personal chat could not see the family trip.** The nudge is posted
  in the personal chat, but `resolveTripId` listed only that chat's trips, and
  a hint matching none fell back to all of them, so two personal trips made
  the answer ambiguous. On a personal turn it now lists the trips of every
  group the user is in (ADR 0096), and a hint that is a whole sentence
  matches a trip whose full name is inside it (only when the normal match
  finds nothing, names only).
- **A guessed conflict.** A new trip that names nobody now gets a question,
  not a conflict check: "Who is going on "<trip>" (<dates>)?"
  (`whoIsGoingQuestion`, no model call). The trip is kept in
  `bot_pending_state` kind `trip_travelers` (3 days) and read into the
  personal chat's prompt with its id (ADR 0166's pattern) and into the tool
  hints, so `set_trip_passengers` is sent; answering it re-queues the
  conflict check, which then runs against the travellers.

Not changed: the morning briefing still checks a trip that names nobody on
time alone; the Trips tab does not yet show a name-only traveller (the
`Trip` DTO lists user ids). Writes still stay where they were asked from in
a SHARED chat: a shared chat's bot sees only that chat's trips (ADR
0004/0032 - everyone in it would see the answer); only the personal chat
reaches across every group the user is in.

## Rejected

- Asking the model to judge the person: it already could not do interval
  arithmetic reliably (why the event nudge went deterministic).
- Surname matching in titles: flags every family event.
- Treating the booker as a traveller: ADR 0190 says the booker may not be going.
