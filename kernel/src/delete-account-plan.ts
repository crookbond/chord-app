import type { BillingStatus } from './types/billing';

/**
 * ADR 0342 — what the delete-account box says about the user's plan, or null
 * when there is nothing to say. Only the payer is told: a family member is
 * covered by someone else's plan, and deleting does not touch it.
 */
export function deleteAccountPlanNote(
  billing: Pick<BillingStatus, 'plan' | 'source' | 'periodEnd' | 'family'> | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!billing?.plan || !billing.source) return null;
  if (billing.family?.role === 'member') return null;
  if (billing.periodEnd && Date.parse(billing.periodEnd) <= nowMs) return null;
  const family =
    billing.family?.role === 'owner'
      ? ' Everyone on your family plan loses it at the same time.'
      : '';
  if (billing.source === 'apple') {
    return (
      'Your plan was bought through the App Store, and Chord cannot cancel it. Cancel it first in ' +
      'iPhone Settings → your name → Subscriptions, or Apple keeps charging you after your account is gone.' +
      family
    );
  }
  return `Your Chord plan is cancelled when you delete your account, with no refund for the rest of this period.${family}`;
}
