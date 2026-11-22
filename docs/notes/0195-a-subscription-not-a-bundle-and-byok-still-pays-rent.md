# 0195 — A subscription, not a bundle — and BYOK still pays rent

**Status**: accepted
**Date**: 2026-09-22

## Context

ADR 0075 built Stripe checkout as a one-time `mode: 'payment'` purchase: buy
a bundle, spend it whenever, balance never expires. ADR 0194 made the debit
honest (real tokens, not a flat per-turn rate) but left the *purchase* side
untouched. Owner decision: move to a real monthly subscription —
`mode: 'subscription'`, a fixed token allowance that **resets every period
and does not roll over** (unused tokens are not a saved-up asset).

Second, sharper decision: **BYOK users pay too.** ADR 0063 made BYOK
unconditionally free — "their key, their cost, not ours" — because the only
cost being reasoned about was the LLM call. But Chord's own costs aren't
only the LLM call: hosting and per-message WhatsApp charges (ADR 0139/0140,
Meta billing from Oct 2026) are fixed costs Chord incurs *regardless* of
whose model key answers a turn. So the real price shape is `fixed cost
(hosting + WhatsApp) + K × tokens` — and a BYOK user, paying $0 of the K
term, was previously paying $0 of the fixed term too. Owner: cover it with
a second, smaller "base" subscription BYOK users pay instead.

## Decision

