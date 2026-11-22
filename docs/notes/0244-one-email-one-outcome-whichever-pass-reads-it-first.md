# ADR 0244 — One email, one outcome, whichever pass reads it first

**Status:** Accepted (2026-10-13)
**Amends:** [0180](./0180-a-read-email-earns-its-own-pass.md) (the read-time
pass now runs the travel short-circuit),
[0219](./0219-preprocessing-the-read-time-pass-ahead-of-the-open.md) (the
warm-up runs after the sweep, not beside it),
[0243](./0243-an-email-can-ask-for-more-than-one-thing.md) (what "already
staged" counts), [0197](./0197-a-reply-is-written-for-you-and-sent-by-you.md)
(the calendar shown to the reply drafter),
[0240](./0240-a-flight-time-is-on-the-clock-of-its-airport.md) (what counts
as the reader's own offset)
**Related:** [0074](./0074-timezone-anchoring-and-invite-reconciliation.md),
[0137](./0137-a-proactive-message-is-not-always-the-briefing.md),
[0158](./0158-email-body-through-the-trip-classifier.md),
[0185](./0185-a-flight-already-on-the-books-is-not-none.md),
[0221](./0221-speculative-preprocessing-is-not-a-real-open.md)

## Context

On 2026-10-12 the owner recorded demo videos against production with a fresh
account and six hand-written emails. Three faults showed, each on two
separately created accounts.

**1. A travel email got a calendar-event card beside its trip.** The flight
email produced the correct trip bundle plus a stray "Flight UA 1234 from
Newark to Denver" event; the hotel email produced the stay plus a stray
"Hotel stay at Hyatt Regency Denver" event.

**2. The potluck email got a list card and a to-do card for the same ask.**

**3. "Suggest times" ignored the time that was asked about.** The email said
"Are you free at 9a on 10/26"; the draft offered October 13, 14 and 15.

The production rows for the second account give the order of events:

| Time (UTC) | Pass | What it staged |
|---|---|---|
| 22:52:47 – 22:52:53 | read-time warm-up (ADR 0219), one thread at a time | to-dos for three emails, `add_list_item` (potluck, :50.9), `create_event` (flight, :52.1), `create_event` (hotel, :53.8) |
| 22:52:49.4 | sweep starts its loop | — |
| 22:52:55 – 22:53:00 | sweep (`runEmailMagics`) | `create_task` (potluck, :55.2), flight trip bundle (:58.2), `add_accommodation` (:60.1) |

Both travel threads were already classified `travel/*` when the warm-up read
them. So faults 1 and 2 are one fault: **two passes read the same email
seconds apart and each staged its own idea of it.**

Why nothing stopped that:

- `runAiPassesInBackground` started the warm-up **in parallel** with the
  sweep (ADR 0219).
- The read-time pass calls `extractAndStage` directly. ADR 0180 left the
  travel short-circuit out of it on the ground that `threadAlreadyProposed`
  would stop a twin of whatever the sweep staged. That holds only when the
  sweep goes first.
- `stageEmailTripProposal`'s own "already staged" check looks at trip tools
  only, so an event card from the same email did not stop it.
- On the deployed build `threadAlreadyProposed` compared the same tool only,
  which is how a list and a to-do both got through. ADR 0243 (merged a few
  hours after the recording) asks without a tool and closes that exact
  sequence, but three gaps remained: the check and the insert are not atomic
  and the two passes run in two processes; one pass may now return several
  items and can itself return one ask in two shapes; and the tool-less check
  also counted ADR 0076 person proposals, which come from a different pass on
  purpose.

**1b. The stray flight event was at `2026-11-20T08:15:00-04:00`.** New York
is on -05:00 from 1 November. The extractor prompt gave the model "current
offset -04:00" and the model stamped it. `legDatetime` (ADR 0240), which
should have put the departure on Newark's clock, recognises "the reader's own
offset" as the reader's offset **on the leg's date** (-05:00), so a time
stamped with **today's** offset was taken as deliberate and left alone.
Non-flight events and to-do due dates had no backstop at all:
`normalizeDatetimes` only fixes a value with no offset. The chat bot has the
same fault: its prompt says "Always include this timezone offset in datetime
fields", meaning today's.

**3, in detail.** `userAvailability` listed exactly the next ten days; 26
October was fourteen days out, so the model was never shown it. The system
prompt said only "give 2–3 options". And when the day was added and the model
was left to read "is 9 AM free" off the day's line, a live run answered "I'm
not available at 9 AM" for a day with nothing on it.

## Decision

### A thread's own ask is staged once, by one kind of pass

1. **Both passes run the travel short-circuit** (`stageTripIfTravel`). A
   `travel/*` thread goes to the trip classifier in the read-time pass too,
   and anything but `'none'` is that thread's outcome. This also covers ADR
   0185's case from the read side: a booking already on the books (filed from
   an attachment) used to get an event card when its email was opened.
2. **Trip wins.** When the trip classifier claims a thread (stages a bundle,
   finds one pending, or finds the booking already on a trip), any *pending*
   `create_event` / `create_task` / `add_list_item` proposal from the same
   thread is withdrawn (`retractGeneralProposalsForThread`). This is what
   handles a thread read before it was classified. Confirmed cards are left
   alone: the trip's own flight event folds into a confirmed one (ADR 0223).
   Same shape as "invite wins" (ADR 0074).
3. **The warm-up runs after the sweep**, chained on the sweep's promise, not
   in parallel. By then the thread is classified and, usually, already staged.
4. **Check and insert are one step.** `extractAndStage` collects what it will
   stage, then takes a per-thread transaction-scoped advisory lock
   (`withThreadStagingLock`, the ADR 0165 form), asks `threadAlreadyProposed`
   again, and inserts. The lock is never held across a model call. The trip
   path's withdrawal takes the same lock, so in every interleaving either the
   general pass sees the bundle and stages nothing, or the bundle's
   withdrawal runs after the general insert and removes it.
5. **What counts as "already staged"** is the email's own ask:
   `create_event`, `create_task`, `add_list_item`, `create_trip`,
   `add_travel_leg`, `add_accommodation` (`EMAIL_SUGGESTION_TOOLS`), pending
   or confirmed. A person or date learned from the same email (ADR 0076, and
   the passenger proposal from ADR 0158) does not count: it is a different
   pass answering a different question. A trip bundle is several proposals
   sharing a `bundle_id` and is staged by one call, so it is unaffected.
6. **A delivery that needs someone home** (ADR 0135) is now staged in that
   same locked step. It used to be inserted before the check, by both passes.
7. **One ask, one shape.** A to-do whose title names at least two thirds of a
   list's entries from the same email is that list said again and is dropped
   (`dropTasksRestatingLists`); things to bring are a list (ADR 0132). The
   prompt says the same. A list entry that is a plain comma series of three
   or more ("paper plates, a fruit salad, and two bottles of sparkling
   water") is split into its parts (`splitListEntry`); anything with brackets
   or a number-comma is left as written.

### A time is stamped with the offset of its own date

8. `reanchorNowStampedOffset` (utils/tz.ts): when a datetime carries exactly
   the user's offset **as of now** and the user's zone has a different offset
   on that date, the wall clock is kept and the offset replaced. Any other
   offset is left alone.
9. It is applied to email suggestions (event start/end, to-do due date) after
   flight times are anchored, skipping a flight's own endpoints, and to chat
   tool calls for the fields where a new time is set (`create_event` /
   `update_event` start and end, `create_task` / `update_task` due and
   remind). It is **not** applied when the email, or the user's last few
   messages, name a time zone outright (`namesATimeZone`), and not to stored
   values or lookups.
10. `legDatetime` treats the reader's offset today as the reader's own, as
    well as the reader's offset on the leg's date.
11. Both prompts now state the offset schedule
    ("UTC-04:00 until 2026-11-01, UTC-05:00 from that date on",
    `offsetScheduleNote`) in place of today's offset alone. With that line a
    live model wrote the right offset itself; the code path stays as the
    backstop (ADR 0100's precedent: prompt and choke point).

### The reply drafter answers the time that was asked about

12. **The days a thread names are read by a parser** (`mentionedDays`,
    utils/date-mentions.ts: `10/26`, `Oct 26`, `26 October`, ISO dates, "the
    24th"; a date with no year is the next one on or after the day the
    message was sent). `userAvailability` lists the calendar for those days
    when they fall after its window (up to 5, up to 180 days out).
13. **A time written beside a date gets a verdict from the calendar, not the
    model** (`mentionedSlots`): "9a on 10/26" becomes
    `Mon, Oct 26 at 9:00 AM: FREE (nothing on the calendar from 9:00 AM to
    10:00 AM)` or `…: BUSY (9:00 AM–10:00 AM is taken)`. An hour from the
    stated time is assumed. A bare "at 9" with no AM/PM is not guessed at.
    When the verdict is BUSY the day before and the day after are listed too,
    so alternatives are read off the calendar.
14. **The prompt says to answer that time first**: confirm it and stop if
    free; decline and offer 2–3 alternatives if busy; alternatives only on
    days that have a calendar line. A note beside the instruction repeats it,
    because the app's quick ask literally says "suggest 2–3 times".
15. **Chat:** `get_my_availability` takes `dates` (up to 5) and returns
    `askedDaysText`; its description and `reply_to_email`'s say to pass the
    day asked about and answer that slot first.

ADR 0197's rule stands: free and busy come only from the calendar.

## Alternatives rejected

- **Have the warm-up skip unclassified threads.** ADR 0221 rejected this for
  delaying the warm-up; it also would not cover a real open of an
  unclassified thread, so trip-wins is needed anyway.
- **One shared mark for both passes.** They answer different questions (ADR
  0180: the read-time pass exists for mail the sweep's gates skip, and for the
  phishing advisory), and the marks say "extraction ran", not "something was
  staged".
- **Hold the lock across the model call.** A transaction and a pool
  connection held for seconds per thread; the check-then-insert is the only
  part that needs it.
- **Delete the event card instead of expiring it.** Every other convergence
  retraction expires; the row is the record that it was withdrawn.
- **Let "already staged" keep counting every tool.** A person proposal from
  ADR 0076 would then block the email's own suggestion.
- **Fix the offset in `normalizeDatetimes`.** It also runs at proposal
  confirm and on ingest, over stored values that carry the offset of another
  place. A Los Angeles user confirming a Denver departure in November
  (-07:00, which is also Los Angeles's offset in October) would have it moved
  an hour.
- **Prompt-only for the offset.** The model was already told to use the
  offset "for that zone on that date" and did not.
- **Widen the availability window to cover any date** (say 60 days). A long
  listing is mostly noise, hits the scan cap on a busy calendar (which turns
  the whole answer into "unknown"), and still misses a date past it.
- **Let the model work out which dates the thread mentions and whether the
  slot is free.** That is the model deciding availability; a live run got it
  wrong on an empty day.
- **Change the app's "Suggest times" instruction.** Old builds would keep
  sending the old text; the server has to handle it either way.

## Consequences

- The warm-up starts when the sweep finishes, so an email opened in the
  seconds after a sync pays the live read-time call, as it did before ADR
  0219. `__settleAfterSyncForTests` now also waits for the warm-up.
- A travel thread opened before the sweep reaches it now costs a trip
  classifier call in the read-time pass, and skips that pass's general
  extraction (so no phishing advisory for mail the classifier recognised as a
  booking).
- A thread read before it is classified can still show an event card for the
  time it takes the sweep to classify it; the card is then withdrawn.
- An offset is wrongly moved in one case: the email states no zone, the model
  nonetheless chose another place's offset, and that offset equals the
  reader's offset today while differing from the reader's on that date. A
  flight's endpoints are exempt, which is the common case of a time in
  another place.
- `mentionedDays` reads numeric dates month first and does not resolve
  weekday names; "1/2 cup" lists 2 January. A stray day costs one line in the
  prompt.
- The drafter's verdict assumes an hour. A 90-minute meeting asked for at 9
  with something at 10 reads FREE.
- Not retroactive: duplicate cards already staged stay until they expire or
  are answered.

## Not verified

- Against production. Verified by integration tests built from the recorded
  shapes (each shown failing without the fix) and by live-model runs of the
  drafter and the extractor from a developer machine.
- Outlook and IMAP threads go through the same code; only the Gmail-shaped
  path and an Outlook-mock thread were exercised.

## Addendum 2026-10-23: two emails, one card

The thread lock stopped two passes over ONE email both staging. It did not
stop two DIFFERENT emails with the same ask: a confirmation and its
reminder, or one message in two mailboxes (each mailbox has its own thread
id, so its own lock and its own extraction mark). The checks that compare
against other emails' cards (`shouldStageEventProposal`,
`shouldStageTaskProposal`, `shouldStageListItemProposal`) ran BEFORE the
lock, so two passes running at once (the sweep and a thread open, or two
processes) both read "no card for this yet" and both staged. Event and list
twins were later folded by the consolidation sweeps; a to-do has no sweep,
so its twin stayed in Action Items until answered.

Found by a code read on 2026-10-23, not a live report. Three more of the
same kind in the same file:

- The invite branch of the sweep called `createProposal` with no lock and no
  `threadAlreadyProposed` check, so a re-mined invite (extraction marks
  wiped, a second process) whose card was already confirmed was offered
  again: the UID dedup only looks at pending cards.
- The "someone must be home" delivery card (ADR 0135) skipped every
  duplicate check, so the shipped notice and the out-for-delivery notice for
  one parcel each staged a card. Their subjects differ, so the event rule
  cannot see they are one package.
- `applyEmailChanges` (ADR 0248) ran under the thread lock only, and its
  "card for this event already exists" check is across threads, so the
  club's cancellation and its follow-up read together each staged a removal
  card.

**Decision.** Every email card is staged under `withEmailStagingLocks`
(`magics.service.ts`): the thread's lock, then a per-user lock, and every
duplicate check runs inside them, immediately before the insert. Always
thread first, then user, so a caller holding only the thread lock
(`retractGeneralProposalsForThread`) cannot deadlock against it. Still never
held across a model call: the extraction finishes first, and only the
database checks and inserts run under the locks. The invite branch now asks
`threadAlreadyProposed` like every other card. A delivery card is one per
tracking number: `shouldStageDeliveryCard` reads the other pending
"Delivery:" cards' threads' `delivery_json`, keeps the card from the newest
email (its arrival day is the current one) and expires the rest; a parcel
with no tracking number falls back to the event rule.

**Consequences.**

- Staging is serialized per user, not per email. The locked step is a few
  short queries and inserts, and the sweep was already one user at a time.
- A per-user lock prevents new twins; it adds no to-do consolidation sweep,
  so to-do twins staged before this stay until answered or expired.
- The trip bundle path (`stageEmailTripProposal`) and person extraction
  take the same locks, after their model call. Trips: everything after the
  classifier (the pending-bundle and pending-leg checks, the cards, the
  passenger proposal). People: the known-person lookup and the create/propose
  step; the memory and relationship writes stay outside, because their
  catch-and-continue would otherwise abort the whole transaction on one
  failed statement. A bootstrap pass (ADR 0076) writes People rows directly,
  so two passes used to create the same new person twice, and nothing merges
  rows afterwards.
- Moving an already-booked leg (`reconcileBookedLegs`) now happens inside the
  staging transaction, and the calendar push it starts in the background runs
  on that transaction's handle. Bundle confirm already did the same; if the
  push fails, the event stays marked dirty for the next sync.
- Found while testing the trip path, sequential rather than a race: a flight
  joining another email's still-pending bundle (ADR 0173) staged every leg
  again, with no check that the bundle already held that flight, so a
  confirmation and its reminder doubled the leg cards. A leg the bundle
  already holds for the same traveler (`sameFlight` + `sameTravelerStrict`,
  the rule `findExistingLeg` uses for real trips) is now skipped; a companion
  on the same flight is a different traveler and still joins.

**Tests** (`magics-`, `trip-extraction-` and `person-extraction-cross-thread.integration.test.ts`,
plus one each in `invite-magics` and `email-changes`): the race tests run the second pass on
a second connection (the test pool has one, which serializes transactions
and hides the race) and hold both extractions until both have their answer.
Each fails on the old code; the race tests also fail with only the per-user
lock removed.

## Addendum 2026-11-06: offered windows are read on their own clock

Prod, 5 November: a scheduler offered John (New York) six days of windows,
all "PT" ("11/10: 10:30 AM – 12:00 PM PT", ...). The Suggested reply went
for 11/12 and skipped 11/10, for three reasons:

- `mentionedSlots` kept only the time nearest each date and dropped the
  zone, so 11/10 was checked at 10:30 AM **New York** for an hour. Omar's
  window is 1:30-3:00 PM there. Anything on John's morning made the day
  BUSY.
- `MAX_ASKED_SLOTS` was 3, so the windows after the third date were never
  checked.
- The prompt only covered one time being asked about. With several FREE
  verdicts and no rule for picking, the model picked whichever it liked.

Now:

- **Ranges and zones are parsed.** "10:30 AM – 12:00 PM", "11–1 PM" (the
  first end takes the half that fits) and "2-4pm" are one slot with
  `endMinutes`. A zone written right after a time (`PT`/`PST`/`PDT`,
  `ET`, `CT`, `MT`, `AKT`, `HT`, `UTC`/`GMT`, uppercase only; or "Pacific
  Time", "Eastern", ...) becomes `timeZone` (IANA). Times listed together
  on a line ("8–9:30 AM PT, 1–2 PM PT", "9am or 2pm ET") form one run: the
  run goes with the nearest date, and a zone written once covers the whole
  run. A time on the date's own line beats one as close on the next line.
- **The check uses the writer's clock.** `userAvailability` turns each
  slot into instants on its own zone, files it under the reader's local
  day, and sorts all slots earliest first. A window is checked whole: FREE,
  `PARTLY FREE (free X–Y; Z is taken)` (stretches of at least 30 minutes),
  or BUSY. A window that is under way counts only from now. A window that
  runs into the reader's next day reads both days. When the writer's clock
  differs, the label says `(written as 10:30 AM–12:00 PM PST)`.
  `MAX_ASKED_SLOTS` is 12.
- **Several offered times: the earliest free one.** When there is more than
  one verdict, the drafter is told to offer the EARLIEST FREE one (or the
  earliest free part of a PARTLY FREE window), with at most one fallback,
  never skipping an earlier free one for a later one. It gives the time on
  both clocks. If none are free, it offers 2–3 alternatives from listed
  days. One verdict keeps the confirm-and-stop rule.

Also read, same day:

- **Zones outside the US**: abbreviations (CET/CEST, BST, IST = India,
  JST, SGT, AEST/AEDT, NZST, GST = Gulf, SAST, ...; uppercase only), names
  that end in "Time" ("Central European Time", tried before US "Central";
  "Japan Standard Time"), "<city> time" for a city the place table knows
  ("3pm London time"; "Lunch time" is nothing), and UTC/GMT offsets incl.
  Outlook's "(UTC-08:00)" (whole hours as `Etc/GMT∓N`, half hours as
  `+05:30`, or a place that keeps that offset all year where Intl takes no
  offset zones). Left out on purpose: AST (Atlantic or Arabia), ART (reads
  as a word); CST stays US Central.
- **24-hour ranges** ("14:00–15:30", "09:00-10:30", "22:00 to 01:00" runs
  past midnight), read only when an hour is past 12 or the start has a
  leading zero, so "3:00-4:00" stays unread.
- **A zone before the time** ("PT: 10:30 AM", "(ET) 2pm"), looking no
  further back than the previous time, and **a zone stated once** ("All
  times are in Pacific Time", "times ET"), applied to every time with no
  zone of its own; two different declared zones declare nothing.

Not covered: a zone written before the DATE ("ET 11/12 at 2pm"), and
dotted times ("14.00", too close to prices). Not yet run against a live
model.

**Tests**: `date-mentions-ranges.test.ts` (the recorded email, verbatim) and
`compose-reply-offered-windows.integration.test.ts` (same shape on dates
relative to today, a 10:30 AM New York event that used to make the day
BUSY, a meeting inside a window = PARTLY FREE). Both fail on the old code.
