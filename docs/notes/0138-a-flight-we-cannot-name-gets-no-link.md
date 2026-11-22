# 0138 — A flight we cannot name gets no link

**Status**: accepted
**Date**: 2026-08-27
**Relation**: the sibling of [0135](./0135-a-shipping-update-says-when.md), under
the corroboration rule [0133](./0133-a-bare-number-is-not-a-tracking-number.md)
made; pays a debt 0135 left; applies
[0100](./0100-a-past-event-is-a-typo-until-confirmed.md)'s test for what a
calendar entry IS; scoped by [0096](./0096-personal-chat-reads-across-groups.md)
and [0084](./0084-email-and-todos-in-search.md).

## Context

Reported: *"I have flight notifications in app / email. When there is a defined
flight number, extract it, construct a clickable URL like
`https://www.flightaware.com/live/flight/DAL1231`, and when the user asks about
the flight, enhance the context with the tracking URL."*

Flights arrive in two places and neither produced a trackable flight.

**Email** classifies a thread as `Travel → Flights` (`llm-classifier.ts`) and
magics may stage a `create_event`, but the flight *number* was never captured.
`archetype-map.ts` already routed a Travel root to a state board and
`EmailStateStatus` already carried `boarding` and `check_in` — with no producer
for either. What the tile could say was whatever `extractStateStatus` scraped
off a subject line.

**In-app**, `travel_legs.flight_no` + `carrier` *are* populated — by the
attachment trip classifier and by `add_travel_leg` — and rendered as inert text.

So the number either did not exist or did nothing. And the bot could not answer
from either: `EmailHit` selects `snippet` and drops it in the mapper, there is
no thread-body read tool, and `context.ts` carried trips as `name (start→end)`.

Two constraints turned out to decide most of the design, and both were worth
checking rather than assuming:

1. **FlightAware addresses a flight by its ICAO ident.** `DAL1231`, not
   `DL1231` — the IATA form redirects only for a handful of majors that were
   entered by hand. So resolving IATA→ICAO is not a formatting nicety; it is
   the difference between a link and a dead end.
2. **A URL in the bot's prose is dead text.** The chat bubble renders the body
   as a plain `<Text>` — no markdown, no linkifier. The only tappable external
   surface is `BotCard { kind: 'action', url }`, and `tools.ts` already tells
   the model *"The system builds the URL — do not assemble URLs yourself."*

## Decision

### The ident is parsed; the times are read

ADR 0135's split, applied to flights. `findFlight` recognises the designator in
the email text and resolves its airline; the magics extractor — already running,
already holding the body — returns an optional `flight` block with the times,
route and status, through the same `onDelivery`-shaped side channel, so
`EmailExtractor` still returns `EmailSuggestion | null` and every injected stub
keeps compiling.

**The model is not the authority on identity.** A flight block for mail
containing no recognisable designator writes nothing at all: naming a flight
wrong does not produce a vaguer answer, it produces a link to somebody else's
aeroplane.

### The table is the recognition step

`kernel/src/flight-ident.ts` maps ~80 IATA codes to ICAO, name and sender
domains. An airline outside it gets **no ident and no URL** — the number still
renders as text, but nothing guesses a link.

It lives in kernel because mobile needs the same table for trip-leg rows and has
no test harness (the ADR 0120/0121 reason); kernel logic is still covered by
vitest from the server workspace, as `list-name.ts` already is.

### Corroboration, and a stricter bar for an airline we cannot name

`[A-Z]{2}\d{1,4}` is a *more* ambiguous shape than the run of digits ADR 0133
was written about — it is also an order number, a room number, a part number. So
every designator needs corroboration, asymmetrically:

- **A code in the table** is vouched for by the sender being that airline, the
  airline being named in the text, or a cue word within 40 characters before.
- **A code outside it** needs the cue word specifically. Nothing else can speak
  for a designator we cannot even name, and the sender arm is useless there by
  construction.

`confirmation`, `order`, `booking`, `record locator` and `PNR` are deliberately
**absent** from the cue list: they precede a record locator (`KX8QP2`), not a
flight number. Including them is exactly the `Order` mistake ADR 0133 made a
rule about.

Matching is **case-sensitive**. Lowercasing would make `to 500` and `by 2024`
designators and let an ordinary sentence corroborate itself; a mail that writes
its flight in title case is missed instead, which is 0133's chosen direction — a
miss costs a search, a wrong link costs trust.

Airline *names* match in full. "United" is not an alias, precisely so "United
States" cannot vouch for a `UA1234` order number; the same goes for Delta,
American, Alaska, Frontier and Spirit. Distinctive brands (JetBlue, Ryanair,
Qantas) get explicit aliases.

