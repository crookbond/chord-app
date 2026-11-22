# 0160 — A receipt is settled, not owed

**Status**: accepted
**Date**: 2026-09-10
**Relation**: the same read-don't-propose shape as
[0135](./0135-a-shipping-update-says-when.md) (delivery) and
[0138](./0138-a-flight-we-cannot-name-gets-no-link.md) (flight) — a third
side-channel block on the same magics extraction call, mined into a stored
fact rather than a proposal. Feeds the Ledger tile
[0087](./0087-email-tile-archetype-facts.md) already routes `Finance`/
`Receipts` mail to, via the `ledgerFromArgs` hook
[0135](./0135-a-shipping-update-says-when.md) already reserved for exactly
this and nothing had ever populated.

## Context

The email pipeline already classifies purchase-confirmation mail under a real
`Receipts` category leaf ([0109](./0109-bulk-is-how-mail-was-sent.md)), and
that category already maps to the Ledger tile archetype
(`archetype-map.ts`'s `root === 'finance' || root === 'receipts'`). But
nothing had ever extracted a *structured* fact from one — the fail-closed
regex in `extractLedgerFact` explicitly treats "receipt / thank you for your
order / paid in full" as noise unless a balance is also due
(`PAID_NOISE`), because that function's whole job is money **owed or coming
back**, and a settled purchase is neither. So the spot in the AI map existed
and a receipt landing in it rendered nothing more than its subject line.

Owner direction: extract the amount now and store it, even with no consuming
feature yet (`Finance` is a deliberate scaffold, [0070](./0070-todos-hub-action-items-first.md)) —
because the per-thread extraction mark
([0076](./0076-email-derived-people-and-family-facts.md)/[0110](./0110-the-ai-passes-must-be-shown-the-email.md))
fires once ever. Mining a receipt only when Finance ships means every receipt
that arrived before that date is unrecoverable without a costly re-mine of
the whole mailbox; mining it now costs nothing extra (see below) and banks
the fact for whenever Finance is built.

## Decision

**One more optional block on the existing magics LLM call**, not a second
call: `EXTRACT_SYSTEM`'s prompt gains a `"receipt":{"merchant","amount",
"currency","purchasedAt","orderNumber"}` block, read off the *same* JSON
reply that already answers event/task/list — exactly the side-channel shape
`onDelivery`/`onFlight` established. `parseReceipt` mirrors `parseDelivery`/
`parseFlight` byte-for-byte: only fires when a specific `amount` is stated
(an unpriced "receipt" tells the tile nothing a subject line doesn't
already), drops a `purchasedAt` it cannot parse rather than rendering a wrong
day, and is invoked from the same `finish(text)` closure — so this costs
**zero additional LLM calls** and zero additional tokens beyond a few output
tokens on threads that are actually receipts.

The prompt is explicit that a **bill with a balance due stays a `task`** —
the receipt block is only for a purchase already paid in full, so the
existing obligation pipeline ([0132](./0132-a-to-do-is-not-a-list-item.md))
is untouched.

**Stored, never proposed** — `email_threads.receipt_json` (migration `070`),
written by `recordReceipt` the same way `recordDelivery`/`recordFlight`
write their columns: there is nothing to confirm about a purchase already
settled, the same reasoning [0135](./0135-a-shipping-update-says-when.md)
used for an arrival date.

**Rendered through the Ledger board that was already there**, as a genuinely
new state rather than forced into the existing two: `EmailLedgerFact.direction`
gains `'paid'` alongside `'debit'`/`'credit'`. Misusing `debit` would show a
$40 receipt as something owed; misusing `credit` would show it as a refund —
both wrong, and both the exact confusion `PAID_NOISE` was written to avoid.
`receiptToLedgerFact` converts the stored fact at render time (mirroring
`ledgerFromArgs`'s shape, `classification.service.ts` calls both) and
`capFacts`'s ranking gains a third tier — owed, then coming back, then
settled — so a large old receipt can never push a due bill off the top of
the tile. One line in `email-tiles.tsx` (the only place `direction` is
rendered — the Feed/Cards/Sections views don't show fact boards at all per
[0146](./0146-the-email-map-is-a-feed.md)) renders it `"<merchant> <amount> ·
paid"`.

## Rejected

- **A second, dedicated receipt-extraction LLM pass.** The magics call
  already reads the body; a second call to ask the same model the same
  question about the same text buys nothing a side-channel block doesn't
  already get for free ([0110](./0110-the-ai-passes-must-be-shown-the-email.md)'s
  cost discipline).
- **Reusing `debit`/`credit` for a receipt** instead of adding `'paid'`.
  Both misrepresent a settled purchase as either owed or refunded — the
  precise confusion the existing `PAID_NOISE` regex exists to prevent, now
  reintroduced by the LLM path instead of the regex path.
- **Waiting for the Finance feature to exist before mining anything.** The
  extraction mark fires once per thread, ever — deferring the extraction
  defers it permanently for every receipt already mined-and-marked by the
  time Finance ships.
- **Folding coupons into the same block.** Explicitly out of scope for this
  round (owner: "ignore for now, will come back") — a coupon is bulk mail by
  [0109](./0109-bulk-is-how-mail-was-sent.md)'s own definition and
  [0127](./0127-a-gate-needs-two-signals-agreeing.md) deny-lists it from the
  AI passes entirely; whether that needs a deliberate carve-out is a
  separate decision.

## Consequences

- A receipt now contributes a `paid` row on the Ledger tile the moment it's
  mined, with no UI change beyond the one render-line above — the tile
  archetype and category routing were already correct, only the fact was
  missing.
- `receipt_json` is banked for whenever the Finance tab moves past its
  ADR 0070 scaffold; nothing here builds that surface.
- Coupons remain wherever [0127](./0127-a-gate-needs-two-signals-agreeing.md)'s
  bulk gate already puts them — untouched, pending a future decision.
