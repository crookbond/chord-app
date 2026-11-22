# 0044 — BYOK key failure handling + future metered billing

**Status**: accepted — BYOK failure handling shipped; metered billing is
future (documented here, not built).
**Date**: 2026-06-04
**Related**: PR-D.1 per-user model key (`users.model_*` columns,
`getLlmForUser` in `llm/factory.ts`), [ADR 0005 — iterative tool use](./0005-iterative-tool-use.md),
[`docs/ops/byok-providers.md`](../ops/byok-providers.md) (per-provider setup examples)

## Context

Every bot turn costs LLM inference money. There are two ways that cost
gets paid:

1. **BYOK** — the user supplies their own provider key
   (OpenAI / Anthropic / Gemini). The key is stored encrypted on the user
   row (`model_key_ciphertext`/`iv`/`tag`) and `getLlmForUser` builds a
   per-turn provider from it, falling back to the deploy-wide system key
   only when the user has *no* key (or it fails to decrypt).
2. **System key** — the deploy-wide key from `.env`. Used today for users
   who haven't brought their own. Its cost lands on us.

BYOK is built. The open question this ADR settles: **what happens when a
user *has* a BYOK key and it stops working mid-turn** — the key is revoked
(401), or the provider account runs out of credit (429
`insufficient_quota` on OpenAI, a 400 "credit balance is too low" on
Anthropic, 429 `RESOURCE_EXHAUSTED` on Gemini)?

Before this ADR the failure was swallowed by the generic catch in
`bot.service.ts` and the user saw "Service is temporarily unavailable —
please try again in a moment." — which is wrong twice over: it implies
*our* outage, and it gives the user no way to fix the actual problem
(their key).

## Decision

### 1. No silent fallback to the system key

A dead or exhausted BYOK key does **not** fall back to the deploy-wide
system key. The whole point of BYOK is to put inference cost on the user;
silently absorbing it the moment their key fails inverts that — a user
could paste a junk key (or let credits lapse) and get unlimited free
system inference. The resolution-time fallback in `getLlmForUser` (no key
stored / decrypt failure) stays; there is no *runtime* fallback.

### 2. Tell the user, specifically and actionably

When a turn fails and the user is on a BYOK key, classify the error and
surface a message the user can act on:

- **auth (401/403)** — "Your <provider> key was rejected. Update it in
  Settings → AI model."
- **credit (out of funds)** — "Your <provider> key is out of credits. Top
  up at <provider billing link>, or paste a different key in Settings → AI
  model."
- **transient (rate-limit 429, 5xx, network)** — keep the generic
  "temporarily unavailable, try again" message; the key is fine.

The classifier lives in `llm/errors.ts` (`classifyLlmError` +
`byokFailureMessage`) so the same logic serves both the runtime path and
validate-on-save (below). System-key failures keep the generic message —
we never tell a non-BYOK user to "fix their key."

### 3. Validate the key on save

`PUT /me/model-key` makes a minimal real call with the supplied key+model
*before* storing it, and rejects (400, classified message) if the key is
invalid, the model name is wrong, or the account has no credit. This moves
discovery of a bad key from mid-conversation to configuration time, where
the user is already looking at the input field. Cost is one tiny call per
save.

## Future: metered billing on the system key (documented, not built)

The end state is that **Chord is paid**. BYOK is the bootstrap; it is not
the only way we expect cost to be covered. The planned model:

- A user with no key (or who'd rather not manage one) can use the **system
  key on a paid plan** — prepaid credits / top-up, or a subscription.
- When a BYOK key hits credit-exhaustion, the failure message becomes a
  fork: "top up your provider key" **or** "switch to a Chord plan and let
  us run it." The point of sale is exactly the moment the user feels the
  pain.

Components this needs (none built yet):

- **Usage metering** — tokens/turns per user, written to a ledger.
- **Credit ledger + balance** — debit per turn; block at zero.
- **Purchase** — App Store IAP on iOS (see the TestFlight/native-iOS
  direction) and/or Stripe on web.
- **Quota enforcement** in the turn path — check balance before spending
  the system key; this is where decision 1's "no free fallback" relaxes
  into "fall back to *paid* system inference when the user has credit."

Until that lands, the system key remains a cost we bear for non-BYOK
users, and BYOK is how a cost-conscious deploy keeps that bounded.

## Alternatives considered

- **Silent fallback to the system key on BYOK failure.** Rejected:
  abuse/cost (see decision 1). Convenience for the user, but it quietly
  hands them our bill and removes any signal that their key is broken.
- **Keep the generic "temporarily unavailable" message.** Rejected: the
  user can't tell it's their key and can't self-serve a fix; they file a
  "the bot is broken" complaint instead of topping up.
- **No validate-on-save; surface problems only at first real turn.**
  Rejected: a bad key then fails in front of the whole group instead of
  privately in settings, and the user has lost the context of "I just
  typed this key."

## Consequences

- A dead/exhausted BYOK key produces a private, actionable message; the
  bot does not spend system credits to cover it.
- Two code paths share one error classifier (`llm/errors.ts`): the runtime
  catch in `bot.service.ts` and `PUT /me/model-key` validation.
- `PUT /me/model-key` now does network I/O and can return 400 with a
  provider-derived message; the mobile settings screen already surfaces
  the server error string.
- The future billing work has a documented home; the "no fallback" rule is
  explicitly the thing that relaxes once a credit ledger exists.
