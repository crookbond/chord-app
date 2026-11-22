/**
 * ADR 0063/0194/0196/0231 — usage-derived entitlement for AI features.
 *
 * "Remaining balance" is COMPUTED, not stored: there is no debit step.
 * `token_usage` (`tokens.service.ts`, ADR 0193) records every consuming AI
 * action — bot turns and all the email AI passes — so a subscriber's balance
 * is `allowance − usage since the current allowance window started`.
 * `users.credit_balance`/`credit_ledger` are VESTIGIAL — legacy names, and
 * nothing writes to them any more.
 *
 * ADR 0231 adds two things on top of that rule, neither of which changes it:
 *   - the window is a MONTH even on an annual subscription
 *     (`billing-window.ts`), because the allowance is monthly;
 *   - a family plan has ONE allowance for the whole family, spent by anyone on
 *     it — "one is done but the other is not, we keep going until the family
 *     is done" — so the usage summed is the family's, not the viewer's.
 */
import type { Kysely } from 'kysely';

import { FAMILY_SEATS, formatTokenCount, type BillingInterval, type SubscriptionPlan, type SubscriptionSource } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { allowanceWindowStart, nextAllowanceReset } from './billing-window.js';
import { freeAllowanceSpentBefore } from './spent-free-allowance.service.js';
import { getSpendSince, measureAllowance, monthStartUtc, type AllowanceMeasure } from './tokens.service.js';

/** The family plan's pooled monthly allowance: an explicit FAMILY_TOKEN_ALLOWANCE
 *  when set above 0, else FAMILY_SEATS x the individual allowance (ADR 0231). */
export function familyTokenAllowance(): number {
  if (env.FAMILY_TOKEN_ALLOWANCE > 0) return env.FAMILY_TOKEN_ALLOWANCE;
  return FAMILY_SEATS * env.MONTHLY_TOKEN_ALLOWANCE;
}

/**
 * ADR 0079/0195/0196/0231/0325 — a free allowance, then the AI surface gates.
 * A user is entitled to AI features (bot turns, email passes, proactive
 * briefings) when ANY of:
 *   - billing is disabled on this deploy (team/dev),
 *   - they're on the individual subscription and haven't used up this
 *     month's allowance yet (usage across EVERY AI surface counts),
 *   - they own, or are seated on, a family subscription whose shared
 *     allowance isn't used up,
 *   - they were here before billing went live (`grandfathered_at`): the
 *     individual allowance, free and permanent, resetting each calendar month,
 *   - they brought their own model key AND (the BYOK base plan isn't
 *     configured on this deploy, OR they, or the family plan covering them,
 *     have an active subscription),
 *   - ADR 0325: everything they have spent on Chord's key since sign-up is
 *     still under FREE_TOKEN_ALLOWANCE (one-time, no time limit; replaces the
 *     30-day trial, existing accounts included).
 * `reason` feeds the UI ("Free · 7.2M of 10M tokens left") and the gate
 * nudge. `byok_unpaid` is distinct from `none` so the UI can point at the
 * BASE plan rather than the token plan.
 */
export interface Entitlement {
  entitled: boolean;
  reason: 'billing_off' | 'free' | 'tokens' | 'grandfathered' | 'byok' | 'byok_unpaid' | 'none';
  /** Computed: the allowance minus usage in the current window. 0 for BYOK
   *  or when there is no allowance to measure against. */
  balance: number;
  /** The allowance `balance` was measured against — the family's pool for a
   *  family plan. 0 when there is no allowance. */
  allowance: number;
  /** The subscription behind a `tokens`/`byok` entitlement, when there is one. */
  plan?: SubscriptionPlan;
  interval?: BillingInterval;
  source?: SubscriptionSource;
  periodEnd?: string;
  /** When the allowance next refills. Set whenever there is an allowance —
   *  including when it has run out (reason `none`), which is the case where
   *  the user needs to be told when they get tokens back. */
  allowanceResetsAt?: string;
  /** Set when the entitlement comes from a family plan: who pays. */
  family?: { role: 'owner' | 'member'; ownerUserId: string };
  /** ADR 0325 — the one-time free allowance, set when it was measured: reason
   *  `free`, or `none` once it is spent. Never on the BYOK path. */
  free?: { allowance: number; used: number };
  /** ADR 0332 — dollars still to spend on the allowance that entitled this
   *  user. The model gate stops a multi-call turn once its own spend reaches
   *  it. Absent when no dollar budget applies (billing off, BYOK, no price). */
  remainingUsd?: number;
}

