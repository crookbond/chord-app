/**
 * ADR 0241 — what the AI Plan card says on an iPhone, where billing is managed
 * in the browser and the app only reports where the plan stands. The decision
 * lives here (not inside the component) so it has tests: the mobile app has no
 * test harness, and "which states show a Manage billing button, and where does
 * it go" is exactly the kind of rule that drifts silently.
 */
import { PLAN_LABEL } from './billing-plans';
import type { BillingStatus } from './types/billing';

/** Where "Manage billing" sends the person. */
export type ManageBillingTarget =
  /** A Stripe subscriber: their billing portal, no second sign-in. */
  | 'portal'
  /** An App Store subscriber (legacy): the device's Subscriptions page. */
  | 'apple'
  /** Everyone else: the web app's Settings, where plans are chosen. */
  | 'web';

export interface BillingCardModel {
  /** Small caps label above the headline. */
  label: string;
  headline: string;
  /** The renewal / cancellation line, when there is a paid period. */
  period: null | {
    kind: 'cancelled' | 'renews' | 'renews_or_ends';
    /** ISO end of the paid period. */
    until: string;
    viaApple: boolean;
  };
  /** One quiet sentence under the headline, or null. */
  note: string | null;
  /** True when the allowance is spent; `refillsAt` says when it comes back. */
  tokensSpent: null | { refillsAt: string; family: boolean };
  /** Null = nothing to manage from this card (covered member, billing off). */
  manage: null | { target: ManageBillingTarget };
}

/** "142K", "7.2M", "10M" — token counts as the Settings screen shows them. */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round((n / 1_000) * 10) / 10}K`;
  return `${Math.max(0, Math.round(n))}`;
}

/**
 * ADR 0325 — the headline for someone without a plan: how much of the one-time
 * free allowance is left, or that it is used up. Shared by the phone card and
 * the web card so the two say the same thing.
 */
export function freeAllowanceHeadline(b: BillingStatus): string {
  if (b.entitlement === 'free' && b.freeTokens) {
    const left = Math.max(0, b.freeTokens.allowance - b.freeTokens.used);
    return `Free · ${formatTokenCount(left)} of ${formatTokenCount(b.freeTokens.allowance)} tokens left`;
  }
  if (b.entitlement === 'free') return 'Free tokens';
  if (b.freeTokens) return 'Free tokens used up';
  return 'No active plan';
}

/** ADR 0325 — the server reports the usage line against the one-time free
 *  allowance (not a month) on `free`, and on `none` when nothing but the free
 *  allowance was behind it. Mirrors `getBillingStatus`. */
export function usageIsFreeAllowance(b: BillingStatus): boolean {
  if (!b.freeTokens) return false;
  return b.entitlement === 'free' || (!b.plan && !b.allowanceResetsAt);
}

export function billingCardModel(b: BillingStatus, nowMs: number): BillingCardModel {
  const byok = b.tier === 'byok' || b.entitlement === 'byok_unpaid';
  const periodEndMs = b.periodEnd ? Date.parse(b.periodEnd) : NaN;
  const hasPlan = !!b.plan && Number.isFinite(periodEndMs) && periodEndMs > nowMs;
  const covered = b.family?.role === 'member';
  // ADR 0251 - the server sends `byokPriceUsd` only while a base fee is charged,
  // so its absence is "your own key is free": nothing to report or manage.
  const byokFree = b.tier === 'byok' && b.byokPriceUsd == null && !hasPlan;
  const owesNothing =
    b.entitlement === 'billing_off' || b.entitlement === 'grandfathered' || byokFree;

  let headline: string;
  if (covered) {
    headline = `Covered by ${b.family?.ownerName ?? 'a family member'}'s family plan`;
  } else if (byokFree) {
    headline = 'Using your own key - free';
  } else if (hasPlan && b.plan === 'byok_base') {
    headline = 'Using your own key - subscribed';
  } else if (hasPlan && b.plan && b.plan !== 'byok_base') {
    headline = `${PLAN_LABEL[b.plan]} · ${b.interval === 'year' ? 'annual' : 'monthly'}`;
  } else if (b.entitlement === 'grandfathered') {
    headline = 'Founding member - your monthly allowance is free';
  } else if (b.entitlement === 'billing_off') {
    headline = 'Everything is free on this server';
  } else if (b.entitlement === 'byok') {
    headline = 'Using your own key';
  } else if (b.entitlement === 'byok_unpaid') {
    headline = 'Base plan needed';
  } else {
    headline = freeAllowanceHeadline(b);
  }

  let note: string | null = null;
  if (covered) {
    note = 'Your tokens are shared with the rest of the family.';
  } else if (byokFree) {
    note = b.byokKeyIssue
      ? b.byokKeyIssue.message
      : 'Chord does not charge for the AI when you use your own model key.';
  } else if (!hasPlan && b.entitlement === 'free') {
    note = 'Chord’s AI is free until these run out, with no time limit.';
  } else if (!hasPlan && !owesNothing && b.entitlement !== 'byok') {
    note = 'Your plan is managed on the web.';
  }

  const period: BillingCardModel['period'] =
    !covered && hasPlan && b.periodEnd
      ? {
          kind: b.cancelsAtPeriodEnd ? 'cancelled' : b.cancelsAtPeriodEnd === false ? 'renews' : 'renews_or_ends',
          until: b.periodEnd,
          viaApple: b.source === 'apple',
        }
      : null;

  const tokensSpent =
    (hasPlan || covered || b.entitlement === 'grandfathered' || b.allowanceResetsAt) &&
    b.entitlement === 'none' &&
    b.allowanceResetsAt
      ? { refillsAt: b.allowanceResetsAt, family: covered || !!b.family }
      : null;

  let manage: BillingCardModel['manage'] = null;
  if (!covered && (hasPlan || !owesNothing)) {
    manage = { target: !hasPlan ? 'web' : b.source === 'apple' ? 'apple' : b.source === 'stripe' ? 'portal' : 'web' };
  }

  return {
    label: byok && !byokFree ? 'Chord base plan' : 'Chord plan',
    headline,
    period,
    note,
    tokensSpent,
    manage,
  };
}
