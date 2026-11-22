# 0075 — Stripe checkout without the SDK

**Status**: accepted
**Date**: 2026-07-18

## Context

ADR 0063 shipped the credit ledger, per-turn debit, and three-tier model
routing, deliberately leaving the purchase slice for later: `grantCredits`
(transactional, idempotent by a unique ledger `ref`) was built as the seam.
This ADR completes it — the F&F release blocker (Workstream J1). Payment is
Stripe **web checkout** (no in-app purchase button) per the F&F plan's
anti-store-cut decision.

## Decision

### No `stripe` SDK

Two operations are needed, and both are small:

- **Create a Checkout Session** — one form-encoded POST to
  `api.stripe.com/v1/checkout/sessions` (raw `fetch`, injectable for tests).
- **Verify webhook signatures** — HMAC-SHA256 over `${t}.${rawBody}` with
  the `v1=` scheme: structurally the same as the Slack verify the codebase
  already carries (`slack.connector.ts`), with a 300 s replay window and
  `timingSafeEqual`, accepting any of multiple `v1` values (secret rolls).

All Stripe knowledge lives in `services/stripe.service.ts` (~150 lines), so
the SDK can replace it later without touching routes. What we give up —
`constructEvent`'s battle-testing — is mitigated by verifying before
parsing and by narrowing to the single event type we act on. Every test
runs keyless (`signStripePayload` computes valid signatures locally).

### Flow

- `POST /api/v1/me/billing/checkout` (session-gated): 503 unless
  `BILLING_ENABLED` **and** `STRIPE_SECRET_KEY`+`STRIPE_PRICE_ID` are set;
  else creates the session (`client_reference_id` = Chord user id,
  `mode=payment`, one `STRIPE_PRICE_ID` line item) and returns the hosted
  URL. The mobile billing card opens it via `WebBrowser.openBrowserAsync`
  and refetches the balance when the browser closes.
- `POST /api/v1/webhooks/stripe`: 404 until `STRIPE_WEBHOOK_SECRET` is set;
  verifies the signature against `req.rawBody` (captured globally in
  app.ts); on `checkout.session.completed` with `payment_status === 'paid'`
  → `grantCredits(userId, CREDITS_PER_BUNDLE, 'purchase', session.id)`.
  Duplicate deliveries/retries can never double-credit (unique `ref`).
  **Registered before the `/:platform` catch-all**, which 404s unknown
  platforms — ordering is load-bearing and tested.
- Unknown event types, unpaid sessions, unknown users → **200** (never make
  Stripe retry an unprocessable event); 500 only on transient DB errors,
  where a retry is wanted and idempotency absorbs it.
- `GET /me/billing` gained `checkoutAvailable` so the client can hide the
  buy button on deploys without keys.
- Success/cancel land on `${WEB_ORIGIN}/settings?checkout=success|cancel`;
  `WEB_ORIGIN` (new env) falls back to `SIGNUP_URL`'s origin.

### Deliberately out of v1

- **Async payment methods** — the price must stay card-only; a session can
  otherwise complete `unpaid` and fire `async_payment_succeeded` later,
  which we don't handle.
- **Refund webhooks** — a refund is a manual ledger `grant` with negative
  intent today; automate when volume justifies it.
- **In-app purchase** — the anti-steering caveat from the F&F plan stands:
  before a public App Store release this moves to IAP or Apple's
  external-purchase entitlement.

## Verification

`stripe.service.test.ts` (signature + parse + request shape, keyless),
`stripe-webhook.integration.test.ts` (grant-once + replay, 401/404 paths,
no-op paths, checkout 503/401). Manual test-mode smoke: `stripe listen
--forward-to localhost:4000/api/v1/webhooks/stripe`, buy with card
4242 4242 4242 4242, watch the balance move once.