/** ADR 0332 — `remainingUsd` only when the allowance is priced in dollars. */
function remainingOf(m: AllowanceMeasure): { remainingUsd?: number } {
  return env.ALLOWANCE_USD_PER_MILLION_TOKENS > 0 ? { remainingUsd: m.remainingUsd } : {};
}

interface SubRow {
  subscription_plan: SubscriptionPlan | null;
  subscription_interval: BillingInterval | null;
  subscription_source: SubscriptionSource | null;
  subscription_period_started_at: string | null;
  subscription_current_period_end: string | null;
}

const SUB_COLS = [
  'subscription_plan',
  'subscription_interval',
  'subscription_source',
  'subscription_period_started_at',
  'subscription_current_period_end',
] as const;

function periodActive(row: SubRow | undefined, nowMs: number): boolean {
  return Boolean(
    row?.subscription_plan &&
      row.subscription_current_period_end &&
      nowMs < Date.parse(row.subscription_current_period_end),
  );
}

interface FamilyCoverage {
  ownerUserId: string;
  role: 'owner' | 'member';
  sub: SubRow;
}

/**
 * ADR 0231 — the family plan covering this user right now, if any: they own
 * it with an active family subscription, or they are an ACTIVE seat on
 * someone's. A lapsed owner covers nobody — coverage is read from the owner's
 * period every time, never cached on the member.
 */
export async function getFamilyCoverage(
  db: Kysely<DB>,
  userId: string,
  own: SubRow | undefined,
  nowMs: number = Date.now(),
): Promise<FamilyCoverage | null> {
  if (own && own.subscription_plan === 'family' && periodActive(own, nowMs)) {
    return { ownerUserId: userId, role: 'owner', sub: own };
  }
  const seat = await db
    .selectFrom('family_members')
    .select('owner_user_id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!seat) return null;
  const owner = await db
    .selectFrom('users')
    .select([...SUB_COLS])
    .where('id', '=', seat.owner_user_id)
    .executeTakeFirst();
  if (!owner || owner.subscription_plan !== 'family' || !periodActive(owner, nowMs)) return null;
  return { ownerUserId: seat.owner_user_id, role: 'member', sub: owner };
}

/** ADR 0231 — the user's OWN subscription if its paid period is still running.
 *  The checkout guard: a second subscription on top of a live one would bill
 *  twice, so changes go through the seller's own portal instead. */
export async function getOwnActiveSubscription(
  db: Kysely<DB>,
  userId: string,
  nowMs: number = Date.now(),
): Promise<{ plan: SubscriptionPlan; source: SubscriptionSource | null; periodEnd: string } | null> {
  const row = await db
    .selectFrom('users')
    .select([...SUB_COLS])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row || !periodActive(row, nowMs)) return null;
  return {
    plan: row.subscription_plan as SubscriptionPlan,
    source: row.subscription_source,
    periodEnd: row.subscription_current_period_end as string,
  };
}

/** The ids whose usage share the family's allowance: the payer and every
 *  seated member with an account. */
export async function familyPoolUserIds(db: Kysely<DB>, ownerUserId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('family_members')
    .select('user_id')
    .where('owner_user_id', '=', ownerUserId)
    .where('status', '=', 'active')
    .where('user_id', 'is not', null)
    .execute();
  return [ownerUserId, ...rows.map((r) => r.user_id as string)];
}

/** What a gated chat turn says instead of a reply: why there is no AI right
 *  now and where to fix it. Never a number the entitlement does not carry. */
