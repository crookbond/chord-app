# Billing: where it lives and what to set

Design is in [ADR 0231](../notes/0231-a-family-pays-once-and-shares-one-pool.md)
(plans, family pool, promo codes, grandfathering) and ADRs 0195/0196 (a
subscription whose usage is the ledger). This page is the operational side.

## The Stripe account

- **The Stripe account is under `john@chordapp.ai`.** Sign in to the Stripe
  dashboard with that address.
- There is no business bank account yet, so Stripe pays out **to John
  personally**. Revisit when a business account exists (Stripe → Settings →
  Business → Bank accounts and currencies); nothing in Chord changes, only the
  payout destination.
- The dashboard shows it as **"Family Grocery Trip Chat LLC sandbox"** (test
  mode, `acct_1TvnHOJWvCeFWemU`). Everything below was created there on
  2026-10-09 and has to be repeated in the live account before charging real
  cards.
- As of 2026-10-09 **no Stripe key is set in any env file** and no real payment
  has been made. Webhooks have been driven only with locally signed events.

### Created in the sandbox (2026-10-09)

| Object | Id |
|---|---|
| Product "Chord Individual" | `prod_VPaFaiSgcHmNrW` |
| Individual, $7.99 / month | `price_1UOl5MJWvCeFWemUMZZ7XKU1` |
| Individual, $87.89 / year | `price_1UOl60JWvCeFWemUmbGUZoWH` |
| Product "Chord Family" | `prod_VPaHsv21wBCiJa` |
| Family, $24.99 / month | `price_1UOlzIJWvCeFWemU6pwaiVFX` |
| Family, $274.89 / year (11 × monthly) | `price_1UOlzMJWvCeFWemUsRlnYOaB` |
| Webhook destination `chord-billing` | `we_1UOl9fJWvCeFWemUziCSTFnz` → `https://chordapp.ai/api/v1/webhooks/stripe`, snapshot payload, API `2026-06-24.dahlia`, events `checkout.session.completed` + `invoice.paid` |

The first Family prices ($25.00 and $275.00) were archived the same day and replaced
by the two above; Stripe prices cannot be edited, only replaced, so a price change is
a new price id in `.env.prod` plus the portal's product list.

Both products carry `tax_code: txcd_10103000` (SaaS - personal use). **Managed
Payments is on by default on this account** (Stripe is the seller of record and
handles sales tax/VAT, for an extra 3.5% per payment), and checkout is refused
with "the product tax code is missing" until each product has an *explicit*
tax code: the dashboard's "Use preset" shows a code without storing one on the
product. Set it from the Workbench shell:
`stripe products update <prod_id> --tax-code=txcd_10103000`.

The customer portal is saved with cancel-at-period-end, plan switching between
those four prices (prorated), invoice history and payment-method updates.

Still yours to copy from the dashboard (not recorded anywhere here): the
**secret key** (Developers → API keys) and the webhook's **signing secret**
(`whsec_…`, on the destination page).

### API version

A new webhook destination only offers Stripe's current API versions, and the
payload shape follows the destination's version. From `2025-03-31.basil` an
invoice's line price moved to `pricing.price_details.price`, its subscription to
`parent.subscription_details.subscription`, and a line's `proration` under
`parent`. `parseInvoicePaid` reads both shapes; a handler that read only the old
one would receive a paid invoice, find no price and grant nothing.

## What to create in Stripe

Four recurring prices (test mode first, then live), in USD:

| Plan | Interval | Env var | List price |
|---|---|---|---|
| Individual | month | `STRIPE_PRICE_ID` | $7.99 |
| Individual | year | `STRIPE_PRICE_ID_YEARLY` | 11 × monthly (one month free) |
| Family of 4 | month | `STRIPE_PRICE_ID_FAMILY` | $24.99 |
| Family of 4 | year | `STRIPE_PRICE_ID_FAMILY_YEARLY` | 11 × monthly |

`STRIPE_PRICE_ID_BYOK` is the "bring your own key" base plan. **Leave it empty:**
BYOK is free and works without a base plan (ADR 0251). Setting it is the only
thing that makes BYOK owe a fee again.