The sender is a strong positive and never a requirement — most flight mail does
come from the airline, but plenty arrives via Expedia, TripIt or an agent. Same
reasoning that made 0133 decline to require a carrier sender.

### Stored, not proposed — but the event stays

`email_threads.flight_json` (migration `061`) holds the parsed identity and the
read prose, because tile facts are built at render time where no model can run.

Unlike a delivery, the prompt explicitly **keeps** the `create_event`
suggestion. A parcel is left at the door; a flight is somewhere a person has to
be, which is ADR 0100's test for what a calendar entry is. The two coexist: a
proposal for the calendar, a stored fact for the tile and the link.

A flight's arrival goes in the existing `etaAt`, so `dropLandedRows` (renamed
from `dropArrivedDeliveries` — "arrived deliveries" becomes actively wrong once
flights use it) retires the row on the rule it already applied. Nobody emails to
say a flight landed, exactly as nobody emails to say a parcel turned up.

### The link is rebuilt, and rendered in one place

No URL is stored — `flightAwareUrl(ident)` is the single template, and both the
tile board and the thread reader come through it (ADR 0135's rejected
alternative: a template that changes strands old rows).

Which exposed the debt 0135 left. Its `tracking.url` had been computed
server-side and **dropped by the client** ever since: `factLines` can only
return strings for a treemap label, and nothing else rendered the fact. So the
sheet's "Current state" now renders the facts rather than their strings, through
one extracted `LinkChip` — and the delivery link works for the first time, which
is most of why this was built once instead of twice.

### The bot gets the ident in context and the URL from a tool

A new bounded block in `context.ts` lists the flights the user is about to take:
that group's legs in a shared room, and — on a personal turn — their legs across
every group plus flights parsed out of their mail, which has no group of its own
(ADR 0084/0096). Names and dates only, byte-capped like ADR 0088.

**It carries the designator and never a URL.** A URL in the prompt is a URL
waiting to be copied into prose, where it renders as dead text.

The link comes from `suggest_external_action` with a new `kind: 'flight_status'`
— deliberately separate from `flight`, which searches Google Flights for one to
*buy*. When the airline is unknown the builder returns null, the executor emits
**no card**, and the model is told plainly not to dress that up as one (ADR
0102's posture for a tool that could not act).

### We render the link; we never fetch it

ADR 0135's rule, restated because the temptation is stronger here: flight-status
APIs exist, and `chord-spec-v4.md` lists *"Live flight tracking → real-time
position and ETA"* as a Phase 3 item. Without a line here, "show flight status"
drifts into becoming a carrier's client.

## Consequences

- Only mail processed after this ships gets flight facts — a thread is mined
  once ever (ADR 0076) and those marks are not cleared. Existing flight threads
  keep the bare status word.
- An airline outside the table is a **silent** miss on the link, by design. The
  fix is a table entry, and the table is the one place to add it.
- `EmailStateStatus` gains `scheduled` and `cancelled`. `statusLabel` in mobile
  is an exhaustive switch, so a future status cannot be added without the client
  being made to render it.
- `buildExternalAction` now returns `BuiltAction | null`. The executor is its
  only caller; the unit test unwraps through one helper.
- **The calendar grid is deliberately untouched.** `LegBlock` is sized by
  duration and collapses to a single line, there is no leg detail view, and
  every other block on the grid is inert — one tappable block among many, on a
  surface people scroll, is a mis-tap that launches a browser. Trips and the
  email thread are where a leg is read.
- ADR 0127's bulk gate already names *"the flight confirmation"* as the mail its
  deny-list exists to protect, so no gate change was needed. An airline blast
  carrying `List-Unsubscribe` **and** classified bulk can still be skipped
  unless its action is `to_do`/`reply_needed` — worth watching, not worth a
  pre-emptive override.

## Alternatives rejected

- **A best-effort IATA URL** (`/live/flight/DL1231`, relying on the redirect).
  Works for a handful of hand-entered majors and dead-ends for everyone else —
  and the dead end reads as Chord's mistake, not as a gap.
- **A search-page fallback** for unknown airlines. Always lands somewhere real,
  but spends the user's tap to tell them we did not know.
- **Requiring an airline sender.** Would reject the majority of real flight mail
  — which comes from Expedia, TripIt or an agent — to fix a minority of false
  positives that the cue word already fixes.
- **Creating a travel leg from an email.** The richer home, and a bigger
  decision: it needs trip matching, dedup against attachment-derived legs, and a
  consent posture. Deferred to its own ADR.
- **Letting the model write the URL.** Violates the rule `tools.ts` already
  states, and lands as dead text in the bubble regardless.
- **Storing the URL.** ADR 0135's rejected alternative, for its reason.
- **Fetching a flight-status page.** See above.
