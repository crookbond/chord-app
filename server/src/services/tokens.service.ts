/**
 * ADR 0193/0196 — per-user token usage. Append-only `token_usage`.
 *
 * As of ADR 0196 this table is no longer *just* visibility — for a user on
 * the system-key subscription it's the billing ledger too:
 * `getEntitlement` (`billing.service.ts`) computes "remaining balance" as
 * `MONTHLY_TOKEN_ALLOWANCE − getTokenUsageSince(periodStart)`, so recording
 * usage here (which every consuming call site already did) IS the debit.
 * There's no separate strict ledger any more — a duplicate row costs a
 * sliver of someone's allowance a little early, never a double charge, so
 * the loose idempotency ADR 0193 chose (no unique `ref`) still holds.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../config/env.js';
import type { DB, TokenUsageTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';

export interface TokenUsageEntry {
  userId: string;
  source: TokenUsageTable['source'];
  ref: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** ADR 0332 — prompt tokens read from the provider's cache (part of promptTokens). */
  cachedTokens?: number;
  /** ADR 0332 — dollars the provider billed for the call, when it says (OpenRouter). */
  costUsd?: number;
}

/** Best-effort: a failed write here must never break the turn/pass it's
 *  attached to, so callers wrap this in their own try/catch and log a warn. */
export async function recordTokenUsage(db: Kysely<DB>, e: TokenUsageEntry): Promise<void> {
  await db
    .insertInto('token_usage')
    .values({
      id: newId('tok'),
      user_id: e.userId,
      source: e.source,
      ref: e.ref,
      model: e.model,
      prompt_tokens: e.promptTokens,
      completion_tokens: e.completionTokens,
      total_tokens: e.promptTokens + e.completionTokens,
      cached_tokens: e.cachedTokens ?? null,
      cost_usd: e.costUsd ?? null,
      created_at: new Date().toISOString(),
    })
    .execute();
}

export function monthStartUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Total tokens (prompt+completion) this user has spent since `sinceIso`.
 *  0 for a user with no rows in the window — distinct from "we never
 *  measured", which this table has no way to say because it only ever
 *  records real usage. ADR 0196 — this is what `getEntitlement` calls with
 *  `subscription_period_started_at` to compute a real remaining balance. */
export async function getTokenUsageSince(db: Kysely<DB>, userId: string, sinceIso: string): Promise<number> {
  const row = await db
    .selectFrom('token_usage')
    .select((eb) => eb.fn.sum<string | null>('total_tokens').as('total'))
    .where('user_id', '=', userId)
    .where('created_at', '>=', sinceIso)
    .executeTakeFirst();
  return row?.total ? Number(row.total) : 0;
}

/**
 * ADR 0332 — what a set of users spent since `sinceIso`: every real token
 * (`total_tokens`, the count OpenRouter shows) and the dollars behind them.
 * A row with no reported cost (written before 0332, or a provider that does
 * not say) is priced at `ALLOWANCE_USD_PER_MILLION_TOKENS` — fresh input on
 * the default model, so an estimate never undercounts a cached call.
 */
export interface Spend {
  tokens: number;
  usd: number;
}

export async function getSpendSince(db: Kysely<DB>, userIds: string[], sinceIso: string): Promise<Spend> {
  if (userIds.length === 0) return { tokens: 0, usd: 0 };
  const perToken = env.ALLOWANCE_USD_PER_MILLION_TOKENS / 1_000_000;
  const row = await db
    .selectFrom('token_usage')
    .select([
      sql<string | null>`sum(total_tokens)`.as('tokens'),
      sql<string | null>`sum(coalesce(cost_usd, total_tokens * ${perToken}::double precision))`.as('usd'),
    ])
    .where('user_id', 'in', userIds)
    .where('created_at', '>=', sinceIso)
    .executeTakeFirst();
  return { tokens: Number(row?.tokens ?? 0), usd: Number(row?.usd ?? 0) };
}

/** ADR 0332 — the dollar budget of an allowance stated in tokens. */
export function allowanceUsd(allowanceTokens: number): number {
  return (allowanceTokens * env.ALLOWANCE_USD_PER_MILLION_TOKENS) / 1_000_000;
}

/** Dollars for a call with no reported cost — the same estimate as above. */
export function estimateUsd(tokens: number): number {
  return (tokens * env.ALLOWANCE_USD_PER_MILLION_TOKENS) / 1_000_000;
}

export interface AllowanceMeasure {
  /** The dollar budget is not used up. */
  left: boolean;
  /** Dollars still to spend (0 when used up). */
  remainingUsd: number;
  /** Real tokens spent. */
  usedTokens: number;
  /** The budget as tokens for display: real tokens spent so far, scaled by
   *  how much of the budget they cost, so used / allowance on the card is
   *  exactly dollars spent / dollar budget. Before anything is spent it is
   *  the nominal allowance. */
  allowanceTokens: number;
  /** allowanceTokens − usedTokens; at least 1 while `left`, 0 once used up. */
  balance: number;
}

/**
 * ADR 0332 — the rule: nobody spends more than their dollar budget, however
 * many tokens that turns out to be. The token figures are only how it is shown.
 */
export function measureAllowance(spend: Spend, nominalTokens: number): AllowanceMeasure {
  if (env.ALLOWANCE_USD_PER_MILLION_TOKENS <= 0) {
    // No price set: the allowance is plain tokens (the pre-0332 rule).
    const balance = Math.max(0, nominalTokens - spend.tokens);
    return { left: balance > 0, remainingUsd: 0, usedTokens: spend.tokens, allowanceTokens: nominalTokens, balance };
  }
  const budget = allowanceUsd(nominalTokens);
  const left = spend.usd < budget;
  const shown =
    spend.usd > 0 && spend.tokens > 0 ? Math.round((spend.tokens * budget) / spend.usd) : nominalTokens;
  return {
    left,
    remainingUsd: Math.max(0, budget - spend.usd),
    usedTokens: spend.tokens,
    allowanceTokens: shown,
    balance: left ? Math.max(1, shown - spend.tokens) : 0,
  };
}

/** Total tokens this user has spent since the start of the current UTC
 *  calendar month — the ADR 0193 display fallback for anyone with no real
 *  subscription period to measure against (billing off, trial, no plan). */
export async function getTokenUsageThisMonth(db: Kysely<DB>, userId: string): Promise<number> {
  return getTokenUsageSince(db, userId, monthStartUtc());
}

/** Static display quota — not a plan, not enforced. See ADR 0193. */
export function tokenQuotaPerMonth(): number {
  return env.TOKEN_QUOTA_PER_MONTH;
}
