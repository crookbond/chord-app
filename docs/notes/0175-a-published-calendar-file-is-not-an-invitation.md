# 0175 — A published calendar file is not an invitation

**Status**: accepted
**Date**: 2026-09-15

## Context

A user forwarded a real Expedia hotel confirmation (from an attached
Outlook/Hotmail mailbox, ADR 0080) into their primary Gmail to force it
through the magics pipeline. The correctly-classified `travel/hotels`
thread still never produced a trip proposal — instead it silently became a
bare `create_event` with `alreadyInGoogle: true`, the shape ADR 0074's
calendar-invite path produces.

`inviteEventForMessage` (`invite-ics.ts`) runs BEFORE the ADR 0158 `travel/*`
trip-classifier short-circuit in `runEmailMagics`'s per-thread loop, on
purpose — a genuine meeting invite is authoritative and must never be
LLM-guessed at (ADR 0074). But `probeResultFromIcs` treated **any**
successfully-parsed `.ics` MIME part as `isInvite: true`, with no look at
the iCalendar object's own `METHOD` property. Expedia — like airlines,
venues, and most booking confirmations — attaches a `.ics` so "Add to
calendar" works, stamped `METHOD:PUBLISH`: RFC 5546's term for "here is a
calendar object," not "please accept or decline this." A hotel/flight
confirmation that happens to embed one of these self-describing itinerary
files got routed around the trip classifier into a generic, unenriched
calendar entry instead — permanently, since the thread is marked handled
either way (ADR 0137's one-outcome-per-thread).

## Decision

`probeResultFromIcs` now reads the same `method` `parseIcsBuffer` already
extracts and only treats the message as `isInvite: true` when it's one of
the iTIP transaction methods that actually asks something of the recipient
or reports on a prior transaction: `REQUEST`, `CANCEL`, `REPLY`, `COUNTER`,
`DECLINECOUNTER`. `PUBLISH` — and no `METHOD` line at all, which RFC 5545
treats the same way, a bare calendar object outside any scheduling
transaction — now returns `isInvite: false`, letting the thread fall
through to the `travel/*` trip classifier or the general magics extractor
as if no `.ics` were attached at all.

The `catch` branch (a `.ics` MIME part that failed to parse) is unchanged:
still `isInvite: true`, still skips LLM extraction rather than guessing —
that posture is about "we don't know what this is," a different situation
from "we know exactly what this is, and it isn't asking to be answered."

## Alternatives considered

- **Inspect `ORGANIZER`/`ATTENDEE` instead of `METHOD`** — a real invite
  reliably sets both, but so does a self-itinerary that lists the traveller
  as their own organizer with no attendees; `METHOD` is the field RFC 5546
  actually defines for this exact distinction and the parser already
  extracts it for the cancellation-detection code path one line below.
- **Only fix the Gmail-side `.ics`-MIME-sniffing path (`probeResultFromIcs`),
  leave Outlook alone** — checked first, turned out to be the right scope
  on its own merits: Outlook's native probe (`invite-probe.ts`) gates on
  Graph's own `meetingMessageType`, which Graph sets only for genuine
  meeting messages, not merely for a message that has a `.ics` attachment.
  A plain confirmation email arrives with no `meetingMessageType` at all,
  so that path was never affected — nothing to change there.
- **Treat method-absent as still `isInvite: true`** (only fix `PUBLISH`
  explicitly) — rejected once checked against the actual parser behavior:
  a hand-authored or older `.ics` commonly omits `METHOD` entirely (RFC
  5545 makes it optional), and per RFC 5546 the absence of `METHOD` carries
  the same non-transactional meaning `PUBLISH` does explicitly. Treating it
  as an invite would have left exactly the Expedia-shaped case (or any
  `.ics` without an explicit method) unfixed.

## Consequences

- Any confirmation email (hotel, flight, restaurant, event ticket) whose
  provider attaches a `PUBLISH`-method or method-less `.ics` now reaches the
  trip classifier / general magics extractor as intended, instead of being
  silently absorbed into a bare calendar event forever.
- A genuine meeting invite is unaffected — real calendar invite senders
  (Google Calendar, Outlook, etc.) reliably set `METHOD:REQUEST`/`CANCEL`,
  which the existing test corpus already exercises.
- Pinned by `invite-ics.test.ts`: `PUBLISH`, no-`METHOD`, and
  no-calendar-structure-at-all inputs are not invites; `REQUEST` is; `CANCEL`
  is and still surfaces its cancelled UID.