**Two Stripe products, one mechanism.** `STRIPE_PRICE_ID` (existing) is now
a subscription price for the system-key plan (base cost + token allowance,
bundled into one price); new `STRIPE_PRICE_ID_BYOK` is a subscription price
for the base-only plan. Both dollar amounts are set directly in Stripe's
dashboard — same posture as ADR 0075, nothing here encodes a price. **X is
a placeholder**: `STRIPE_PRICE_ID_BYOK` ships unset, meaning BYOK stays
free exactly as it is today until the owner actually creates that price in
Stripe (mirrors `checkoutAvailable`'s existing "unconfigured deploy exposes
no purchase surface" rule).

**`invoice.paid` is the single grant/renewal choke point** — not
`checkout.session.completed`. Stripe fires an invoice for every billing
period including the first, so reacting to `invoice.paid` uniformly covers
initial signup and every renewal with one code path — no separate
first-time-vs-renewal branch to keep in sync, and no risk of double-granting
by reacting to both events for the same payment. `checkout.session.completed`
keeps a narrower job: link `stripe_customer_id`/`stripe_subscription_id` to
the user (`client_reference_id`, same as ADR 0075) — necessary because
`invoice.paid` events carry a Stripe `customer` id, not our user id, so
without this link the renewal handler has nothing to look the user up by.

**A reset, not a grant.** New `resetTokenAllowance(db, userId, amount, ref)`
in `billing.service.ts`, alongside `grantTokens`/`debitTokens` — it SETS the
balance to `amount` rather than adding, so last period's leftover is
discarded, matching "resets, doesn't roll over." Idempotent by `ref` (the
Stripe invoice id) the same way every other ledger write already is; a
duplicate webhook delivery for the same invoice is a no-op, not a
double-reset. New `credit_ledger.reason` value `'subscription_reset'`.

**BYOK's entitlement now depends on subscription state, when the base plan
is configured.** `getEntitlement`'s BYOK branch used to be unconditional
(`if (row.model_key_ciphertext) return entitled: true`). Now: if
`STRIPE_PRICE_ID_BYOK` isn't set, unchanged — always entitled, the
placeholder-X state. If it IS set, BYOK is entitled only while
`subscription_current_period_end` (same field the system-key path already
uses) is in the future; otherwise `reason: 'byok_unpaid'`, a new value
distinct from `'none'` so the UI can point at the *base* plan rather than
the token plan. The system-key path's own logic — trial → balance-based
`'tokens'` → `'none'` — is **unchanged**; what changed is only where a
nonzero balance comes from (periodic reset vs. a one-time bundle) and that
distinction lives entirely in the webhook, not in `getEntitlement`.

**Cancellation is inaction, not an event handler.** "Keep working until the
period ends" falls out of the period-end check that already exists for the
trial (`Date.now() < Date.parse(periodEnd)`) — a cancelled subscription
simply stops generating new `invoice.paid` events, so the stored
`subscription_current_period_end` stops advancing and naturally expires on
its own. A failed renewal payment (Stripe's dunning retries) behaves
identically: no successful `invoice.paid` means no extension, and access
lapses only once the last successfully-paid period actually ends — exactly
"keep working until period end," achieved by **not** writing a
`customer.subscription.deleted`/`invoice.payment_failed` handler at all,
rather than writing one that has to get the grace period right.

**Migration `085`** adds four nullable `users` columns: `stripe_customer_id`,
`stripe_subscription_id`, `subscription_plan` (`'system'` \| `'byok_base'`),
`subscription_current_period_end`. Additive, matching every migration in
this codebase to date (ADR 0194's own reasoning for why a rename would have
been the exception, not the rule).

**`TOKENS_PER_BUNDLE` renamed to `MONTHLY_TOKEN_ALLOWANCE`.** Same
consistency argument ADR 0194 made for "credits": under a subscription,
there is no bundle, only a recurring allowance — keeping the old name would
reintroduce exactly the naming disconnect ADR 0194 just closed.

**One-time purchase removed, not kept alongside.** `mode: 'payment'` and its
single-grant `checkout.session.completed` handling are gone; a family plan
is a subscription now, not a purchase, and maintaining two parallel
buy-tokens mechanisms serves no stated need.

**Unverified against a live Stripe test-mode account** — same honesty
posture as ADR 0118/0140: the invoice line-item shape this reads
(`lines.data[].price.id`, `lines.data[].period.end`) is Stripe's
long-stable REST shape, but nothing here has round-tripped a real webhook
delivery. Flagged for a smoke test with `stripe listen` before this goes
live, the same manual step ADR 0075 itself called for.

## Alternatives considered

- **Handle `customer.subscription.deleted`/`invoice.payment_failed`
  explicitly** — rejected: the period-end field already produces the
  "keep working until period end" behavior for free; a handler here would
  only add a second way to reach the same state, and a second way to get
  it wrong.
- **Grant on `checkout.session.completed`, not `invoice.paid`** — rejected:
  would need a second, different code path for renewals (which have no
  Checkout Session at all, only invoices), reintroducing the
  first-time-vs-renewal branch `invoice.paid`-only avoids.
- **One Stripe price with a BYOK discount instead of two products** —
  rejected: Stripe coupons/discounts are for promotions, not a durable
  second price tier, and two distinct base costs (system-key plan vs
  BYOK-base plan) are two different products by nature.
- **Keep the one-time bundle purchase as a fallback option** — rejected:
  no stated need for it, and it would mean `getEntitlement` reasoning about
  three purchase shapes (trial, subscription, leftover one-time bundle)
  instead of two.

## Consequences

- BYOK is no longer unconditionally free the moment `STRIPE_PRICE_ID_BYOK`
  is set — existing BYOK users on a deploy that later configures the base
  plan will see `reason: 'byok_unpaid'` once their trial ends, needing to
  subscribe. This is deliberate (the owner's whole point), but worth an
  announcement when that price actually gets configured.
- The monthly allowance number itself is still a placeholder
  (`MONTHLY_TOKEN_ALLOWANCE`, unchanged value from ADR 0194's
  `TOKENS_PER_BUNDLE` default) — sizing it against the real
  `fixed + K × tokens` formula is a pricing exercise, not something this
  ADR resolves.
- A user who cancels mid-period and re-subscribes before period end gets a
  fresh `invoice.paid` for the new subscription, which resets their balance
  again — mid-period re-subscription is not specially handled and simply
  looks like starting a new period early.
