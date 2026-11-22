/**
 * ADR 0231 - what the plan picker SHOWS. Annual is twelve months for eleven
 * (`ANNUAL_FREE_MONTHS = 1`), so the family annual price is 11 x $24.99, not a
 * rounded $275 - the figure has to match the Stripe price the customer is
 * actually charged, or the button promises one number and the card pays another.
 */
import { derivePlanPrices, formatPlanPrice } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';

describe('plan prices', () => {
  const prices = derivePlanPrices({ individualMonthly: 7.99, familyMonthly: 24.99, annualFreeMonths: 1 });

  it('annual is the monthly price times eleven, to the cent', () => {
    expect(prices.system).toEqual({ month: 7.99, year: 87.89 });
    expect(prices.family).toEqual({ month: 24.99, year: 274.89 });
  });

  it('reads as the customer will see it', () => {
    expect(formatPlanPrice(prices, 'family', 'month')).toBe('$24.99/mo');
    expect(formatPlanPrice(prices, 'family', 'year')).toBe('$274.89/yr');
    expect(formatPlanPrice(prices, 'system', 'year')).toBe('$87.89/yr');
  });

  it('the shipped defaults are the prices created in Stripe', () => {
    expect(env.PRICE_INDIVIDUAL_USD).toBe(7.99);
    expect(env.PRICE_FAMILY_USD).toBe(24.99);
    expect(env.ANNUAL_FREE_MONTHS).toBe(1);
  });
});
