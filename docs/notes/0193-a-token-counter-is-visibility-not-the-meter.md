# 0193 — A token counter is visibility, not the meter

**Status**: accepted
**Date**: 2026-09-22

## Context

Owner asked for a per-user token-usage counter in Settings ("used / total"),
spanning every LLM-consuming surface — bot turns (chat, whatever the channel:
web, Telegram, WhatsApp), and the email AI passes (classify/magics/persons).
BYOK users don't need one: their key, their cost, not Chord's to track.

Checking what exists first: nothing does. `debitCredit` (ADR 0063) subtracts
one credit per turn and never looks at token counts. `pass-cost.ts` logs
`promptTokens`/`completionTokens` per email pass to Winston only — never
persisted, never queryable per-user. And bot turns have no token capture at
all: `LlmStreamOptions` already carries an `onUsage` callback (inherited from
`LlmCompleteOptions`), but **none of the three provider `stream()`
implementations ever call it** — only their `complete()` methods do, which is
why the email passes (which call `complete()`) can be logged and bot turns
(which call `stream()`) currently cannot.

The bigger fork: should this counter become the actual pricing/gating
mechanism (replacing the flat "1 credit = 1 turn" model), or stay a
visibility layer while credits keep gating access? Owner call: **visibility
only, for now** — the flat-credit gate in `getEntitlement`/`debitCredit`
(ADR 0063/0079) is unchanged by this ADR.

## Decision

**A new append-only `token_usage` table** (migration `084`): `id`,
`user_id`, `source` (`bot_turn` \| `email_classify` \| `email_magics` \|
`email_persons`), `ref`, `model`, `prompt_tokens`, `completion_tokens`,
`total_tokens`, `created_at`. Deliberately **not** shaped like
`credit_ledger` — no `balance_after`, no enforced-unique `ref`. This is a
display counter, not money: a duplicate row costs an inflated number by a
few hundred tokens, not a double charge, so the extra machinery
`credit_ledger` needs to stay idempotent isn't worth it here. Bot-turn rows
use the same `botMsgId` as `debitCredit`'s ref anyway (free from the
existing exactly-once turn machinery), so in practice bot-turn rows are
already naturally deduplicated; email-pass rows are pure inserts.

**"Total" is `TOKEN_QUOTA_PER_MONTH`** (new env var, a flat number) — not
derived from credits, not per-plan. It's a static display denominator until
real plan tiers exist. **"Used" is a period-scoped `SUM`** over the current
calendar month (UTC), computed on read — not a materialized running balance.
Rejected a `credit_ledger`-style `balance_after` column that resets monthly:
that needs a scheduled reset job, and "who resets it and when" is exactly
the bug class ADR 0092 (task archive) and ADR 0098 (briefing timing) already
had to fix twice each. At current row volume (low thousands per month, see
the Sep 2026 benchmark: ~4.7M tokens / 2,099 calls in 14 days across 6
users) a `SUM ... WHERE created_at >= period_start` is cheap and can never
drift from the truth.

**BYOK users get no rows at all.** `getEntitlement`'s existing `byok` check
gates recording, not just display — "doesn't matter to us" means don't
bother capturing it, not capture-but-hide. Settings shows "Using your own
key" instead of a used/total line, mirroring the AI Plan card's existing
`billing.tier === 'byok'` branch.

**Bot-turn capture needed new provider plumbing**, since it didn't exist:
- OpenAI: request `stream_options: { include_usage: true }` to get a
  usage-bearing final chunk.
- Gemini: after the stream drains, `generateContentStream`'s aggregated
  response exposes `usageMetadata` the same shape `complete()` already reads.
- Anthropic: SSE `message_start` carries input tokens, `message_delta`
  carries the final output token count — both need a case added to the
  `switch (event.type)` that previously ignored them.
