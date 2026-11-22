# 0167 — A year-less ticket needs a "today" to resolve against

**Status**: accepted
**Date**: 2026-09-14
**Relation**: narrows [0158](./0158-email-body-through-the-trip-classifier.md) §4
("no past-dated proposal ever surfaces"), same class of bug as
[0074](./0074-timezone-anchoring-and-invite-reconciliation.md) and
[0098](./0098-briefings-need-a-real-recipient-and-a-real-zone.md) — a
piece of "now" the model needed and was never given.

## Context

Prod (`ownertest@gmail.com`): three real, upcoming bookings — a Denver
round-trip with three named passengers, a Toronto flight, a Vail hotel
stay — never appeared in the Trips tab. Checked against the live database
(read-only) rather than guessed:

- The two Denver threads carry `category_id` `…:mk:travel/flights`, are
  unarchived, unread-or-recent, and pass the bulk gate — every gate ADR
  0158's trip pass checks says these threads are minable.
- Both threads already carry an `email_extraction_marks` row (`kind:
  'magic'`), so `runEmailMagics` will never look at them again.
- One thread's mark left behind a real proposal: `create_event` titled
  "Flight to Denver", `startsAt: 2027-02-11T20:55:00-05:00` — correct, a
  year ahead of "today" (Sept 2026) — but it's a plain calendar event, not
  a trip, and it **expired** unconfirmed. The sibling thread's mark left
  no proposal of any kind.
- The email body itself (Booking.com) is a complete, legible itinerary:
  named route (LGA→DEN), airline, flight numbers, a departure printed as
  "Thu, Feb 11 · 8:55 PM" — **no year**, matching every airline/OTA
  confirmation format, because the reader already knows "now" and the
  ticket doesn't need to say so.

That the general magics extractor recovered 2027 while the trip
classifier — run on the *same body*, moments apart — did not, rules out
"the LLM can't read this email." The difference is the prompt.
`magics.service.ts`'s extractor prompt includes an explicit `Today:
${...}` line; `bot/trip_classifier.ts`'s `buildTextPrompt`/
`buildVisionPrompt` (shared by every classification kind —
flight/hotel/restaurant/movie/calendar/recipe) carried none. With no
anchor, the model's year guess is unconstrained, and `stageFlight`'s own
correct-by-design guard —

```
.filter((a) => dayOf(a.departAt, opts.userLastTz) >= today)
```

— (ADR 0158 §4, the rule that keeps a settled trip out of the Trips tab)
cannot tell "the booking already happened" from "the model guessed 2026
instead of 2027 with today in September." A wrong-year `departAt` is
indistinguishable from a real past date once it reaches that filter, so a
genuinely upcoming flight is silently discarded — `legArgs.length === 0`
→ `'none'` → falls through to the general extractor, which (for exactly
one of the two threads, on that one call) happened to land on the right
year anyway. Every date-bearing kind this classifier handles
(`restaurant.dateTime`, `movie.dateTime`, `hotel.checkinDate/
checkoutDate`, `calendar.events[].startsAt`) shares the same unanchored
prompt and is exposed to the same failure mode whenever the source omits
a year and the current date has already passed that month-day this year
— which, for any ticket mined more than a few weeks after New Year's, is
most of them.

## Decision

**Give `classifyTravelDocument` the same `Today:` anchor
`magics.service.ts` already gives its own extractor**, plus an explicit
instruction for resolving a year-less date against it: on-or-after
Today → this year; already passed → next year.

`today` (`YYYY-MM-DD`, in the traveller's own zone — ADR 0074's rule, not
the server's clock) becomes a **required** parameter of
`classifyTravelDocument` and of the injectable `TravelClassifier` seam
(`trip-extraction.ts`), threaded from both real callers:

- `stageEmailTripProposal` (the email-body path this incident hit) —
  `dayOf(new Date().toISOString(), opts.userLastTz)`, reusing the same
  helper `stageFlight`/`stageHotel` already call for their own past-date
  guard, so the anchor and the filter that reads it can never disagree.
- `classifyAndAutoFileAttachment` (the upload path) — derived from
  `uploaderTzOffsetMinutes`, which this function already resolves for its
  calendar-date filing.

Required, not optional-with-a-silent-default: a function that quietly
falls back to the server's own clock is the exact mistake ADR 0098
diagnosed for `nextScanDate`, and an *optional* parameter here would let
a future caller compile clean while reintroducing this bug.

## Consequences

- Fixes the failure class for every classification kind this prompt
  produces, not flight-only — a restaurant reservation or movie ticket
  with a bare month-day is exposed to the identical ambiguity.
- Existing test doubles for `TravelClassifier`
  (`async () => ({ kind: 'flight', ... })`, ignoring all arguments) stay
  valid: TypeScript allows a function with fewer declared parameters to
  satisfy a type expecting more.
- **Does not retroactively fix the three prod threads already burned.**
  `runEmailMagics`'s top-level query excludes any thread already carrying
  an `email_extraction_marks` row of kind `'magic'`, and that mark is
  never cleared by design (ADR 0110: "the mark is the only guard against
  re-proposing what was already rejected"). These three threads were
  marked by a pass that ran under the *unfixed* prompt, which is a
  different situation than "correctly declined" — but the mark carries no
  record of which. Re-mining them needs a deliberate, separate step (a
  one-off clear of the `'magic'` mark for the affected `gmail_thread_id`s,
  or for `travel/*`-category threads generally, run once against prod
  after this ships) rather than a silent broadening of what
  `runEmailMagics` selects — left as a follow-up so it can be scoped and
  reviewed on its own, not bundled into a prompt fix.
- The deeper issue this incident is one instance of — an extraction mark
  has no notion of *which capability* was tried, so a thread mined before
  a classifier gained a new ability (trips, ADR 0158) or a fix (this ADR)
  can never benefit from it — is not addressed here. Noted for whoever
  next adds a classification capability: the mark will silently exclude
  every thread mined before it existed.

## Rejected

- **A silent fallback to the server's own `new Date()`** when a caller
  omits `today` — reintroduces exactly the bug ADR 0098 fixed for the
  briefing scheduler, in a new place, and hides the mistake behind a
  type that still compiles.
- **Fixing only `stageFlight`'s hotel/flight prompt path** rather than
  the shared `buildTextPrompt`/`buildVisionPrompt` — leaves
  restaurant/movie/calendar dates carrying the identical unanchored
  ambiguity, for no simpler an implementation.
- **Clearing/re-keying extraction marks as part of this change** — the
  prompt fix and the "let three already-mined threads be tried again"
  decision are independent: the first is unconditionally correct, the
  second is a one-time operational step against real user data that
  deserves its own review rather than riding along.
