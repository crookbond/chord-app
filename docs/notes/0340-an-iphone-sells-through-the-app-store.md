# 0340 — An iPhone sells through the App Store

**Status**: accepted
**Date**: 2026-11-13
**Supersedes**: ADR 0241 (for iOS). Android (ADR 0263) is unchanged.

## Context

The first App Store submission (1.0, build 55, reviewed 13 Nov 2026) came back
with two problems.

1. **Guideline 3.1.1 (In-App Purchase).** ADR 0241 made the iPhone app report
   the plan and send every billing action to Safari, on the reading that Chord
   is close to a reader app. App Review disagreed: the app "accesses digital
   content purchased outside the app ... but that content isn't available to
   purchase using In-App Purchase." On the US storefront Apple now allows a link
   to an outside payment page, but only beside In-App Purchase, not in place of
   it (3.1.3(b) multiplatform services). An email client is not a "reader app" in
   Apple's sense (magazines, books, music, video), so 3.1.3(a) does not apply.
2. **Guideline 5.1.1(iv) (permission requests).** The ADR 0258 location card on
   Action Items had **Use my location** and **Not now**. Apple's rule: a message
   shown before a system permission prompt must always go on to that prompt;
   declining is done in the prompt, not on our message.

ADR 0231 already built the App Store path (RevenueCat, five products in one
subscription group, the webhook, restore, offer codes); ADR 0241 left it dormant
behind one switch. The owner chose to build the full In-App Purchase rather than
argue the reader-app case or remove billing from the iPhone.

## Decision

**On an iPhone, plans are sold through the App Store.**

- `IOS_IN_APP_PURCHASE = true` in `mobile/src/plan-card.tsx`. When the server
  offers the App Store (`appleAvailable`: `BILLING_ENABLED` and
  `REVENUECAT_WEBHOOK_SECRET` set) and the build has the RevenueCat SDK and its
  key, the AI Plan card shows ADR 0231's picker, priced from StoreKit, with
  **Subscribe with the App Store**, **Restore purchases** and **Redeem a code**.
- **One seller per device.** The iPhone never shows Stripe's checkout, the promo
  field, or in-app Stripe actions (Cancel, Change plan, Update card).
- **A plan bought on the web is managed on the web.** A Stripe subscriber on an
  iPhone sees their plan and one **Manage billing ↗** link that opens their
  Stripe portal in Safari (an outside link beside In-App Purchase, which 3.1.1
  allows on the US storefront). An App Store plan shows **Manage in the App
  Store** (the device's Subscriptions page), as in ADR 0231.
- **Fallback.** If the build lacks the SDK or the server does not offer the App
  Store, the card falls back to ADR 0241's report-only card. That is only for old
  builds and half-configured servers; the build sent to review must sell.
- **Guideline 3.1.2 text** sits under the iPhone purchase buttons: charged to
  the Apple Account, renews automatically unless cancelled 24 hours before the
  period ends, managed in Apple Account settings, with links to the in-app Terms
  of Use (`/tos`) and Privacy Policy (`/privacy`).
- **Connect OpenRouter still opens Safari on a phone** (`BILLING_LINK_OUT`). It
  is OpenRouter's own sign-in and credit page, not a Chord sale.

**A permission explanation always continues to the system prompt.**

- The location card has one button, **Continue**, which shows the iOS location
  prompt; the person declines there. The Find friends contacts screen gets the
  same single **Continue** (its **Not now** had the same shape). Leaving either
  screen by navigation (another tab, the back button) is not a button on the
  message.
- Android's contacts explanation (ADR 0263) keeps **Not now**: Google Play asks
  for an explanation the person agrees to, which is the opposite rule, and it is
  never shown on iOS.

## Consequences

- Apple takes its commission (15% once enrolled in the Small Business Program, else 30% in year one) on plans
  bought on an iPhone. Prices stay the configured ones; the store shows its own
  localized price.
- Owner work before resubmitting, in `docs/ops/billing.md` → "Setting it up":
  Paid Applications agreement + banking + tax, five products in one subscription
  group (each with price, localisation and review screenshot), the In-App
  Purchase key in RevenueCat, the webhook secret on the server, App Store Server
  Notifications, `EXPO_PUBLIC_REVENUECAT_IOS_KEY` in `eas.json`, a native build,
  a sandbox purchase, and the subscriptions attached to the version being
  submitted. The location fix alone would ride an OTA update, but the review
  needs the new build anyway.
- The bot's `get_checkout_link` still returns a Stripe checkout link, also on an
  iPhone (it cannot tell which client reads it). A link to outside payment is
  allowed on the US storefront; outside the US it is a risk, noted not fixed.
- Someone who already pays on the web and then buys again on the iPhone is
  stopped by the card (it hides purchase buttons while a plan is active), not by
  the store; the server's one-live-subscription rule (ADR 0231) applies to the
  webhook.
- The ADR 0241 report-only card and `billingCardModel` stay: Android uses them,
  and so does an iPhone that cannot sell.

## Rejected

- **Arguing the reader-app exemption in a reply.** Apple's own message says the
  content must be available through In-App Purchase; an email client does not
  match the listed reader-app kinds.
- **Removing billing from the iPhone entirely.** A web subscriber signing in on
  the iPhone still "accesses content purchased outside the app", which is the
  case Apple named.
- **Selling through the App Store and Stripe side by side in the app.** Two
  sellers on one screen, and an in-app Stripe charge is exactly what 3.1.1 forbids.
- **Keeping Not now and adding an explanation for reviewers.** The rule is about
  the button, not the wording.
