# 0133 — A bare number is not a tracking number

**Status**: accepted
**Date**: 2026-08-25
**Relation**: narrows the shape rule in
[`0135-a-shipping-update-says-when.md`](./0135-a-shipping-update-says-when.md).

## Context

ADR 0135 reads the carrier off the tracking number's shape, which is right:
`1Z` + 16 is a UPS label and nothing else, and the `9[1-5]` prefix is assigned
to USPS. Those names identify themselves.

The other three shapes do not. FedEx is `\d{12}`, `\d{15}` or `\d{20}`; DHL is
`\d{10}`; USPS also uses bare 20 and 22. A run of digits that long is equally
well an order number, an invoice number, an account number, or a phone number
with its punctuation stripped — all of which appear in exactly the kind of
email this parser runs on. `Order 123456789012 confirmed` produced a FedEx
tracking link.

A wrong carrier link is worse than no link, because it looks like an answer.
The reader taps it, FedEx says "not found", and the mistake is Chord's.

## Decision

**An unmistakable shape stands alone. A bare run of digits needs corroboration.**

Corroboration is any one of three things:

1. **The sender is that carrier** — `fedex.com`, or a subdomain of it.
2. **The carrier is named in the text** — "Your FedEx package".
3. **The number is labelled where it appears** — `tracking`, `tracking number`,
   `AWB`, `waybill`, `label`, `shipment`, `consignment`, `parcel`, `package`,
   within 40 characters before the digits.

`Order` is deliberately absent from that list, because that is the case this
ADR exists to reject.

### Why not require the sender, which is simpler

It was the first suggestion and it is the wrong shape, for a reason that is
easy to miss: **most shipping email does not come from the carrier.** It comes
from the retailer — Amazon, Etsy, a Shopify shop, a school selling raffle
tickets — saying "your order shipped, tracking 1Z999…". Requiring
`fedex.com`/`usps.com`/`ups.com` as the sender would reject the majority of
real tracking emails to fix a minority of false ones.

The sender stays what ADR 0135 made it — a **tiebreak**, now also promoted to
one of three corroborations.

### Why a cue word is enough

Because real shipping mail labels the number. That is the entire purpose of
printing it: a human has to find it. An order confirmation says "Order"; a
shipping notice says "Tracking". The distinction we need is already written in
the text, for free, and it needs no model call — which is what ADR 0135 was
protecting in the first place.

### The cue has to be near the number

Within 40 characters, not anywhere in the email. Otherwise a confirmation that
mentions "tracking will be available once we ship" would vouch for every
number below it, which is the same false positive wearing a hat.

## Consequences

- Order numbers stop becoming FedEx links.
- Some genuine tracking numbers are now missed: a bare 12-digit number, from a
  retailer, with no label and no carrier named. That is the deliberate
  direction of the error — a missed link costs a search, a wrong link costs
  trust.
- `USPS` becomes two rules rather than one: the self-identifying IMpb prefix,
  and the bare 20/22 that needs corroboration. Same carrier, different
  confidence, and collapsing them would mean treating the assigned prefix as
  though it were guesswork.
- Nothing changes for UPS, which never needed a cue.

## Alternatives rejected

**Require a carrier sender.** Rejected above: it discards the retailer case,
which is most of the volume.

**Ask a model when the shape is ambiguous.** ADR 0135's whole point is that
this is a parser. A per-delivery LLM call to disambiguate an order number is
the cost that decision was avoiding.

**Validate the check digit.** FedEx, USPS and DHL numbers all carry one, and
this would be the rigorous fix — three more algorithms, each with variants per
service, to reject numbers a cue word already rejects. Worth revisiting only if
the cue rule proves leaky in practice.

**Leave it.** The false positive is not hypothetical: it is any order
confirmation with a 12-digit order number, which is a common shape.
