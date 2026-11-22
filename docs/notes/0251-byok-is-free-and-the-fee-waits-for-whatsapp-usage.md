# 0251 — BYOK is free, and a fee waits for WhatsApp usage

**Status**: accepted
**Date**: 2026-10-15
**Amends**: ADR 0195 (BYOK pays rent), ADR 0238 (the base plan is a subscription)

## Context

ADR 0195 made someone who brings their own model key pay a small base fee, on
the reasoning that Chord's cost is a fixed part (hosting, messaging) plus a part
that scales with tokens, and a BYOK user pays none of the token part. ADR 0238
priced it at $2.99 a month and made it a product in both stores.

The owner's decision on 2026-10-15: **bringing your own key is free, and it just
works — nobody is asked for a base plan.** The part of Chord with a real
per-user cost beyond the model is WhatsApp, and only a BYOK user who *also*
wants WhatsApp should pay, priced from measured usage.

What was measured (prod, 30 days to 2026-10-15): two active WhatsApp channels,
157 outbound messages, a mean of about 80 per user per month, p90 about 135.
Meta bills service replies at the market's utility rate since 1 Oct 2026 (the
dedicated pricing-update page says so; the US figure of about $0.0034 is from
third-party copies of the rate card and is unconfirmed), so a typical user costs
roughly $0.25 to $0.50 a month in Meta fees. Whether Meta's 1,000 free messages
per business phone number per month exists is also unconfirmed. That is too thin
a sample and too many unconfirmed inputs to set a price today.

## Decision

- **BYOK is free by configuration.** ADR 0195 already made BYOK free while
  `STRIPE_PRICE_ID_BYOK` is empty; the owner blanked that line in
  `scripts/deploy/.env.prod` (it held the $2.99 price). No new switch: the empty
  price *is* the decision, and setting it again is the only way the fee comes
  back.
- **Nothing is deleted.** The base plan, its Stripe product, the App Store
  product and the webhook mapping stay, dormant, so a usage-priced WhatsApp
  add-on can reuse them.
- **The app stops saying it is needed.** `BillingStatus.byokPriceUsd` and
  `appleByokProduct` are sent only while a base price is configured, and their
  absence is how the client knows: the card reads "Using your own key - free"
  with nothing to buy or manage (on an iPhone, no Manage billing button either —
  `billingCardModel`), and the bot's trial-ended message says BYOK is free
  instead of "still needs the base plan". The `get_checkout_link` description
  tells the model that BYOK is free, so it does not offer `base`.

## Consequences

- Everything else about billing is unchanged: the system-key plans, the family
  plan, the trial, grandfathering, and `BILLING_ENABLED=false` in prod.
- A live `byok_base` subscription would no longer be reflected in the
  entitlement while the price is empty (it is free either way); there were none
  in prod when this was written, and one could be ended from Stripe's portal.
- **Open, by decision**: what a BYOK user with WhatsApp pays. It needs an
  entitlement that gates the WhatsApp binding, a price, and confirmation of the
  Meta rate and any free allowance from WhatsApp Manager's charged-message
  report.
- No bot tool is added: this removes a way to be charged rather than adding a way
  to change something.

## Rejected

- **A `BYOK_BASE_FEE_ENABLED` flag** (built, then removed the same day): it
  guarded against a configured price charging anyone, but the owner preferred
  config-only control, and an empty `STRIPE_PRICE_ID_BYOK` already says it.
- **Delete the base plan.** The WhatsApp add-on will want the same plumbing.
- **A smaller base fee.** The owner's call was free, with WhatsApp paid on usage.
