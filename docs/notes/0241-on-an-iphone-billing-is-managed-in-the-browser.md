# 0241 — On an iPhone, billing is managed in the browser

**Status**: superseded for iOS by ADR 0340 (App Review rejected it under 3.1.1); the report-only card remains for Android and as the iPhone fallback
**Date**: 2026-10-11

## Context

ADR 0231 sold plans on iOS through the App Store (RevenueCat), because Apple
requires digital subscriptions sold inside an app to go through In-App
Purchase. Building that meant, in order: an Apple legal-entity form, a Paid Apps
Agreement with banking and tax, five App Store products in one subscription
group, a RevenueCat project and webhook, and a new native build - none of it
needed for the family-and-friends cohort, which already pays on the web.

The owner chose to shelve it. Chord is an email reader, and the reader-app
pattern (Netflix, Spotify, Kindle) is the model: the app shows what you have
and where it stands, and managing the money happens outside the app.

## Decision

**On an iPhone the AI Plan card reports the plan and sends every billing action
to the browser.**

- The card shows: the plan and interval (or trial / trial ended / covered by a
  family plan / base plan), the renewal or cancellation date, a spent-allowance
  line, and one **Manage billing ↗** button with "Opens in your browser" under
  it. No prices, no plan picker, no promo field, no Cancel / Resume / Change /
  Update card.
- The button opens **Safari**, never an in-app browser sheet (an in-app sheet is
  still in-app commerce): a Stripe subscriber lands on their billing portal (the
  server already builds that link, so there is no second sign-in); anyone else
  lands on the web app's Settings, where plans are chosen. A legacy App Store
  plan points at the device's Subscriptions page.
- A member covered by someone else's family plan, billing-off servers and
  founding members with no plan show no button: there is nothing for them to
  manage.
- **Connecting OpenRouter** leaves the app for Safari too and returns on
  `chord://settings?byok=...`. (It is not itself a purchase, but it is where a
  person adds credit, and the owner wanted the whole money path in one place.)
  The return handler no longer ignores a second connect in the same session.
- Returning from the browser refreshes the billing status.
- **One switch**: `IOS_BILLING_LINK_OUT` in `plan-card.tsx`. Set to `false` the
  in-app purchase path (App Store / RevenueCat) is exactly as ADR 0231 left it,
  and all of its code, the webhook, the product map and the BYOK product from ADR
  0238 stay in place, dormant (`REVENUECAT_WEBHOOK_SECRET` is unset, so the server
  never advertises it). Web and Android are unchanged.
- The decision of what the card says lives in `kernel/src/billing-card.ts`
  (`billingCardModel`), with a test per state and one asserting no price ever
  appears, because the mobile app has no test harness.

## Consequences

- **Review risk is Apple's to decide.** Chord is closer to a reader app than to a
  game, but Apple's text on external links has changed (US storefront, 2025) and
  has been in litigation; outside the US the same button can read as a call to
  action to purchase elsewhere. The button is shown on every storefront by
  choice. If review objects, the fallback is the text-only variant (no button,
  no address), which is one condition in `billingCardModel` plus the render.
- Subscribing is now two steps from the app (leave, sign in on the web if
  needed, choose). That is the cost of not paying Apple's commission and not
  building the App Store side yet; conversion on iOS will be lower than it would
  be with in-app purchase.
- The bot's `get_checkout_link` still returns a checkout link on an iPhone. The
  bot cannot tell which client is reading, and the link opens the web checkout,
  so it was left alone; it is the one remaining in-app route to a purchase.
- A subscriber who cancels now does so on the Stripe portal; the in-app
  `set_subscription_renewal` route and the bot tool of the same name are
  unchanged and still work (web, Android, chat).

## Rejected

- **Text only, no button** - the safest reading of the rules and the worst
  experience; kept as the documented fallback rather than the starting point.
- **Region-gating the button** - the App Store storefront cannot be read in an
  OTA update, and the phone's region is only a guess at it.
- **Keeping Cancel in the app** - cancelling is not a purchase, but a card with
  one billing button is easier to defend and to explain than one with several.
- **Deleting the App Store code** - Apple billing "may come later"; the work is
  done, tested and worth keeping behind one switch.
