# 0079 — 30-day trial, then the AI surface gates

**Status**: accepted; the 30-day trial is superseded by ADR 0325 (a one-time 10M-token free allowance), the gate stays
**Date**: 2026-07-19

## Context

ADR 0063 shipped "never hard-blocked" billing: out-of-credit users degraded
gracefully to a cheap OSS model, and the ambient AI layer (email passes,
briefings, extraction) never metered at all. Working the unit economics
(2026-07-19) showed the flaw: the ambient layer is the *majority* of token
spend and it ran free forever — a heavy inbox costs real money on the
system key with zero revenue attached, while interactive turns (the only
debit point) are the minority of cost.

Owner decision: **first 30 days everything free; after that the whole AI
surface — chats, email insights, proactive briefings — gates on payment.**
The trial doubles as marketing: the ambient magic is fully on while it
matters most.

## Decision

### Entitlement (`getEntitlement`, billing.service)

A user is entitled to AI features when ANY of:
- the deploy has `BILLING_ENABLED=false` (team/dev — behavior unchanged);
- they are within `TRIAL_DAYS` (env, default 30) of `users.created_at`;
- they hold prepaid credits;
- they brought their own model key (their key, their cost — always free).

Precedence: BYOK → **trial → credits** — trial outranks credits so a bundle
bought early isn't consumed until the window closes. Trial turns run the
**premium** model, free and undebited (`resolveTurnLlm` + the turn-debit
condition both check the trial).

### The gates (all no-ops while `BILLING_ENABLED=false`)

1. **Bot turns** (`runBotTurn`): an unentitled user's turn does not reach
   the LLM; a short bot message points at Settings → AI Plan (buy credits
   or add a key).
2. **Email AI passes** (`afterSync`): classification, magics, invite
   parsing, person extraction, and attachment import all skip. The
   **mirror/reader keeps working** — it's the user's own mail; the AI layer
   is what's paid.
3. **Proactive** (drain loop): `email_digest` and `event_created_nudge`
   retire un-rendered for an unentitled persona. The **daily briefing keeps
   arriving as a deterministic teaser** (owner decision — the retention
   touchpoint): a few real lines (today's event count + first event,
   pending-suggestion count, unread count) and a "Read more… restart in
   Settings → AI Plan" hook, built with zero LLM calls
   (`buildGatedBriefingTeaser`). The scan self-reseeds as normal, so the
   FULL briefing resumes the morning after payment. `task_remind` stays:
   deterministic, tiny, and explicitly requested by the user.

### Surface

`BillingStatus` gains `entitlement` + `trialEndsAt`; the AI Plan card shows
"Free trial · N days left" → "Trial ended — buy credits to keep Chord
going", with the existing Buy-credits button (ADR 0075).

## Supersedes / interacts

- Supersedes ADR 0063's "never hard-blocked" posture **post-trial**. The
  OSS tier remains in the factory (it now mostly informs the billing
  display; a future utility-lane routing for ambient passes can reuse it).
- ADR 0075's checkout is the sole self-serve exit from the gate.

## Consequences

- Existing users at rollout: entitlement counts from `created_at`, so
  accounts older than 30 days gate immediately when `BILLING_ENABLED`
  flips on — grant promo credits (`grantCredits(…, 'grant', ref)`) to
  cohorts that should glide.
- BYOK exempts chats but the ambient passes still run on the system key
  for BYOK users; acceptable at F&F scale, revisit with the utility-lane
  routing.
- The gate nudge is plain text; a tappable deep-link card is polish for
  later.

Tests: `trial-gate.integration.test.ts` — entitlement matrix (incl. trial
outranking credits and billing-off passthrough), gated turn posts the
nudge and never reaches the LLM, trial turns undebited vs post-trial
debits, afterSync skips while the mirror still syncs, gated daily scan
retires silently but reseeds tomorrow.
