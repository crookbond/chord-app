# 0177 — A parsed .ics is deterministic context everywhere, not just for trips

**Status**: accepted
**Date**: 2026-09-15

## Context

Forwarding the Expedia hotel confirmation for Evergreen Lodge at Vail through
the primary Gmail (ADR 0175's fix) still didn't produce a trip: the trip
classifier read the booking prose correctly except for one thing airlines,
hotels and venues routinely omit — the departure/check-in **year** ("Thu,
Feb 11 · 8:55 PM" with no `2027`). ADR 0167 gave the classifier a `today`
anchor for exactly this ambiguity, but `today` only resolves *relative*
dates ("this Sunday"); a bare month/day with no year at all still has to be
guessed, and the guess can land a year off in either direction. `stageFlight`
/`stageHotel`'s own "nothing past ever surfaces" filter (ADR 0158 §4) then
silently drops a wrong-year-into-the-past guess as if the booking didn't
exist — the same failure mode ADR 0167 diagnosed, one layer further in.

The email carrying that ambiguous prose, though, had exactly the fact
missing from it: `probeResultFromIcs` (ADR 0175) already deterministically
parses the attached `.ics`'s `DTSTART`, which *does* carry a real year, and
was simply discarding it whenever the message wasn't a genuine invite.

Fixing the trip path alone would have been narrow in exactly the way ADR
0158 warned against ("two pipelines do the same job and only one was fed"):
the *general* magics extractor (`EXTRACT_SYSTEM`/`llmExtractor` in
`magics.service.ts`) reads the identical email body for `event`/`task`/`list`
suggestions, with the identical year-guessing exposure, whenever the thread
isn't `travel/*`-classified. A birthday-party invite, a concert ticket, a
webinar confirmation — anything that ships a plain `.ics` for "Add to
calendar" alongside prose that assumes the reader already knows the year —
has the same bug, unfixed, one call site over.

## Decision

**A non-invite `.ics` is deterministic context, wherever the email lands.**
Two mechanisms, one per failure mode, both fed from the same probe result:

1. **`InviteProbeResult.event` is now populated regardless of `isInvite`**
   (`invite-ics.ts`) — a PUBLISH/no-`METHOD` self-itinerary (ADR 0175) still
   parses to a real `ParsedIcsEvent`; only the *routing* decision (invite vs.
   not) depended on `METHOD`, and nothing about reading the VEVENT's own
   fields should have depended on it too.

2. **`magics.service.ts` hoists the parsed event into two forms**, set
   together the moment the probe returns a non-invite result with an event:
   - `icsDateHint` (a bare date string) — threaded into
     `stageEmailTripProposal` exactly as before, and now *also* applied as a
     year-correction backstop on the **general extractor's own output**:
     `icsYearCorrection`/`shiftYear` (already built for the trip classifier,
     unchanged) run against `suggestion.startsAt`/`endsAt` for an `event`
     kind and `suggestion.dueAt` for a `task` kind, shifting the year only
     when month/day already agree and the year doesn't — the narrow,
     unambiguous case both functions were written to catch.
   - `icsContext` (a formatted block: title/start/end/location) — a new
     `MagicThreadInput` field, appended to the LLM prompt as "Attached
     calendar file (authoritative for date/time)" alongside the existing
     attachment-text and world-context blocks. `EXTRACT_SYSTEM` gains one
     rule: trust this block's date/time over the prose, keep reading the
     body for everything the bare VEVENT doesn't carry (confirmation
     number, address, why the recipient needs to act).

Both are **grounding, never a replacement** — the model still reads the full
body for everything a VEVENT can't hold, and a thread with no `.ics` (the
common case) is byte-for-byte unaffected: `icsContext`/`icsDateHint` are
`undefined`, the new prompt line and the correction step are both no-ops.

## Alternatives considered

- **Fix only the trip classifier** (the originally-scoped version of this
  ADR) — this is exactly the ADR 0158 mistake restated: the trip path and
  the general extractor read the same body for the same class of ambiguity,
  and fixing one leaves the other silently wrong until its own prod report
  arrives. Owner instruction ("for everything, not just trips") made this
  explicit rather than left to be rediscovered.
- **Feed `icsContext` to `person-extraction.ts` too** — considered and
  dropped: that pass extracts *people/family facts*, which a VEVENT has
  nothing to say about (no attendee list is captured from a plain
  `.ics`, ADR 0175's own scope), so there is no ambiguity for it to ground.
  The mechanism generalizes to every pass that extracts a **date**, not to
  every pass that reads a thread with an `.ics` attached.
- **Replace the LLM read with the `.ics` outright** (the question that
  originally prompted this investigation: "should we not just import ICS?
  why run LLMs over them?") — rejected on the same reasoning ADR 0074 and
  0158 already settled: a booking confirmation's `.ics` is usually thinner
  than its body (no confirmation number, no address, no passenger name),
  and importing it as the whole answer would lose everything the prose
  states that the calendar file doesn't.
- **A silent, unconditional year correction with no month/day agreement
  check** — rejected on `icsYearCorrection`'s own existing design (ADR
  0167's build): a genuinely different date on the `.ics` (a different
  event mentioned in the same thread) must not overwrite the model's own
  read, so the function only fires when month/day already match and only
  the year is in question.

## Consequences

- Any email carrying a non-invite `.ics` — travel or not — now grounds
  *every* extraction path that reads its body, not just the trip classifier:
  a year-less concert ticket, a webinar confirmation, a birthday-party
  Evite-style attachment all get the same backstop a Booking.com itinerary
  already had.
- Zero behavior change for the overwhelming majority of mail with no
  attached calendar file, and no new LLM call — `icsContext` rides the
  existing single extraction call, exactly like `attachmentText` and
  `worldContext` already do.
- Pinned by `ics-year-correction.test.ts` (the pure date-math, unchanged),
  the extended `invite-ics.test.ts` (event surfaces on PUBLISH/no-METHOD,
  not just REQUEST/CANCEL), `trip-extraction.integration.test.ts`'s
  "a non-invite .ics date hint corrects a wrong-year guess" case, and a new
  `magics-ics-context.integration.test.ts` proving the general extractor
  both receives the grounding block and has its own wrong-year guess
  corrected the same way.
- Does not retroactively fix a thread already mined stale before this
  shipped — its `'magic'` extraction mark is never cleared by design (ADR
  0110); re-mining specific prod threads remains a deliberate one-off
  operational step (ADR 0167's same follow-up shape), not bundled here.
