# 0196 — Usage is the ledger

**Status**: accepted
**Date**: 2026-09-22

## Context

ADR 0193/0194/0195 built two numbers that looked related but weren't:
`token_usage` (ADR 0193) recorded real AI cost across every surface — bot
turns AND all three email AI passes (classify/magics/person-extraction) —
but gated nothing. `credit_balance`/`credit_ledger` (ADR 0063, tokens by
ADR 0194, subscriptions by ADR 0195) gated bot turns, but only ever tracked
bot-turn spend — the email passes checked `getEntitlement` as a binary
yes/no and, if entitled, ran **for free**, no debit at all. A user's
allowance could never actually reflect what Chord spent on them, because
half the spend was invisible to the thing enforcing the limit.

Owner call: unify onto one number. Unless BYOK, the *real* token count —
everything in `token_usage` — determines when to cut off, across every AI
surface, not just chat.

## Decision

**`token_usage` becomes the sole source of truth.** There is no more
separate debit step. "Remaining balance" is computed, not stored:
`MONTHLY_TOKEN_ALLOWANCE − SUM(token_usage.total_tokens WHERE user_id = ?
AND created_at >= subscription_period_started_at)`. Recording usage (which
every consuming call site already did, for ADR 0193's visibility counter)
*is* the debit now — there's nothing left to keep in sync with it.

**This deletes the separate ledger-write path entirely**, not just
simplifies it: `debitTokens`, `resetTokenAllowance`, `grantTokens`,
`getTokenBalance`, and `insertLedger` are removed from `billing.service.ts`.
`bot.service.ts` loses its post-turn debit call — `recordTokenUsage`
(already firing, unconditionally except BYOK) is now the only write a
completed turn makes. The `invoice.paid` webhook handler loses its
`resetTokenAllowance` call too: a subscription renewal's entire effect is
now updating `subscription_plan`/`subscription_period_started_at`/
`subscription_current_period_end` on the user row — the fresh allowance
falls out automatically the moment the period boundary advances, because
the SUM that determines "used" only ever looks at rows since that boundary.
No grant event to fire, no amount to get wrong, no idempotency to defend —
the period start IS the reset.

**Why this was safe to do in one pass**: every code path that gates on a
balance already went through `getEntitlement()` — `resolveTurnLlm`
(`llm/factory.ts`), the email `afterSync` gate (`gmail.service.ts`), and
the proactive-scan gate (`proactive.service.ts`) all read `ent.reason`/
`ent.balance`, none read `users.credit_balance` directly. Fixing
`getEntitlement`'s computation was the entire change; **this is also why
email passes are now correctly included in the cutoff with zero changes to
`gmail.service.ts`** — its existing `if (!ent.entitled) skip` gate was
always structurally correct, it was just being fed a number that ignored
half of what it was gating.

**A new `subscription_period_started_at` column** (migration `086`) is
what makes "since the period started" answerable — ADR 0195 only stored
`subscription_current_period_end`. Stripe's invoice line already carries
`period.start` alongside `period.end`; `parseInvoicePaid` now reads both.

**`credit_balance`/`credit_ledger` are now fully vestigial** — not renamed
(ADR 0194 already declined that), and now also never written. Existing
rows are historical record only. Left in the schema rather than dropped:
removing a column/table is a bigger, more disruptive migration than this
ADR's actual change, and nothing forces the decision now.

**The visibility counter (ADR 0193) and the gate are the same number for a
subscribed user, by construction — but not for everyone.** When
`entitlement.reason === 'tokens'` (an active system subscription),
`GET /me/billing` derives `tokensUsedThisMonth` as `MONTHLY_TOKEN_ALLOWANCE
− ent.balance` — one query, not two, and it can't drift from what actually
gates them. For everyone else (billing off, trial, no subscription) there's
no real allowance to derive from, so the route falls back to ADR 0193's
original `getTokenUsageThisMonth` (calendar month) against the display-only
`TOKEN_QUOTA_PER_MONTH` — unrelated to gating, exactly as before. The two
Settings cards stay visually separate (balance-remaining vs. used-of-total)
rather than merging into one — they're genuinely complementary reads of the
same fact, not redundant, and merging them was more UI risk than this ADR's
actual scope needed.

**Trial and BYOK are untouched.** Trial still outranks everything
(`getEntitlement`'s first real check after `billing_off`); a trial turn or
email pass still writes to `token_usage` for visibility (ADR 0193's
existing behavior) but the entitlement check never subtracts it from
anything, because there's no allowance concept during trial. BYOK still
records nothing to `token_usage` at all and never touches this balance —
its own (separate) base-plan subscription from ADR 0195 is unaffected by
this ADR.

## Alternatives considered

- **Dual-write: keep `credit_ledger` as a strict gate, `token_usage` as a
  loose mirror, written together** — rejected (owner call, see the
  question this ADR answers): keeps two numbers that are unified only by
  discipline at every call site, not by construction. The very bug this
  ADR fixes (email passes silently exempt from the gate) is exactly the
  failure mode "write to both, always" is one forgotten call site away
  from reintroducing.
- **Keep email passes unmetered, unify only the display side** — rejected
  (owner call): doesn't actually bound total AI spend, which was the
  problem statement.
- **Drop `credit_balance`/`credit_ledger` from the schema entirely** —
  rejected: no need forces it now, and removing a column touched by two
  prior ADRs is a bigger, separate decision.
- **A per-write idempotency key added to `token_usage` now that it gates
  real access** — considered and rejected: ADR 0193's "a duplicate row
  inflates a display number" reasoning generalizes fine to "a duplicate
  row costs someone a sliver of their allowance a little early" — still
  never a money-equivalent double-charge (nothing is charged twice; at
  worst access lapses a turn or two sooner than it should have), so the
  loose-idempotency trade-off this ADR inherits from ADR 0193 still holds.

## Consequences

- A prod incident that double-records one turn's usage now costs the user
  a small amount of their remaining allowance early, rather than nothing.
  Judged acceptable (see Alternatives) but worth knowing if it's ever
  reported as "my balance dropped further than expected."
- `MONTHLY_TOKEN_ALLOWANCE` is now a real, load-bearing gate for every AI
  surface at once, not just chat — a family that leans hard on email
  classification/magics could exhaust their period's allowance without a
  single chat turn. This is the intended behavior, but it's a sharper edge
  than before and worth watching once real subscribers exist.
- `debitTokens`/`resetTokenAllowance`/`grantTokens`/`getTokenBalance` are
  gone; any future admin/refund tooling needs a new mechanism (writing
  `token_usage` rows with a negative amount is the natural shape, but nothing
  here builds it — no stated need yet).

**Addendum 2026-09-22 — the bot answers the same question Settings does.**
Per CLAUDE.md's "every UI capability needs a bot-tool equivalent" rule, a
new read-only, personal-only `get_billing_status` tool lets the user ask
"do I have a subscription" / "how much AI have I used" in chat. It does
**not** call `getEntitlement` a second time and re-derive the numbers
itself — that would be exactly the two-computations-that-happen-to-agree
risk this ADR exists to close. Instead, the `BillingStatus`-assembly logic
that used to live inline in `GET /me/billing`'s route handler moved out
into a new `billing-status.service.ts` (`getBillingStatus(db, userId)`),
and both the route and the bot tool call that one function. It couldn't
live inside `billing.service.ts` itself: `llm/factory.ts` already imports
`getEntitlement` FROM `billing.service.ts`, and the assembler also needs
`resolveTurnLlm` FROM `llm/factory.ts` — putting it in `billing.service.ts`
would create the exact import cycle the server's layering rule forbids. The
new file sits above both, importing from each, so there is still exactly
one place that combines them. The tool's own description is explicit that
`entitlement` is the only source of truth per value (never infer a plan
from `balance` alone) — the `billing_off` case in particular needed calling
out, since it's the live state of the current deployment and the model
must not describe a free/team deploy as if a trial or paid plan exists.