- Mock provider: left untouched. Its `complete()` already never called
  `onUsage` (email passes have always shown 0 tokens under
  `LLM_PROVIDER=mock`), so making `stream()` fabricate numbers would make
  bot turns report usage mock never actually measured while email passes
  stayed silent — an inconsistency for no real gain. `LLM_PROVIDER=mock`
  dev/demo runs show 0 tokens everywhere, same as today.

`bot.service.ts` wires `onUsage` into both `llm.stream(...)` call sites
(`runNativeLoop` and `runTextFenceTurn`) and records the row right beside
the existing `debitCredit` call — same `botMsgId`, same guard shape, but
**unconditional on `BILLING_ENABLED`** (a team/dev deploy still wants to see
its own usage) and skipped only on BYOK.

**Email passes**: `pass-cost.ts`'s `report()` becomes `async` and, when its
`PassCost` carries both `userId` and `db`, writes the row after logging
(the Winston line is unchanged — this is additive, not a replacement).
`llm-classifier.ts` already had `userId` in scope and threads it straight
through. `magics.service.ts` and `person-extraction.ts` did not: their
`trackPassCost()` calls live inside the injectable `EmailExtractor`/
`PersonExtractor` seams, whose input types (`MagicThreadInput`/
`PersonThreadInput`) deliberately omitted `userId` to avoid churning every
test double (`pass-cost.ts`'s own doc comment says so). Fixed by adding
`userId` as an **optional** field to both input types, populated only by
the real callers (`extractAndStage`, `runPersonExtraction`, both of which
already have it in scope) — existing test doubles that don't set it keep
compiling unchanged, and `report()` simply skips the DB write when it's
absent (same as today's `userId?: string` already documents for the
Winston-only log line).

**Surfaced via the existing `GET /me/billing`**, not a new route —
`BillingStatus` gains `tokensUsedThisMonth`/`tokensQuotaPerMonth` (both
omitted when `tier === 'byok'`). The mobile AI Plan card (`settings.tsx`)
gets one more `systemRow` line beside the existing credit balance, using
the same `billing.tier === 'byok'` branch the card already has for "Using
your own key".

## Alternatives considered

- **Replace credits with token-metered billing now** — rejected (owner
  call): reshapes `debitCredit`/`getEntitlement`/the Stripe bundle math/the
  trial model for a feature that only needs visibility today. Revisit once
  real usage data (which this ADR now makes possible to collect) justifies
  the bigger change.
- **A `credit_ledger`-shaped running balance that resets monthly** —
  rejected: reintroduces a reset-job correctness problem this codebase has
  already paid down twice elsewhere (ADR 0092, ADR 0098), to save one cheap
  `SUM` query.
- **Required `userId` on `MagicThreadInput`/`PersonThreadInput`** —
  rejected: breaks the documented reason those seams stayed userId-free
  (test-stub stability). Optional achieves the same capture with zero
  forced churn.
- **A sink-injection hook in `pass-cost.ts`** (mirroring `setMailboxSyncRunner`,
  ADR 0118) instead of threading `db`/`userId` through `PassCost` directly —
  considered, rejected as one more indirection layer for a case where the
  caller already has both values in hand; the injection pattern earns its
  keep when the producer genuinely can't know its consumer (mail sync
  runner, IMAP IDLE), not here.

## Consequences

- Provider `stream()` methods do slightly more per-chunk bookkeeping
  (accumulating token deltas) than before — new code path in all three real
  providers plus mock, worth a close look in review since none of them had
  ever exercised this before.
- The quota shown is one static number for every user until real plan tiers
  exist — not per-plan, not enforced.
- No historical backfill: usage before this ships is invisible, the same
  posture ADR 0143/ADR 0167 already took for other never-retroactively-fixed
  gaps. The Sep 2026 email-pass benchmark (pulled from Winston logs, not
  this table) is the only pre-existing data point and won't appear in the UI.
- If BYOK usage estimates are wanted later (e.g. "here's roughly what this
  would have cost on our key"), this ADR's "skip entirely" choice means
  starting that from scratch rather than un-hiding stored rows.
