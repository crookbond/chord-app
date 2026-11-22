# 0238 — The BYOK base plan is a subscription in both stores

**Status**: accepted; the fee is switched off by ADR 0251 (BYOK is free)
**Date**: 2026-10-10

## Context

ADR 0195 decided that someone who brings their own model key still pays a
small base fee, because Chord's cost is a fixed part (hosting, messaging) plus a
part that scales with tokens, and a BYOK user was paying none of the fixed part.
The mechanism shipped, but the product never became sellable:

- **The Stripe price was never created.** `STRIPE_PRICE_ID_BYOK` sat empty in
  prod, and while it is empty the entitlement code treats BYOK as free by
  design. So the fee existed in code and nowhere else.
- **It was only half a product.** The card showed a bare "Subscribe" with no
  amount; there was no way to end it (no cancel, no manage link), because the
  BYOK entitlement did not carry `periodEnd`/`source`/`interval` and the card
  could not tell a payer from a non-payer; and on iOS it would open Stripe's web
  checkout from inside the app for a digital subscription, which is the one
  thing ADR 0231's App Store route exists to avoid.

## Decision

**The base plan is a fifth product, sold the same way the other four are.**

- **Stripe**: its own product ("Chord Base", same digital-services tax code as
  the others) with one monthly price, $2.99. Its id is `STRIPE_PRICE_ID_BYOK`.
  There is no annual price.
- **App Store**: `chord.byok.monthly` (`APPLE_PRODUCT_BYOK_MONTHLY`), in the same
  subscription group as the other four and ranked lowest, so a person never
  holds two live subscriptions. RevenueCat's webhook maps it to `byok_base` and
  writes the same columns every other sale writes.
- **Entitlement**: the active-BYOK branch of `getEntitlement` now returns
  `interval`, `source` and `periodEnd` like the token branches do, so "is this
  paid, until when, and by whom" has one answer for every plan.
- **Plan card**: shows the price (the store's localized string on iOS, else
  `PRICE_BYOK_USD`), buys through the App Store on a build that has the SDK and
  through Stripe otherwise, and gives the payer Cancel / Resume / Update card, or
  "Manage in the App Store". A BYOK member covered by someone else's family plan
  gets none of those: it is not theirs to end.
- **Chat**: `get_checkout_link` gains `plan: base`. Cancelling is the existing
  `set_subscription_renewal`, which already does not care which plan it is.
- `PRICE_BYOK_USD` is display only, like the other `PRICE_*` values; the charge is
  whatever the Stripe price / App Store product says, and the two are kept in
  step by hand.

## Consequences

- **Turning the fee on is one config line** (`STRIPE_PRICE_ID_BYOK`). At the
  time of writing prod has no BYOK users, so it blocks nobody. From then on a
  BYOK user past the 30-day trial with no plan of their own, no family cover and
  no grandfathering (ADR 0231) has no AI until they subscribe - that is the
  intent, but it is a visible change for anyone who connects a key later.
- A BYOK subscriber who later adds a system-key plan, or the reverse, is not
  handled by a switch: the base plan is not part of the plan switcher
  (`not_switchable`), and the card hides the purchase buttons while a plan is
  live. Ending one and starting the other is the path.
- Apple keeps its commission of a $2.99 sale, so the store price may be set
  higher than the web one; the app always shows the store's own figure.
- Not covered: an annual base price, and a bundle ("base plus N tokens").

## Rejected

- **Leaving iOS on the web checkout for this one plan** - the same objection as
  ADR 0231's for the other four, and it would be the only plan that needed it.
- **An annual price** - $2.99 is already the smallest charge we make; an annual
  version saves nothing worth the extra product in two stores.
- **Folding the fee into the individual plan as a discount** - it would make
  "bring your own key" a way to pay less for the same thing instead of a way to
  pay for different things.
- **Keeping BYOK free on iOS only** - a user could then avoid the fee by being
  on the platform where it is hardest to charge it.
