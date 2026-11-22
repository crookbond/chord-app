# 0063 — Prepaid credits + tier-based model routing

**Status**: accepted — credit ledger + routing + per-turn debit shipped; Stripe purchase wiring is a follow-up slice
**Date**: 2026-07
**Implements**: the deferred billing in [ADR 0044 — BYOK failure + future metered billing](./0044-byok-failure-and-future-billing.md)
**Relates to**: [ADR 0007 — triggering user identity](./0007-user-identity-in-turn.md), [ADR 0005 — iterative tool use](./0005-iterative-tool-use.md)
**Workstream**: Friends & Family release plan — J

## Context

ADR 0044 shipped BYOK and documented — but did not build — metered billing on
the system key. Before opening Chord to non-team users, we must not hand
strangers an open tab on our premium LLM key. But a hard paywall is the wrong
shape for a family app: rather than block at zero, a free / out-of-credit user
should **degrade gracefully to a cheap open-source model**, and the premium
model is what credits buy.

## Decision

### Three tiers, chosen per *triggering user* (ADR 0007)

| Tier | Model | Credits |
|---|---|---|
| **BYOK** | the user's own provider/model | free, never debited |
| **Premium** (credits > 0) | the system premium model | debit 1 credit/turn |
| **OSS** (free, or paid-out) | a cheap OpenAI-compatible model on our key | no debit |

`resolveTurnLlm(db, userId)` (`llm/factory.ts`) returns `{ llm, tier }`:
BYOK if the user has a stored key; else — only when `BILLING_ENABLED` — premium
when `credit_balance > 0`, otherwise the OSS model. **Out-of-credits is never
blocked**; the turn runs on OSS and the bot can note "you're on the free model —
buy credits or add your own key for the premium model."

The turn path (`bot.service.ts`) swaps `getLlmForUser` → `resolveTurnLlm` and,
after a **successful** turn, debits 1 credit iff `tier === 'premium'` — keyed on
the bot message id so the imperative-retry can't double-charge. `getLlmForUser`
stays (BYOK-or-system) for non-turn callers (the executor).

### Billing off by default

`BILLING_ENABLED=false` (the team MVP / dev default) makes the whole thing
inert: non-BYOK users resolve to `premium` and the turn path never debits —
identical to pre-ADR behavior. Flipping it on activates the credit gate + OSS
fallback with no code change.

### Credit ledger

`users.credit_balance` (int, fast gate) kept in lockstep with an append-only
`credit_ledger` (`delta`, `reason` purchase|turn_debit|grant|refund, unique
`ref`, `balance_after`) — migration `021`. Every movement goes through
`billing.service.ts` (`debitCredit` / `grantCredits`) in one transaction;
the unique `ref` (Stripe session id, or bot message id for a turn) makes both
idempotent. `credit_ledger.user_id` is `ON DELETE CASCADE`, so account deletion
(ADR 0043) sweeps it automatically.

### OSS provider = config, not a new class

The factory already supports an OpenAI-compatible `baseURL`. The free tier is a
dedicated env profile — `OSS_BASE_URL` / `OSS_MODEL` / `OSS_API_KEY` (Groq /
DeepInfra / OpenRouter / Ollama / vLLM) — that `getOssLlm()` builds and caches.
Unconfigured → `getOssLlm()` returns null and `resolveTurnLlm` falls back to the
premium model (we bear the cost) rather than stranding a free user.

### Status endpoint

`GET /me/billing` → `{ balance, tier, model, billingEnabled }` for the settings
UI (kernel `BillingStatus`). The mobile billing card + Stripe web checkout
(`/me/billing/checkout` + the `checkout.session.completed` webhook crediting the
bundle via `grantCredits`) are the next slice — deferred here because they need
Stripe keys to build and verify.

## Consequences

- Model choice is now per-turn and per-user. A BYOK user is unaffected; a
  paid user spends 1 credit/premium turn; a free user rides OSS.
- The "no free fallback on BYOK failure" rule (ADR 0044 §1) is unchanged — a
  *dead* BYOK key still surfaces an actionable error; it does not silently fall
  to premium/OSS. Tier selection here is about users **without** a key.
- Two seams remain for the Stripe slice: `grantCredits` (credit a purchase) and
  the billing card UI. Until then, credits can only be added by an admin/promo
  `grantCredits` call, and `BILLING_ENABLED` stays off in production.
- Debit is best-effort (logged on failure) so a ledger hiccup never fails a
  turn the user already saw answered.

## Alternatives considered

- **Hard block at zero credits.** Rejected — a family assistant going mute
  mid-conversation is a terrible failure mode; graceful OSS degradation keeps it
  useful and makes the upsell contextual, not coercive.
- **Debit per token, not per turn.** Rejected for v1 — per-turn is legible to
  users ("≈N messages for $9.99") and simple to reason about; a `usage_log` for
  token analytics can come later without changing the gate.
- **In-app purchase now.** Deferred — Stripe web checkout avoids the store cut
  for TestFlight/F&F; the public-App-Store IAP question is noted in the release
  plan, not solved here.