The amounts Stripe charges are the Stripe prices. `PRICE_*_USD` and
`ANNUAL_FREE_MONTHS` only drive what the app **displays**, so change both
together or the screen will disagree with the card.

Also in Stripe:
- **Webhook endpoint** → `<WEB_ORIGIN>/api/v1/webhooks/stripe`, events
  `checkout.session.completed` and `invoice.paid`. Its signing secret is
  `STRIPE_WEBHOOK_SECRET`.
- **Customer portal**: save a configuration (Settings → Billing → Customer
  portal). Until it is saved Stripe returns 400 and "Manage billing" fails.

## Env keys

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the price ids above, `WEB_ORIGIN`,
and `BILLING_ENABLED=true` last. Billing turning on never exposes a purchase
path by itself: with the secret key or price ids empty, checkout answers 503 and
the webhook 404s. Secrets go through Secret Manager ([secrets.md](./secrets.md)),
not the VM `.env`.

## Cancelling

Plan card → **Cancel plan** (and **Resume plan** until the period ends) calls
`POST /me/billing/renewal`, which sets `cancel_at_period_end` on the Stripe
subscription ([ADR 0236](../notes/0236-cancel-is-one-click-and-ends-at-the-period.md)).
The plan works until the paid period ends and then lapses; nothing is refunded and
nothing is deleted. To test it, buy once in the sandbox, press Cancel plan, and
check the subscription shows "Cancels" in the Stripe dashboard; Resume undoes it.
**Change plan** switches in place (price swapped on the same subscription, the
difference invoiced now, a cancel cleared). The portal is only for updating the
card ("Update payment card"). An App Store plan is cancelled in the device's Subscriptions settings.

## App Store

**On (ADR 0340, after App Review rejected ADR 0241 under guideline 3.1.1).** On an iPhone the
AI Plan card sells through the App Store (`IOS_IN_APP_PURCHASE` in `mobile/src/plan-card.tsx`);
a plan bought on the web shows one **Manage billing ↗** link to the Stripe portal. Until every
step below is done the iPhone falls back to ADR 0241's report-only card, which App Review will
reject, so all of it is needed before the next submission. Then, in App Store Connect, attach the
subscriptions to the app version on its version page ("In-App Purchases and Subscriptions") so
they are reviewed with it.

Sold through RevenueCat: `REVENUECAT_WEBHOOK_SECRET`, the `APPLE_PRODUCT_*` ids
(defaults `chord.individual.monthly`, `chord.family.yearly`, …), and
`EXPO_PUBLIC_REVENUECAT_IOS_KEY` in the app build. The iOS purchase needs a new
native build. Apple offer codes replace promo codes on iOS.

### Setting it up (in this order)

The server offers an App Store purchase only when `BILLING_ENABLED` **and**
`REVENUECAT_WEBHOOK_SECRET` are both set (`appleAvailable` on `/me/billing`), and
the app uses it only when its build contains the SDK **and** has the iOS key.
Either half missing means iOS keeps using the web checkout, so each step below
is safe to do alone.

1. **App Store Connect** (app `app.chord.demo`): sign the Paid Applications
   agreement and add banking/tax. Create ONE subscription group and put all four
   products in it — a single group is what makes "one live subscription" true and
   turns a switch into `PRODUCT_CHANGE`. Rank them family above individual, yearly
   above monthly within each, and the BYOK base plan last. Ids must equal the
   `APPLE_PRODUCT_*` values (`chord.individual.monthly|yearly`,
   `chord.family.monthly|yearly`, `chord.byok.monthly` for the base plan; ADR
   0238). Each needs a
   price, a localisation and a review screenshot to leave "Missing Metadata";
   StoreKit will not return a product in that state, even in the sandbox.
2. **App Store Connect → Users and Access → Integrations → In-App Purchase**:
   generate a key (`.p8`). Upload it in RevenueCat (Project → Apps → the iOS app)
   so receipts are validated with StoreKit 2.
3. **RevenueCat**: create the project and the iOS app (bundle id
   `app.chord.demo`). Add the four products. The app buys by product id, so no
   offering is required; attach them to one entitlement anyway so the dashboard is
   readable. (Five products, not four.) Copy the app's **public SDK key** (`appl_…`).
