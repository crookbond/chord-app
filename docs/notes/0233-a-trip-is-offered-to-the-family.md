# 0233 — A trip is offered to the family

**Status**: accepted
**Date**: 2026-10-09

## Context

ADR 0232 made events personal by default, with fan-out an offer the user
accepts. It left trips and flights out: "Not done — an email-derived trip is
approved as a bundle whose card has no group choice." The owner wants them
offered anyway — a trip is exactly what a family plans around ("helps with
planning if one person is traveling"), and since 0232 a flight lands on its
creator's own calendar and nobody else sees it.

## Decision

**A trip starts personal; sharing it with a group is a visible choice, never a
default.** Three entry points, one rule:

1. **Chat.** After `create_trip` or `add_travel_leg` in the personal 1:1 the
   result carries a `shareSuggestion`; the bot asks once, and `share_trip` is the
   yes. The offer is remembered server-side in the same `pending-fanout` record
   the event offer uses (now carrying `kind: 'event' | 'trip'`), because a tool
   result does not survive a turn (ADR 0093/0166) — a bare "yes" next message
   still means that trip. One offer at a time per user, so "yes" is never
   ambiguous; once per trip, so a five-leg itinerary is one question, not five.
   Only on a live bot turn: a proposal committing has no one to ask.
2. **Approving an emailed trip.** The trip bundle card in the Trips tab gets the
   same "Just me / <group>" choice a single suggestion has had since ADR 0097.
   `confirmProposal` now honours a group on a **trip** bundle: the trip is created
   in that group and every member of the bundle runs there, because a leg or stay
   checks that its trip lives in the group it is added from. A bundle with no
   trip in it (a screenshot bundle, ADR 0029) still ignores a group, for 0097's
   reason: it is several unrelated entities in one tap.
3. **A trip that already exists** is moved by `shareTripWithGroup`, which the chat
   path calls.

**What "share" moves.** A trip belongs to one group (`trips.group_id`); legs,
stays and reservations follow it by `trip_id`, so the move is one column plus the
things that hang off the group id and would otherwise half-work:
- the calendar event each flight leg created. The leg sync finds it by
  `(group_id, external_uid)`, so an event left behind in the old group would be
  duplicated the next time a leg is added — pinned by a test that adds a second
  passenger after the move;
- the catch-up fan-out, so the other members see it in their own folders;
- participants (user ids, despite the column being called `persona_id`): anyone
  not in the new group is dropped, since the group could not see who they are.

**Only a personal trip moves, only the creator's, only into a shared group they
are in.** "Share" widens who sees something private, so it is never offered for
a trip that is already in a group, and a refusal moves nothing.

**What the family gets, and what it doesn't.** The trip — in the group's Trips
tab, in the bot's travel context for that group, and in the briefing. The flight
is **not** put on everyone's calendar: the leg event keeps its one owner-copy.
Putting a relative's flight on four Google calendars is a bigger step than
"suggest sharing", and a wrong guess is visible to everyone.

**Who is offered.** Deterministic, no model call, and the same matcher as the
event offer (so the two never disagree about what "names someone" means):
1. a person named on the trip (a leg's passenger or the trip's own name) who is
   in one of the asker's shared groups picks that group; otherwise
2. if the asker is in exactly **one** shared group with other people in it, that
   is their family and it is offered even with no name on the trip (a booking in
   a mailbox usually names only the traveller).
With several groups and no name to choose between them, nothing is offered — a
guess between "Family" and "Soccer Team" is a question the user did not ask.
Never for a trip already shared, one that is over, or one that is cancelled.
Group names are shown as the user sees them (ADR 0101).

## Consequences

- **Not covered: a trip filed from an uploaded document.** An itinerary
  screenshot or PDF is filed by the attachment auto-filer, which posts nothing
  itself, and the bot's turn on a bare upload is told to call no tool (ADR 0220),
  so there is no voice to ask. Those trips stay personal and can be shared by
  asking in chat. Closing this means the filer announcing what it filed — its own
  small design.
- **The offer for an emailed trip is a card choice, not a sentence**: nothing
  prompts it in chat. It only shows for a bundle that creates a new trip.
- **The offer is in-memory.** A server restart forgets a pending offer and the
  user's "yes" gets `nothing_pending` — an honest refusal, not a wrong share.
- **Re-sharing is not supported** (group to group). Only the personal-to-group
  step exists.

## Rejected

- **Copying the flight onto every member's calendar as part of "share"** — see
  above; deferred.
- **Always offering to the first group** — with two groups that is a guess.
- **A server-computed "suggested group" highlight on the bundle card** — the
  card already lists the shared groups; a pre-selected chip would make the
  default a share, which is what this ADR refuses.
- **A new trip table row per group instead of moving one** — two trips for one
  journey, with legs and the flight event to keep in step.
- **Letting `share_trip` take a trip id** — the model would have to carry an id
  across a turn it cannot remember; the record already knows which trip it
  offered.
