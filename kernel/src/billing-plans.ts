/**
 * ADR 0231 — what the plans cost, as the app SHOWS it. The prices are
 * configuration (the server derives them from env and ships them on
 * `BillingStatus.prices`), never constants in a client build. The real charge
 * is the Stripe price / App Store product; on iOS the store's own localized
 * string wins over this.
 */
import type { BillingInterval, SubscriptionPlan } from './types/billing';

export type SellablePlan = Exclude<SubscriptionPlan, 'byok_base'>;

/** USD per period, by plan and interval. */
export type PlanPrices = Record<SellablePlan, Record<BillingInterval, number>>;

export const PLAN_LABEL: Record<SellablePlan, string> = {
  system: 'Individual',
  family: 'Family of 4',
};

const cents = (n: number): number => Math.round(n * 100) / 100;

export interface PlanPriceInputs {
  individualMonthly: number;
  familyMonthly: number;
  /** Months of the year the annual price waives. 1 = twelve months for eleven. */
  annualFreeMonths: number;
  /** Explicit annual prices; 0/undefined = derive from the monthly one. */
  individualYearly?: number;
  familyYearly?: number;
}

export function derivePlanPrices(i: PlanPriceInputs): PlanPrices {
  const paidMonths = Math.max(1, 12 - Math.max(0, i.annualFreeMonths));
  return {
    system: {
      month: cents(i.individualMonthly),
      year: cents(i.individualYearly || i.individualMonthly * paidMonths),
    },
    family: {
      month: cents(i.familyMonthly),
      year: cents(i.familyYearly || i.familyMonthly * paidMonths),
    },
  };
}

export function formatPlanPrice(prices: PlanPrices, plan: SellablePlan, interval: BillingInterval): string {
  const usd = prices[plan][interval];
  const amount = Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
  return `${amount}/${interval === 'month' ? 'mo' : 'yr'}`;
}
