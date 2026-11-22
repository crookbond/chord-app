# ADR 0213 — A package is tracked on its carrier's page, and "which one" is a question

**Status:** Accepted
**Date:** 2026-09-26
**Extends:** ADR 0133, 0135, 0138

## Context

"Track 1Z999AA10123456784" or "where's my REI package?" had no answer in
chat. The pieces all existed. ADR 0135 turns a tracking number into its
carrier's page (a parser plus a URL template). ADR 0133 narrowed that so a
bare run of digits needs corroboration. The magics pass already stores
`{carrier, trackingNumber}` on each shipping email (`delivery_json`). But
only the email tile and reader used any of it. `suggest_external_action`
could track a flight (`flight_status`, ADR 0138) and not a parcel.

## Decision

Add a `package_tracking` kind to `suggest_external_action`, with two inputs.

**A number the user gives** goes through the new `trackingForStatedNumber`:

- **The user's request counts as corroboration.** ADR 0133 requires a label
  such as "tracking number" before it accepts a bare 12-digit run. "Track
  this" is that label, so shape alone decides the carrier here.
- **A shape two carriers share gets a question, not a guess.** A 20-digit
  number is valid for both USPS and FedEx. The tool returns the candidate
  carriers and tells the model to ask. Guessing produces somebody's "not
  found" page, and that reads as Chord's mistake (ADR 0135/0138).
- **A carrier the user names is taken at its word.** This holds even when
  the shape is one the table does not know, because carriers issue more
  formats than the table covers, and the choice is then the user's rather
  than Chord's guess. A carrier we have no template for gets no link.
- **Spaces and dashes are stripped**, since labels print numbers in groups.

**No number** means the package the user is waiting on. `findDeliveriesForUser`
reads the asker's own threads that have `delivery_json` from the last 45
days. It collapses several emails about one parcel (shipped, out for
delivery) by tracking number and matches `query.q` against sender and
subject. The rules:

- This path runs **only in the personal 1:1**, because it reads mail (ADR
  0084, 0032). In a shared group, a number the user gives still works, since
  no mail is read.
- One match builds the card. Several matches return the candidates by
  sender and expected date, **without their numbers**, and the model asks
  which one. The follow-up call carries `query.q = <sender>`, not a number
  copied across turns (tool results don't survive a turn — ADR 0093/0166).

**Carriers.** UPS, USPS, FedEx and DHL were already supported. This adds:

- **Amazon Logistics** (`TBA` + 12 digits, `track.amazon.com/tracking/…`).
- **UPU S10** international numbers routed by their country suffix: `US` →
  USPS, `CA` → Canada Post, `GB` → Royal Mail. They are accepted **only
  when the S10 check digit holds**, which lets an `AB123456785US` stand
  alone instead of passing for any reference code.

The new shapes also flow into email detection (`findTracking`), so shipping
mail using them gains a link too.

As ADR 0135 requires, **we render the link and never fetch the carrier
page.**

## Rejected

- **OnTrac/LaserShip.** Only legacy `.asp` tracking URLs are documented, and
  a link that may dead-end is worse than none.
- **An aggregator fallback (17track and similar) for unknown shapes.** It
  spends a tap to say we didn't know, as ADR 0138 found for search-page
  fallbacks, and it sends the number to an ad-supported third party.
- **Guessing between USPS and FedEx for 20 digits.** Rejected for the
  reasons above.
- **Reading mail for the no-number case in a shared group.** That is the
  ADR 0032/0084 leak.

## Consequences

- The bot answers "track my package" with a tappable card. On WhatsApp this
  becomes a `cta_url` button when it is the turn's only link (ADR 0139).
- A package whose shipping email named no tracking number, or that isn't in
  the mirror, still needs the user to give the number.
