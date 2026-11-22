# 0153 — An external-action link is family-aware

**Status**: accepted
**Date**: 2026-09-09

**Addendum 2026-09-10**: the deep-link targets consolidated onto Google.
`hotel` and `activity` moved off single operators (Expedia, Viator) onto
**Google Travel** (`google.com/travel/search?q=hotels in <city>` / `?q=things
to do in <city>`) — a price/operator aggregator the family is likely already
signed into, no affiliate lock-in, and next to `flight` under
`google.com/travel/*`. **Unnamed `restaurant` also moved to Google Maps**
(`restaurants in <city>`): an OpenTable *discovery* search has the same
partner-inventory bias the named case was fixed to avoid, and every Maps place
page carries the reservation button anyway — OpenTable is now gone from the
codebase. The tool description also tells the model to answer inline (saved
places / trip city) or ask, rather than fire a vague name-less, city-less
`restaurant`. `takeout` stays DoorDash (no Google router works for an unnamed
place). `map` household-address prefill (below, was deferred) also landed.

**Relation**: extends [0039](./0039-external-action-deep-links.md)
(`suggest_external_action` deep-link cards) and sits under
[0149](./0149-the-mail-surface-is-bounded-to-coordination.md)'s gate — a
feature earns its place by feeding a shared family artifact. Reuses the
family-profile model from [0151](./0151-a-managed-persona-can-be-given-work.md)
(the `personas` roster) and Phase 3a household facts.

## Context

`suggest_external_action` (ADR 0039) already does the thing we want: the bot
emits a tappable deep-link card and never transacts (ADR 0107 — we answer, the
provider books). "Get me a reservation" → an OpenTable card; "find me flights"
→ a Google Flights card. Two things are wrong with how it does it.

**1. The restaurant provider is hardcoded to OpenTable.** A named restaurant
that takes reservations only through Resy / SevenRooms / Reserve-with-Google
0-results on an OpenTable search — and a card that dead-ends reads as Chord's
mistake, not a gap (ADR 0102/0135/0138: a wrong link is worse than no link).

**2. The builders only see the chat turn.** The family's own airport, its
size, and its live trip are all on record — `personas` (ADR 0151), household
facts (`home_airport`, Phase 3a), `trips` — and none of it reaches the query.
"Get us a table Friday" and "find flights for the Lisbon trip" throw away what
the harness already knows.

## Decision

### 1. A named restaurant links to the place, not a search

`buildRestaurant` branches on whether a `restaurantName` is present:

- **Named** → a Google Maps place URL (`maps/search/?api=1&query=<name city>`).
  The Maps place panel carries the "Reserve a table" button, and Google routes
  it to whatever system that restaurant actually uses (OpenTable / Resy /
  SevenRooms / Reserve with Google). No provider-selector field — the place
  page *is* the router. `partySize` / `dateTime` have no Maps param, so they
  ride `meta` only (the card subtitle still reads "Lilia · 4 guests · Fri 7pm").
- **Unnamed** ("somewhere for 4 on Friday") → originally an OpenTable search
  for its `covers` / `dateTime` filters; **superseded by the 2026-09-10
  addendum** — now a Google Maps `restaurants in <city>` search (unbiased
  inventory; the filters were only useful if you then booked on OpenTable).

### 2. `buildFlight` carries the whole query

Was `q=Flights from BOS` with destination and dates dropped. Now a
natural-language `q=` that Google Flights parses:
`Flights from <origin> to <destination> on <YYYY-MM-DD> through <YYYY-MM-DD>`
(each clause omitted when its field is absent).

### 3. `enrichExternalActionQuery` — gap-fill from the family, in the executor

A new async step in the `suggest_external_action` executor case, before
`buildExternalAction` (which stays a **pure function** — ADR 0039). It fills
**only fields the model left blank**, from the triggering group:

| Gap | Kind | Source |
|---|---|---|
| `partySize` | restaurant / takeout / hotel / activity | `personas` roster count (≥ 2, capped 20) |
| `origin` | flight | a `home_airport` memory — household first, else the asker's own |
| `destination`, `departDate`, `returnDate` | flight | the soonest open `trips` row (`end_date >= today`) in this group |
| `city` | restaurant / hotel / activity | that same open trip's `destination` |
| `restaurantName` | restaurant / takeout | a single strong token match in the group's saved places (`saves` kind `place`) → canonical title |
| `q` | map | a `home_address` memory (household first, else the asker's own) — only when `q` is blank or just says "home" / "our house" *(fast-follow, 2026-09)* |

Never overrides a supplied field. **Best-effort**: any failure (no roster, no
trip, a throw) leaves the query exactly as the model built it — the card still
renders, just less filled-in.

Scope is the **triggering group only** — no cross-group reads (ADR 0032). Every
value used is one the asker can already see: their group's roster, their
group's trips and saves, a household fact or their own. A personal 1:1 has no
roster (personal groups get no personas, ADR 0151) so `partySize` naturally
no-ops there; `home_airport` / trips / saves in the personal group are the
user's own.

## Alternatives considered

- **A `provider` enum on the query (`opentable` | `resy` | `google`).** Puts a
  routing decision on the model that the restaurant's own Google listing
  already answers — and we still 0-result whenever the model guesses wrong.
- **Scrape the restaurant page to detect its booking provider.** ADR 0135/0138:
  we render the link, we never fetch the target.
- **The `tfs` base64 Google Flights token.** Precise but undocumented and
  brittle; a natural-language `q=` is stable and public.
- **Cross-group enrichment** (pull the user's home airport / trips from any of
  their groups). ADR 0032 line, and a wrong-group trip is worse than an
  unfilled field.
- **A booking-API integration** (OpenTable / Resy partner). Out of scope by the
  product's own boundary — Chord answers, the provider transacts.
- **Enrich inside `buildExternalAction`.** It would need `db` and stop being a
  pure, unit-testable function; the executor already has `db` and is where
  every other tool does its data reads.

## Consequences

- `buildExternalAction` stays pure; enrichment is a separate async step with
  `db`, wrapped so a failure is invisible.
- A named-restaurant card now points at Google Maps, not OpenTable — a
  deliberate behaviour change for existing "book at X" turns: it lands on the
  place (with its real reservation button) instead of a search that may miss.
- The artifact (ADR 0149's gate) is produced downstream: the user taps the
  link, books, the confirmation email arrives, and the magics pipeline
  (ADR 0074/0088/0100) turns it into a calendar event / trip leg. The deep
  link is that pipeline's input.
- Tests: named vs unnamed restaurant URL; flight URL carries destination +
  both dates; `partySize` from the roster (and *not* in a personal 1:1);
  `origin` from a household fact, then from the asker's own; an open trip
  fills destination + dates + city; a supplied field is never overridden; a
  saved-place name is canonicalised on a single match only.