export function gatedTurnMessage(ent: Entitlement): string {
  if (ent.reason === 'byok_unpaid') {
    return 'Using your own model key needs the base plan — subscribe in Settings → AI Plan to keep Chord going.';
  }
  const why = ent.allowanceResetsAt
    ? 'Your AI tokens for this month are used up.'
    : ent.free
      ? `You’ve used your ${formatTokenCount(ent.free.allowance)} free AI tokens.`
      : 'Chord’s AI needs a plan.';
  return (
    `${why} To keep Chord’s AI going — replies, email insights, and the morning briefing — subscribe in Settings → AI Plan, or add your own model key` +
    (env.STRIPE_PRICE_ID_BYOK ? ' (still needs the base plan).' : ' (free).')
  );
}

export async function getEntitlement(db: Kysely<DB>, userId: string): Promise<Entitlement> {
  const row = await db
    .selectFrom('users')
    .select(['created_at', 'model_key_ciphertext', 'grandfathered_at', ...SUB_COLS])
    .where('id', '=', userId)
    .executeTakeFirst();
  const nowMs = Date.now();
  const base = { balance: 0, allowance: 0 };
  const grandfathered = Boolean(row?.grandfathered_at);
  if (!env.BILLING_ENABLED) return { entitled: true, reason: 'billing_off', ...base };
  const coverage = await getFamilyCoverage(db, userId, row, nowMs);
  const familyBlock = coverage ? { family: { role: coverage.role, ownerUserId: coverage.ownerUserId } } : {};

  if (row?.model_key_ciphertext) {
    // ADR 0195/0251 — BYOK is free: it works, and nobody is asked for a base
    // plan, for as long as STRIPE_PRICE_ID_BYOK is empty (which is how prod is
    // run). Set it and BYOK needs an active subscription (ADR 0231: its own, or
    // a family plan that covers it). BYOK never touches a token balance —
    // nothing is recorded for it.
    if (!env.STRIPE_PRICE_ID_BYOK || grandfathered) return { entitled: true, reason: 'byok', ...base };
    if (periodActive(row, nowMs) || coverage) {
      const sub = coverage?.sub ?? row;
      return {
        entitled: true,
        reason: 'byok',
        ...base,
        ...(sub.subscription_plan ? { plan: sub.subscription_plan } : {}),
        ...(sub.subscription_interval ? { interval: sub.subscription_interval } : {}),
        ...(sub.subscription_source ? { source: sub.subscription_source } : {}),
        ...(sub.subscription_current_period_end ? { periodEnd: sub.subscription_current_period_end } : {}),
        ...familyBlock,
      };
    }
    // ADR 0325 — the free allowance does not cover the base fee: a BYOK user
    // spends none of it (nothing is recorded), so it would never run out.
    return { entitled: false, reason: 'byok_unpaid', ...base };
  }

  // The system-key path needs an ACTIVE subscription (a period in progress),
  // not just "was subscribed once": a lapsed period means no allowance to
  // measure against, whatever `token_usage` says (ADR 0196).
  // What to tell a user whose plan exists but whose tokens are all spent: the
  // plan, so the screen doesn't offer them a second subscription, and when
  // they get tokens back.
  let spent: Partial<Entitlement> = {};
  if (row && row.subscription_plan === 'system' && periodActive(row, nowMs) && row.subscription_period_started_at) {
    const since = allowanceWindowStart(row.subscription_period_started_at, new Date(nowMs));
    // ADR 0332 — the allowance is a dollar budget; tokens are how it is shown.
    const m = measureAllowance(await getSpendSince(db, [userId], since), env.MONTHLY_TOKEN_ALLOWANCE);
    const balance = m.balance;
    const detail = {
      allowance: m.allowanceTokens,
      plan: 'system' as const,
      ...(row.subscription_interval ? { interval: row.subscription_interval } : {}),
      ...(row.subscription_source ? { source: row.subscription_source } : {}),
      periodEnd: row.subscription_current_period_end ?? undefined,
      allowanceResetsAt: nextAllowanceReset(
        row.subscription_period_started_at,
        row.subscription_current_period_end,
        new Date(nowMs),
      ),
    };
    if (m.left) return { entitled: true, reason: 'tokens', balance, ...detail, ...remainingOf(m) };
    spent = detail;
  }

  // ADR 0231 — the family's pool. Reached when the user has no individual
  // subscription, or has used up their own and a family plan still has room.
  if (coverage && coverage.sub.subscription_period_started_at) {
    const since = allowanceWindowStart(coverage.sub.subscription_period_started_at, new Date(nowMs));
    const pool = await familyPoolUserIds(db, coverage.ownerUserId);
    const m = measureAllowance(await getSpendSince(db, pool, since), familyTokenAllowance());
    const balance = m.balance;
    const detail = {
      allowance: m.allowanceTokens,
      plan: 'family' as const,
      ...(coverage.sub.subscription_interval ? { interval: coverage.sub.subscription_interval } : {}),
      ...(coverage.sub.subscription_source ? { source: coverage.sub.subscription_source } : {}),
      periodEnd: coverage.sub.subscription_current_period_end ?? undefined,
      allowanceResetsAt: nextAllowanceReset(
        coverage.sub.subscription_period_started_at,
        coverage.sub.subscription_current_period_end,
        new Date(nowMs),
      ),
    };
    if (m.left) return { entitled: true, reason: 'tokens', balance, ...detail, ...familyBlock, ...remainingOf(m) };
    spent = detail;
  }

  // ADR 0231 — a grandfathered user keeps the individual allowance free, on a
  // calendar-month window (there is no subscription period to anchor to). Last,
  // so a paid plan they later buy is what's measured while it has room.
  if (grandfathered) {
    const monthStart = new Date(monthStartUtc(new Date(nowMs)));
    const m = measureAllowance(
      await getSpendSince(db, [userId], monthStart.toISOString()),
      env.GRANDFATHER_TOKEN_ALLOWANCE,
    );
    const balance = m.balance;
    const resets = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)).toISOString();
    if (m.left) {
      return {
        entitled: true,
        reason: 'grandfathered',
        balance,
        allowance: m.allowanceTokens,
        allowanceResetsAt: resets,
        ...remainingOf(m),
        ...familyBlock,
      };
    }
    // Only if a paid plan hasn't already told us more.
    if (!spent.plan) spent = { allowance: m.allowanceTokens, allowanceResetsAt: resets };
  }
  // ADR 0325 — the one-time free allowance: everything spent on Chord's key
  // since sign-up, against FREE_TOKEN_ALLOWANCE, with no time limit. Ranked
  // where the trial was: after a paid allowance with room (that is what is
  // reported), and as the fallback when a paid allowance is spent — `spent`
  // keeps the plan on the card. Same rule for accounts made before it.
  // ADR 0342 — an identity a deleted account held brings no free allowance.
  if (env.FREE_TOKEN_ALLOWANCE > 0 && row && !(await freeAllowanceSpentBefore(db, userId))) {
    // token_usage.created_at is always toISOString(); normalise the sign-up
    // time to the same shape so the text comparison is an instant comparison.
    const signedUpMs = Date.parse(row.created_at);
    const since = Number.isFinite(signedUpMs) ? new Date(signedUpMs).toISOString() : new Date(0).toISOString();
    const m = measureAllowance(await getSpendSince(db, [userId], since), env.FREE_TOKEN_ALLOWANCE);
    const free = { allowance: m.allowanceTokens, used: m.usedTokens };
    const balance = m.balance;
    if (m.left) {
      return {
        entitled: true,
        reason: 'free',
        ...spent,
        balance,
        allowance: m.allowanceTokens,
        free,
        ...remainingOf(m),
        ...familyBlock,
      };
    }
    if (!spent.allowance) spent = { allowance: m.allowanceTokens };
    return { entitled: false, reason: 'none', ...base, ...spent, free, ...familyBlock };
  }
  return { entitled: false, reason: 'none', ...base, ...spent, ...familyBlock };
}
