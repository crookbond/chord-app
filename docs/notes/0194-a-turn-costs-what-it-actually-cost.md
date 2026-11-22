# 0194 — A turn costs what it actually cost

**Status**: accepted
**Date**: 2026-09-22

## Context

ADR 0193 gave Chord real per-turn token data for the first time. Looking at
it surfaced the disconnect it was built on top of: `debitCredit` (ADR 0063)
has always subtracted a flat **1 credit per turn**, regardless of how many
tokens that turn actually spent. A three-word reply and a 20-iteration
tool-use loop that read someone's whole mailbox context cost the same 1
credit. Meanwhile the new `token_usage` table means real tokens. Two places
in the same billing story, two different units — owner call: **stop that**,
make every count mean actual AI tokens, never a turn-count abstraction.

## Decision

**The debit is now the turn's real token count**, read off the same
`result.tokenUsage` ADR 0193 already computes in `bot.service.ts` — no new
provider plumbing needed, this was sitting there unused for billing. When
`tokenUsage` is `null` (mock provider, or a stream that threw before
reporting), **the debit is skipped entirely** — a turn Chord can't measure
costs the user nothing, the same "unmeasured ≠ free-and-unknown-conflated"
posture `pass-cost.ts` already takes for its Winston logging, extended to
mean "and therefore don't charge for it" now that this number is money.

**"Credits" is retired as a concept.** The balance is a token count,
everywhere a person or a config file reads it: Settings shows "Balance:
1.2M tokens," `TOKENS_PER_BUNDLE` (was `CREDITS_PER_BUNDLE`) is a real token
grant, `Entitlement.reason`'s `'credits'` value is now `'tokens'`. Renamed
at the **API and code level** — `debitCredit`→`debitTokens`,
`grantCredits`→`grantTokens`, `getCreditBalance`→`getTokenBalance` — all
mechanical TS renames caught by the compiler if a call site is missed.

**The physical schema keeps `credit_balance`/`credit_ledger` as-is.** No
migration renames the column or table. Two reasons, both load-bearing:
every migration in this codebase to date is additive
(`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) — nothing here
has ever renamed a column or table, and Postgres's `RENAME COLUMN`/
`RENAME TO` have no `IF EXISTS`-style idempotency guard, so doing it would
mean this codebase's first non-idempotent migration, re-runnable only
behind a hand-rolled `information_schema` check. And there's a direct
precedent already in this repo for exactly this trade: ADR 0070 renamed
"Catchup" to "To Do's" as a **label only** — "route stays `/catchup/*` so
ADR 0059 hrefs survive." Same shape here: rename what people read
(function names, API fields, UI copy, the env var), leave the column a
legacy internal name nobody outside `billing.service.ts` ever sees directly.

**Why not touch `TOKEN_QUOTA_PER_MONTH` (ADR 0193)?** It stays exactly as
it was — a flat, same-for-everyone display denominator for "how much did I
use this period," independent of billing state and shown even on
`BILLING_ENABLED=false` deploys with no balance concept at all. The
`token_ledger`'s balance (still physically `credit_ledger`) is a different
number: a real prepaid amount that varies per user by what they bought.
Both are tokens now, but they answer different questions and both stay.

**Idempotency is unchanged and still correct.** `debitTokens` keeps
`botMsgId` as its `ref` — exactly-once per turn was never about the amount,
it was about a retried debit not re-firing, and that guard doesn't care
whether the delta is `-1` or `-4200`.

**No balance migration.** `BILLING_ENABLED=false` everywhere today and no
real Stripe purchase has ever completed (confirmed with the owner before
touching this) — any `credit_balance` row that exists is dev/test data, so
reinterpreting its number as tokens-instead-of-turns costs nothing real.

## Alternatives considered

- **Keep "credits" as a label, backed by a fixed tokens-per-credit rate**
  (e.g. 1 credit = 1,000 tokens) — rejected (owner call): adds a conversion
  constant that has to stay consistent everywhere a number is shown, for a
  layer of indirection nobody asked for once the underlying unit is already
  tokens.
- **Debit a worst-case estimate (`MAX_TURN_TOKENS`) when usage is unknown**
  — rejected (owner call): never under-charges for real spend, but an
  estimate presented as a real number is a confabulation in the ADR 0102
  sense, and would drain a real balance for mock/dev turns that cost
  nothing.
- **Rename the physical column/table too** (`token_balance`/`token_ledger`,
  via a hand-rolled idempotent `information_schema`-guarded migration) —
  rejected: real migration risk (this codebase's first non-additive one)
  for a rename nothing outside `billing.service.ts` ever reads directly.
  ADR 0070 already decided this trade the other way for a bigger,
  more user-visible rename.
- **Merge `token_usage` (ADR 0193) and the billing ledger into one table**
  now that both mean tokens — rejected: they have genuinely different
  idempotency needs. `token_usage` is deliberately loose (no unique `ref`,
  a duplicate row just inflates a display number) because it was never
  billing-critical; the ledger needs the opposite guarantee now that its
  delta is real money-equivalent. Collapsing them would either weaken the
  ledger's guarantee or add idempotency machinery `token_usage` was
  explicitly built to avoid.

## Consequences

- A user's balance now drains at whatever rate their actual usage costs —
  a long tool-heavy turn spends more of it than a short one. This is
  arguably fairer than the flat rate, but it also means the same balance
  buys a variable, less predictable number of turns; Settings shows "1.2M
  tokens" rather than "500 credits," which is a legibility trade the owner
  accepted deliberately.
- `TOKENS_PER_BUNDLE`'s default needed picking from scratch — there was no
  real-usage number to derive a "correct" bundle size from before ADR 0193
  existed. Set to a round placeholder pending an actual pricing decision,
  the same posture `TOKEN_QUOTA_PER_MONTH` already took.
- Reading `credit_balance`/`credit_ledger` directly in a new piece of code
  (bypassing `billing.service.ts`) now reads confusingly against what the
  number means. Anyone touching billing internals needs this ADR, not just
  the column name, to understand the unit.
