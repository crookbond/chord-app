# 0135 — A shipping update says when it arrives

**Status**: accepted
**Date**: 2026-08-25
**Relation**: spends the body excerpt [0110](./0110-the-ai-passes-must-be-shown-the-email.md)
started keeping; extends [0087](./0087-email-tile-archetype-facts.md)'s state
board; applies [0100](./0100-a-past-event-is-a-typo-until-confirmed.md)'s test
for what a calendar entry IS, and [0092](./0092-closing-out-stale-todos.md)'s
warning about cards nobody asked for.

## Context

Reported: *"for shipping updates, I don't want a plain 'shipped'. Half the
emails have 'arriving on this day' — we should show that. Same for tracking: if
you have a tracking number, you can form the relevant URL."*

Both true, and both were being thrown away. `extractStateStatus` regex-matched
subject+snippet into a fixed enum and `EmailStateFact` was `{title, status,
threadId}`, so a delivery rendered as **"Package · shipped"** — the least
informative sentence the email contained. Magics separately staged a to-do that
said *"track this"*, which is an instruction rather than an answer.

## Decision

### The date is read; the carrier is parsed

A tracking number identifies its own carrier by **shape** — UPS `1Z` + 16
alphanumerics, USPS 20-22 digits, FedEx 12/15/20, DHL 10 — so carrier and URL
are a parser and a template, not a model call. Where two shapes collide (20
digits is both FedEx Ground and USPS) the sender's domain settles it.

The **arrival date is prose** — *"arriving Thursday"*, *"by end of day Friday"*
— so it is read, not matched. Owner decision: read delivery mail greedily rather
than hoping a regex covers the phrasing of several hundred retailers. This was
not worth attempting before ADR 0110, when the passes saw ~78 characters of
padded snippet and the ETA was almost never among them.

The read costs **no extra LLM call**: the magics extractor already runs once per
thread with the body in hand, so it returns an optional `delivery` block
alongside its normal answer, read off the same reply by `parseDelivery` — the
`parseNeedMore` shape, which keeps `EmailExtractor` returning
`EmailSuggestion | null` so every injected stub still compiles and a delivery is
never forced to pose as an event.

### Stored, not proposed

`email_threads.delivery_json` holds `{etaAt, carrier, trackingNumber,
needsPresence}`, written by the magics pass. It has to be persisted because tile
facts are computed at **render time** from stored columns, where no model can
run.

It is deliberately **not** staged as a proposal, which was the first instinct
and would have reused existing machinery: a proposal is something you confirm or
reject, and *"your package arrives Thursday"* is not a decision. Routing it there
puts a card in Action Items asking the user to approve a fact about the world,
and leaves the tile blank until they do.

### Except when someone has to be there

A calendar event **is** proposed when the mail says a human must be present — a
signature, a stated delivery window, perishables. That is a real appointment in
ADR 0100's sense, and rare enough not to be the ADR 0092 pile-up that one card
per parcel would be.

Its TTL runs to the day after arrival rather than ADR 0009's flat 72 hours. A
package shipped today for next Tuesday would otherwise expire before it lands —
and land in ADR 0134's *"expired, still owed"*, which is for obligations the
user never answered, not for parcels.

A date-only ETA becomes a **midnight start**, which ADR 0040 already treats as
all-day. Inventing 9am would be a time the email never gave, on an event the
user is being asked to attend.

### Two smaller rules

- **A date with no status word still makes a row.** *"Your order will arrive
  Thursday"* matched no keyword and produced nothing. The keyword was only ever
  how we DETECTED a delivery; the date is the part worth showing.
- **A parcel drops off the board once its day has passed**
  (`dropArrivedDeliveries`, the rule `dropPastTimeline` applies to dated items).
  `extractStateStatus` only drops a thread that says "delivered", and plenty of
  parcels simply turn up with no follow-up mail — so without this the row sat
  there forever.

### We render the link; we never fetch it

The tracking URL is shown and the user taps it. Chord does not fetch a carrier
page to show live status in-app: that is a per-user request to a company we have
no relationship with — rate limits, terms, and Chord silently becomes its client
— and it buys nothing, because the email already states the date.

Worth writing down because ADR 0107's ours/theirs split does **not** decide it:
"theirs" means the mail provider, and a carrier is neither. Without a line here,
"show delivery status" drifts into fetching.

## Consequences

- Only mail processed after this ships gets the facts — a thread is mined once
  ever (ADR 0076) and those marks are deliberately not cleared while dogfooding.
  Existing delivery threads keep the bare enum.
- `Package · shipped` becomes `REI order · arriving Thu 28 · UPS`, and undated
  deliveries still fall back to the status word.
- Migration `049` adds the column; no backfill, because the facts come from a
  pass that has to re-read the mail anyway.

## Alternatives rejected

- **Propose a calendar event for every shipped item** (considered seriously, and
  the reason the presence gate exists): most parcels are left at the door, so
  it fails ADR 0100's test for what a calendar entry is, floods Action Items,
  and makes the arrival date invisible until the user says yes to a card.
- **Regex the ETA.** Loses across hundreds of retailers' phrasings, which is the
  rule-shaped brittleness ADR 0110 exists to move away from.
- **Store the tracking URL** rather than rebuilding it from carrier+number. A
  template that changes leaves old rows pointing at a dead page.
- **Fetch the carrier page.** See above.
