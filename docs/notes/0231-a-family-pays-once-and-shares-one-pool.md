# 0231 — A family pays once and shares one pool

**Status**: accepted
**Date**: 2026-10-08

## Context

ADR 0195/0196 built one subscription: an individual plan, monthly, sold by
Stripe, with a 5M-token monthly allowance computed from `token_usage`. The
owner's launch pricing is wider than that:

- **Individual** and **Family of 4**, each **monthly or annual** (annual =
  twelve months for the price of eleven);
- sold by **Stripe on the web** and by the **App Store in the iOS app**;
- a family's tokens are a **pool** — "one is done but the other is not, we
  keep going until the family is done";
- family members are added by **talking to the bot in the 1:1**, with their
  email or phone collected and an invite sent, and the owner optionally lets
  them be **Chordinators** (ADR 0026);
- **discount codes** that are generated, applied and burned, giving a free
  first month for anyone who then subscribes;
- everyone who is here **before billing goes live** keeps the product free,
  permanently.

Prices are not yet settled ($7.99 individual and $24.99 family at the time of
writing), so they must change without an app release.

## Decision

**One entitlement function, several sellers.** Stripe and RevenueCat (the App
Store) both write the same `users` columns — `subscription_plan`
(`system` | `family` | `byok_base`), `subscription_interval`,
`subscription_source`, `subscription_period_*`. `getEntitlement` reads those
and never learns who sold it. That is what let a second seller arrive without
a second code path through every gate.

**The allowance window is a month, even on an annual plan.** An annual
invoice's period is a year, so ADR 0196's "usage since the period started"
would hand an annual subscriber twelve months up front. `allowanceWindowStart`
steps whole months from the period start and takes the latest one not in the
future; a monthly plan is inside its first step, so nothing changes for it.

**A family is a pooled allowance read from the owner, every time.**
`family_members` is the roster — `profile` (no invite, no seat, no tokens: a
young child), `invited` (the seat is held), `active` (has an account and is
covered). Coverage is *never copied onto the member*: `getFamilyCoverage`
looks up the seat, then the owner's current period, on every call. A lapsed
owner therefore covers nobody without a single row changing, and removing a
seat ends coverage immediately. The pool is `FAMILY_TOKEN_ALLOWANCE`
(4 × the individual 5M), and the usage summed is the whole family's
(`getPooledTokenUsageSince`). Seats are four **including the owner**.

**Invites ride the existing `/join/<CODE>` link.** A family code is `FAM` plus
twelve characters; a group code is six, and could begin `FAM` by chance, so
the prefix alone is not the test (`isFamilyInviteCode` requires the length).
Reusing the path means the verified universal-link / app-link route (ADR
0048) covers it with no new association file. The bot does not send the
invite — it returns the link and a message, then either stages
`compose_email` (the owner taps, so it goes from their own mailbox) or
attaches a "Text the invite" card. The Settings card shares through the OS
share sheet. Chord has no SMS or transactional mail sender and this adds none.

**Chordinator is the existing trust grant, applied on acceptance.**
The owner's yes at invite time is stored on the roster row; when the invitee
joins, `setGrant(owner ← member, task+event)` runs. Flipping it later on a
seated member takes effect at once, both ways, and leaving or being removed
revokes it. Nothing is granted to a person who has no account yet.

**Prices are configuration, shown from the server.** `PRICE_INDIVIDUAL_USD`,
`PRICE_FAMILY_USD`, `ANNUAL_FREE_MONTHS` (and optional explicit annual
figures) are turned into `BillingStatus.prices` by `derivePlanPrices`. The
*charge* is the Stripe price / App Store product; the display number is
advisory, and on iOS the store's localized string replaces it once loaded.
`BillingStatus.checkoutPlans` and `appleProducts` say what is purchasable and
what the products are called, so a half-configured deploy shows only what
works and the app hardcodes no product id.

**One live subscription at a time.** `startCheckout` (shared by the REST route
and the `get_checkout_link` tool, so they cannot disagree) answers 409 when a
paid period is running; a plan change goes through the seller's own surface —
`POST /me/billing/portal` for Stripe, the device's subscription settings for
Apple — because a second subscription would bill twice. `invoice.paid` now
reads the subscription's own line, not a proration credit that a portal plan
change bills beside it.

**RevenueCat for the App Store.** It owns receipt validation and Apple's
server notifications; we receive one shared-secret webhook. A purchase or
renewal opens a period; `CANCELLATION` changes nothing (the customer keeps what
they paid for, the same reasoning as ADR 0195); only `EXPIRATION` closes one.
Late and out-of-order deliveries are guarded by when the period *began* — not
when it ends, because an immediate upgrade from an annual plan to a monthly
one legitimately ends sooner than the plan it replaces. An expiration never
touches a subscription Stripe sold. The SDK is a native module, so the app
loads it lazily and reports "unsupported" on a build that predates it; the
purchase UI then falls back to the web checkout, as before.

**Promo codes: web is ours, iOS is Apple's.** A code is a row in
`promo_codes`: single-use, optionally expiring, generated by
`npm run promo:codes`. It is *checked* when typed and *burned* only when the
subscription it was applied to starts (`checkout.session.completed`), so an
abandoned checkout costs nothing. It becomes `subscription_data[trial_period_days]`
on the Stripe session — the card is taken up front and charged when the free
month ends, which is what "free as long as you subscribe, then it charges you"
means. A *coupon* was rejected for this: a 100%-off-once coupon on an annual
price makes the **whole year** free. On completion we open the free period
ourselves instead of waiting for Stripe to issue and pay a $0 trial invoice.
The App Store cannot honor a code of ours, so iOS uses Apple's offer codes,
generated in App Store Connect and redeemed through StoreKit's sheet.