4. **Webhook**: `openssl rand -hex 32` makes the secret. In RevenueCat →
   Integrations → Webhooks set the URL to `https://chordapp.ai/api/v1/webhooks/revenuecat`
   and the Authorization header to the secret, with events from **Production and
   Sandbox** (TestFlight and App Review are always sandbox). Put the same value on
   a `REVENUECAT_WEBHOOK_SECRET=` line in `scripts/deploy/.env.prod`, then
   `scripts/deploy/secrets.sh push --yes` and deploy (the name is in
   `secret-keys.txt`). A wrong secret is a 401 in the server log.
5. **Apple → RevenueCat notifications**: copy RevenueCat's App Store Server
   Notifications URL into App Store Connect → App Information (production and
   sandbox). Renewals, refunds and expirations arrive without waiting for the app.
6. **App build**: put `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in the `production` env of
   `mobile/eas.json` (it is public, like the Google client ids) and run a native
   build. An OTA update cannot add the SDK; an older build simply keeps the web
   checkout.
7. **Test with a sandbox tester** (App Store Connect → Users and Access →
   Sandbox): buy, restore on a second device, cancel in the device's
   Subscriptions settings, and work through item 3 of "Before turning it on"
   below. Sandbox time is compressed (a month is minutes), so renewals and an
   `EXPIRATION` arrive fast.

Things to expect: a plan sold by the App Store cannot be switched or cancelled
from the plan card (the API answers `apple`; the card sends the person to the
device's Subscriptions page). The card hides the purchase buttons while a plan is
active, so a test account that is already on a Stripe plan has to be reset first
with `npm run billing:reset` (and its Stripe subscription cancelled); the reset
refuses an App Store plan still inside its period.

## Operator commands

```bash
npm run grandfather:users -- --before <date>            # dry run
npm run grandfather:users -- --before <date> --apply    # permanent free individual allowance
npm run promo:codes                                     # mint single-use free-month codes
```

## Resetting one account to test purchase scenarios

`billing:reset` puts a single account back to "never subscribed" so first buy,
annual, family, promo code, cancel, resume and lapse can all be walked again on
the same real account. Run it on the VM (dry run unless `--apply`):

```bash
cd /srv/chord && chord-with-env npm run billing:reset --workspace=server -- --email you@example.com
cd /srv/chord && chord-with-env npm run billing:reset --workspace=server -- --email you@example.com --apply
```

It clears the subscription columns and keeps the Stripe customer, so the next
checkout reuses it. It reads the Stripe subscription first: clearing our side
does not stop Stripe renewing, and a renewal would grant the plan again, so it
refuses while Stripe says the subscription will renew. A cancelled one (ends at
period end, or already cancelled) is safe. Options:

| Flag | Effect |
|---|---|
| `--cancel-in-stripe` | end a still-renewing subscription now, then clear |
| `--drop-customer` | also forget the Stripe customer id (checkout mints a new one) |
| `--clear-grandfather` | also remove the free founding-member allowance |
| `--created-at fresh\|<ISO>` | move the sign-up time. The free token allowance (ADR 0325) counts usage since sign-up, so `fresh` gives it back. To put an account past it, spend it or set `FREE_TOKEN_ALLOWANCE=0` on a test server. Prints the old value to restore |
| `--force` | proceed although Stripe could not be asked |
| `--allow-live` | permit an `sk_live_` key (refused otherwise) |

It never touches the family roster, groups, usage rows or promo codes (it only
reports the roster count). Mint a new promo code with `npm run promo:codes`.
An App Store plan still inside its paid period is refused: only the device can
end it.

## Before turning it on

1. Stripe test mode: one purchase per price, a promo code, the portal.
2. Check that a promo trial's first real `invoice.paid` extends the period we
   opened.
3. RevenueCat sandbox: purchase, restore, cancel; confirm `PRODUCT_CHANGE`
   carries `new_product_id`.
4. Run the grandfather script with `--apply` **before** `BILLING_ENABLED=true`,
   or existing users meet the paywall.
5. Checklist form of the above: `docs/tasks/friends-and-family-release.md` (J4).
