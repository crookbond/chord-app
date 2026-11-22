# 0236 — Cancel is one click, and it ends at the period

**Status**: accepted
**Date**: 2026-10-09

## Context

The only way to stop a subscription was "Manage subscription": open Stripe's
hosted portal, find the cancel control, confirm there, then follow a "return to
Chord" link. The owner's first real test purchase made the gap plain — to buy
again they had to cancel, and cancelling meant leaving the app and finding
their way back. (The portal's return URL was already set correctly; the
problem is that cancelling is a workflow on someone else's page.)

Two other facts shaped the answer:

- Access is already period-based (ADR 0195/0196): `getEntitlement` checks the
  paid period, and a subscription that stops producing `invoice.paid` simply
  lapses when the period ends. So "cancel" needs no entitlement change and no
  webhook handler at all.
- Stripe can end a subscription two ways: `cancel_at_period_end` (keeps
  working until the paid period ends) or an immediate delete. The user has
  already paid for the period.

## Decision

**Cancel stops the next renewal, never the current period, and it happens
inside the app.**

- `POST /me/billing/renewal { renew: boolean }` sets Stripe's
  `cancel_at_period_end`. `renew: false` is "Cancel plan", `renew: true` is
  "Resume plan". Both are reversible until the period ends, which is also why
  cancelling takes one confirmation and no refund logic.
- One function (`setRenewal`, `subscription-renewal.service.ts`) serves the
  route and the `set_subscription_renewal` bot tool, so the two surfaces cannot
  disagree about who may cancel and what happened (ADR 0196/0231's reasoning).
  The tool is personal-chat only and commits directly: unlike sending mail
  (ADR 0214) it is cheap to undo — "resume" — so a tap-to-confirm card would be
  friction without a safety gain. Its description forbids claiming success
  unless `ok` is true and requires stating the end date.
- **State is read live, not stored.** `BillingStatus.cancelsAtPeriodEnd` comes
  from a best-effort `GET /subscriptions/:id` (3s timeout, 20s cache, dropped on
  our own write), only for Stripe-sold plans. A column would go stale whenever
  someone cancels in the portal, because Chord has no
  `customer.subscription.updated` handler; adding one means editing the
  webhook destination's event list, a second moving part for one boolean.
  Unknown (Stripe unreachable) is omitted, and the card then falls back to the
  old "Renews or ends" wording rather than guessing.
- **Only the payer cancels, and only what Chord sold on Stripe.** An App Store
  subscription answers `apple` (409) and the card keeps its "Manage in the App
  Store" route; a family member has no plan of their own (`no_subscription`),
  so the owner cancels for everyone. The portal stays, relabelled "Change plan
  or card".
- **A cancelled checkout is a quiet return.** Stripe's back link sends
  `?checkout=cancel`; the settings screen strips the parameter the same safe
  way as `success` (a `router.replace` on a cold page load throws before the root
  navigator is ready, which is what blanked the success return) and does
  nothing else.

## Consequences

- Cancelling does not lower the allowance or the visible plan until the period
  ends; the card says "Cancelled - your plan works until <date>" with a Resume
  button, so the state is never ambiguous.
- Someone who cancels in Stripe's portal sees the same state on the next
  billing read, with no webhook involved — at the cost of one Stripe request
  per billing-status read for Stripe-sold plans (cached 20s).
- Resubscribing after the period lapses uses the existing checkout path.
  Resuming before then needs no checkout at all.
- Unverified against live Stripe: the update call is the documented
  `POST /v1/subscriptions/:id`, covered here by a stubbed Stripe, not a real
  cancel in the sandbox.

## Rejected

- **Deep-linking the portal's cancel flow** (`flow_data[type]=subscription_cancel`
  with an `after_completion` redirect). It fixes the return trip but keeps the
  user on Stripe's page for the decision, which is the thing being complained
  about.
- **Cancelling immediately.** The period is paid for; ending it early takes
  something away and invites a refund question.
- **A stored `cancel_at_period_end` column plus a `customer.subscription.*`
  handler.** More moving parts, and stale until the dashboard's event list is
  edited to match.
- **Making the bot tool propose-then-confirm.** Considered, and right for mail
  that leaves the building; wrong for a reversible renewal flag.

## Addendum — changing plan is in the app too

The first version left "Change plan or card" pointing at Stripe's portal, so
after cancelling, the other plans were again a trip away from the app. The card
now has **Change plan**, which opens the other options in place (the current
plan and interval are marked and cannot be picked) and **Update payment card**
as a small link to the portal, the one thing the portal is still for.

- `POST /me/billing/plan { plan, interval }` swaps the price on the
  subscription's existing item (`changePlan`, one function for the route and
  the bot tool). It is never a second subscription, so nothing bills twice.
- **The difference is invoiced now** (`proration_behavior: always_invoice`) and
  `payment_behavior: error_if_incomplete` makes a declined card an error
  rather than a half-applied change (`payment_failed`, 402). Invoicing now is
  what makes the plan change when the button is pressed instead of at the next
  renewal; the paid invoice reaches the existing `invoice.paid` handler, which
  already prefers the subscription line over proration lines (ADR 0231
  addendum).
- It also sets `cancel_at_period_end: false`, so choosing another plan from a
  cancelled state resumes it. The same plan and interval is `same_plan`, except
  when the subscription is set to cancel, where it IS resume - so a double tap
  never charges.
- Stripe-sold, own, non-BYOK plans only: App Store plans answer `apple`, family
  members and no-plan users `no_subscription`.
- **Chat**: `change_subscription_plan` is in `PROPOSABLE_TOOLS` - unlike
  cancel/resume it moves money immediately, so the model stages a card and the
  user taps. Its card says "charges or credits the difference now".
- Leaving a family plan with people on it warns in the confirmation that they
  stop being covered; the server does not refuse (the portal never did).

Rejected: sending the user to the portal's plan switch (the complaint);
`create_prorations` (the plan would not change until the next renewal);
a new subscription plus cancelling the old one (two bills and a gap).

## Addendum 2 — a switch must not be undone by its own invoice

First real use: "switch plan" reliably did not switch, or took a long time to
show. Two causes, both in how the result came back:

1. **The paid-invoice webhook resolved the plan being left.** A switch to a
   price of the *same* interval, inside the paid period, produces an invoice
   with no full-price line at all: Stripe invoices a credit for the old price's
   unused time and a charge for the new price's remaining time, both
   prorations. `parseInvoicePaid` took "the first non-proration line, else the
   first line"; the credit is listed first, so the old price was read, the plan
   was written back to what it was, and the switch was undone. An interval
   change (monthly to annual) has a regular new-price line, which is why that
   one sometimes worked. Now a proration-only invoice takes the **positive**
   line (the charge for the new price; the last line when nothing is positive,
   a fully discounted price) and reports `prorationOnly`.
2. **The window moved.** That credit line's period starts at the moment of the
   switch, and the handler wrote it as `subscription_period_started_at`, which
   is what ADR 0196 sums usage from — so every switch would have granted a
   fresh allowance. A proration-only invoice now sets the plan and the period
   end and leaves the window start alone.

And the screen waited on the webhook for its answer. `changePlan` now writes the
new plan and interval as soon as Stripe accepts the change (it has already
charged: `error_if_incomplete`), the card re-reads once immediately and shows
"Switched to …", and a second read a few seconds later picks up whatever period
dates the invoice set. The webhook still runs and writes the same plan.

The existing test passed because it always included a regular price line — the
portal's shape was assumed, never a switch's. The tests now carry the real
shape in both line orders.