**Grandfathering is a flag, set by a script with a cutoff.**
`users.grandfathered_at`, written by `npm run grandfather:users -- --before
<date> [--apply]` (dry-run by default), excluding shadow accounts. A flagged
user gets the individual allowance free on a **calendar-month** window (no
subscription period exists to anchor to), capped at
`GRANDFATHER_TOKEN_ALLOWANCE`, with no Stripe or Apple object that could
expire, drift, or be cancelled by accident. It ranks below a paid plan the
user later buys, and a grandfathered BYOK user owes no base fee. It is *not*
a migration: "existing" means "before the day billing goes live", which no
migration can know, and one that ran on deploy would sweep in everyone who
signed up in between.

**Chat parity** (CLAUDE.md): `add_family_member`, `remove_family_member`,
`list_family_members`, `get_checkout_link` — personal-only, reusing the same
service functions as the routes. The `add_family_member` description carries
the conversation: ask once for what is missing (invite or profile? email or
phone? may they be a Chordinator?), never invent contact details, and say
"ready to send", never "sent". Removal asks on an ambiguous name. The roster
listing never hands the model an invite link to recite.

## Consequences

- **Not verified against live services.** No Stripe account is connected to
  this repo yet (every `STRIPE_*` value is empty), so no checkout, trial,
  portal or webhook has round-tripped; the same is true of RevenueCat and the
  App Store. The parts that can be tested without them are (the webhooks are
  driven with locally computed signatures and synthetic events), but three
  assumptions need a test-mode run: that a promo trial's first real
  `invoice.paid` extends the period we opened; that the billing portal is
  configured (Stripe returns 400 until it is saved in the dashboard); and
  that RevenueCat's `PRODUCT_CHANGE` carries `new_product_id`.
- **The grandfather cap is a real cost.** Every existing user can spend up to
  `GRANDFATHER_TOKEN_ALLOWANCE` a month for nothing, indefinitely. It is
  bounded per user, not in total.
- **Per-seat attribution is lost on purpose.** Within a family nobody is
  individually capped; one heavy user can use most of the pool. That is the
  requested behaviour.
- **A member who owns nothing and leaves gets no refund logic** — they simply
  stop being covered; the owner's bill is unchanged.
- **Non-US App Store storefronts** are not distinguished: iOS sells through
  the App Store wherever RevenueCat is configured, which is the compliant
  default. The earlier plan of linking out to web checkout from the iOS app
  (guideline 3.1.1(a), US only) now applies only to builds without RevenueCat.
- **Apple prices come in tiers.** $7.99 exists; an exact $24.99 family price
  and the annual figures ($87.89 / $274.89) may need the nearest tier. Keep
  the Stripe price and the App Store product at the same amount, or users see
  two prices.

## Rejected

- **A Stripe coupon for the free month** — makes an annual plan free for the
  year; a trial is the correct primitive.
- **Our own code system on iOS** — the App Store would not honor it without
  server-signed promotional offers; Apple's offer codes already generate and
  burn single-use codes.
- **Granting grandfathering inside a migration** — cannot know the cutoff.
- **A $0 Stripe subscription per grandfathered user** — creates 1,000 objects
  to keep in sync with something one column says.
- **Copying coverage onto the member row** — the thing that would let a
  lapsed owner keep covering a family.
- **Per-seat token caps** — the owner asked for the opposite.
- **Server-sent invites** — needs an SMS and a mail sender we do not have.
- **A new link route for family invites** — needs a new association file and
  an Android build.

## Addendum 2026-10-09 - the webhook shape follows the destination's API version

Setting up the sandbox webhook turned up what the first draft of `parseInvoicePaid` got wrong:
a new destination only offers Stripe's current API versions (2026-06-24.dahlia, 2026-09-30.endive,
a preview), and from 2025-03-31.basil an invoice moved the fields the handler read - the line
`price.id` became `pricing.price_details.price`, `invoice.subscription` became
`parent.subscription_details.subscription`, and a line's `proration` moved under its `parent`.
Every test fixture used the old shape, so all of it passed while a real paid invoice would have
parsed with no price and granted nothing - silently, since an unknown price is an ordinary
"not one of ours" outcome. The parser now reads both shapes (new first, old as the fallback), and
a proration line is recognised under either. Not yet confirmed against a real delivery: the first
sandbox purchase's `invoice.paid` is the check, and its payload is on the destination page in the
dashboard. Rejected: pinning an old API version on the destination (the dashboard does not offer
one for a new destination, and a pinned version is a deadline) and sending the account back to an
older default.

## Addendum 2026-11-05 - the pool is the seats times the individual allowance

The pool was its own number (`FAMILY_TOKEN_ALLOWANCE`, default 20M) and the "4 x the individual
5M" link existed only in a comment, so raising `MONTHLY_TOKEN_ALLOWANCE` left families on 20M.
Owner rule: a family of four always gets four times the individual allowance. The default is now
0, meaning "work it out" (the same convention as the `PRICE_*_YEARLY_USD` fields), and
`familyTokenAllowance()` in `billing.service.ts` returns `FAMILY_SEATS * MONTHLY_TOKEN_ALLOWANCE`
unless `FAMILY_TOKEN_ALLOWANCE` is set above 0. It is the only reader, so the allowance
`getEntitlement` enforces and the one Settings shows (`BillingStatus.tokensQuotaPerMonth`, from
`ent.allowance`) are the same number. Rejected: deleting the override (a pool that is deliberately
not 4x would then need a code change).
