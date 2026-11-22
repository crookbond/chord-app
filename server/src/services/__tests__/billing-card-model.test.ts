/**
 * ADR 0241 - the iPhone AI Plan card shows where the plan stands and sends every
 * billing action to the browser. These are the states from the design review,
 * so the rule "which ones get a Manage billing button, and where it goes" cannot
 * drift without a test saying so.
 */
import { billingCardModel, freeAllowanceHeadline, usageIsFreeAllowance, type BillingStatus } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const DAY = 86_400_000;
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

function status(over: Partial<BillingStatus> = {}): BillingStatus {
  return {
    balance: 0,
    tier: 'premium',
    model: 'm',
    billingEnabled: true,
    checkoutAvailable: true,
    byokCheckoutAvailable: true,
    entitlement: 'tokens',
    ...over,
  };
}

describe('billingCardModel (iPhone: billing is managed in the browser)', () => {
  it('a Stripe subscriber is sent to their billing portal', () => {
    const m = billingCardModel(
      status({ plan: 'family', interval: 'year', source: 'stripe', periodEnd: inDays(30), cancelsAtPeriodEnd: false }),
      NOW,
    );
    expect(m).toMatchObject({
      label: 'Chord plan',
      headline: 'Family of 4 · annual',
      period: { kind: 'renews', until: inDays(30), viaApple: false },
      manage: { target: 'portal' },
    });
  });

  it('a plan that was told not to renew says it stops, and is still manageable', () => {
    const m = billingCardModel(
      status({ plan: 'system', interval: 'month', source: 'stripe', periodEnd: inDays(12), cancelsAtPeriodEnd: true }),
      NOW,
    );
    expect(m.period).toMatchObject({ kind: 'cancelled', until: inDays(12) });
    expect(m.manage).toEqual({ target: 'portal' });
  });

  it('an unknown cancel state reads as "renews or ends", never as a promise', () => {
    const m = billingCardModel(status({ plan: 'system', interval: 'month', source: 'stripe', periodEnd: inDays(12) }), NOW);
    expect(m.period?.kind).toBe('renews_or_ends');
  });

  it('free tokens used up with no plan: nothing is sold in the app, the web is the way in', () => {
    const m = billingCardModel(status({ entitlement: 'none', freeTokens: { allowance: 10_000_000, used: 10_400_000 } }), NOW);
    expect(m).toMatchObject({
      headline: 'Free tokens used up',
      note: 'Your plan is managed on the web.',
      manage: { target: 'web' },
      period: null,
    });
  });

  it('the free allowance says how many tokens are left, never days, and still offers the browser (ADR 0325)', () => {
    const m = billingCardModel(
      status({ entitlement: 'free', balance: 7_200_000, freeTokens: { allowance: 10_000_000, used: 2_800_000 } }),
      NOW,
    );
    expect(m).toMatchObject({
      headline: 'Free · 7.2M of 10M tokens left',
      note: 'Chord’s AI is free until these run out, with no time limit.',
      manage: { target: 'web' },
      period: null,
      tokensSpent: null,
    });
    expect(m.headline).not.toMatch(/day/);
  });

  it('a lapsed plan with no free allowance on this deploy says so plainly', () => {
    expect(billingCardModel(status({ entitlement: 'none' }), NOW).headline).toBe('No active plan');
  });

  it('the usage line counts the free allowance only when nothing else is behind it', () => {
    const free = { allowance: 10_000_000, used: 3_000_000 };
    expect(usageIsFreeAllowance(status({ entitlement: 'free', freeTokens: free }))).toBe(true);
    expect(usageIsFreeAllowance(status({ entitlement: 'none', freeTokens: free }))).toBe(true);
    // A spent paid plan is what the line is about, even though the free one is spent too.
    expect(
      usageIsFreeAllowance(status({ entitlement: 'none', freeTokens: free, plan: 'system', allowanceResetsAt: inDays(4) })),
    ).toBe(false);
    expect(usageIsFreeAllowance(status({ entitlement: 'tokens' }))).toBe(false);
    expect(freeAllowanceHeadline(status({ entitlement: 'free', freeTokens: { allowance: 10_000_000, used: 9_999_500 } }))).toBe(
      'Free · 500 of 10M tokens left',
    );
  });

  it('a bring-your-own-key subscriber sees the base plan, and manages it in the portal', () => {
    const m = billingCardModel(
      status({ tier: 'byok', entitlement: 'byok', plan: 'byok_base', interval: 'month', source: 'stripe', periodEnd: inDays(27) }),
      NOW,
    );
    expect(m).toMatchObject({
      label: 'Chord base plan',
      headline: 'Using your own key - subscribed',
      manage: { target: 'portal' },
    });
  });

  it('a bring-your-own-key user who owes the base plan is sent to the web, with no price on the card', () => {
    const m = billingCardModel(status({ tier: 'byok', entitlement: 'byok_unpaid', byokPriceUsd: 2.99 }), NOW);
    expect(m).toMatchObject({ label: 'Chord base plan', headline: 'Base plan needed', manage: { target: 'web' } });
  });

  it('a bring-your-own-key user is free: no base plan, nothing to manage (ADR 0251)', () => {
    // The server omits `byokPriceUsd` while no base fee is charged, so a BYOK
    // user must not be sent to a browser to manage a bill that does not exist.
    for (const entitlement of ['byok'] as const) {
      const m = billingCardModel(status({ tier: 'byok', entitlement }), NOW);
      expect(m).toMatchObject({
        label: 'Chord plan',
        headline: 'Using your own key - free',
        note: 'Chord does not charge for the AI when you use your own model key.',
        manage: null,
        period: null,
      });
    }
  });

  it('a member covered by a family plan has nothing to manage, and is told whose plan it is', () => {
    const m = billingCardModel(
      status({ family: { role: 'member', seats: 4, seatsUsed: 2, ownerName: 'John' }, entitlement: 'tokens' }),
      NOW,
    );
    expect(m).toMatchObject({
      headline: "Covered by John's family plan",
      note: 'Your tokens are shared with the rest of the family.',
      manage: null,
    });
  });

  it('billing off and a founding member with no plan have nothing to manage', () => {
    expect(billingCardModel(status({ entitlement: 'billing_off' }), NOW).manage).toBeNull();
    expect(billingCardModel(status({ entitlement: 'grandfathered' }), NOW).manage).toBeNull();
  });

  it('a legacy App Store plan points at the device Subscriptions page', () => {
    const m = billingCardModel(status({ plan: 'system', interval: 'month', source: 'apple', periodEnd: inDays(9) }), NOW);
    expect(m.manage).toEqual({ target: 'apple' });
    expect(m.period?.viaApple).toBe(true);
  });

  it('an all-spent allowance says when it comes back', () => {
    const m = billingCardModel(
      status({ entitlement: 'none', plan: 'system', interval: 'month', source: 'stripe', periodEnd: inDays(9), allowanceResetsAt: inDays(4) }),
      NOW,
    );
    expect(m.tokensSpent).toEqual({ refillsAt: inDays(4), family: false });
  });

  it('never puts a price on the card, in any state', () => {
    const states: Partial<BillingStatus>[] = [
      { entitlement: 'none' },
      { entitlement: 'free', freeTokens: { allowance: 10_000_000, used: 1_000 } },
      { tier: 'byok', entitlement: 'byok_unpaid', byokPriceUsd: 2.99 },
      { tier: 'byok', entitlement: 'byok' },
      { plan: 'family', interval: 'year', source: 'stripe', periodEnd: inDays(30) },
      { tier: 'byok', entitlement: 'byok', plan: 'byok_base', interval: 'month', source: 'stripe', periodEnd: inDays(27) },
    ];
    for (const s of states) {
      expect(JSON.stringify(billingCardModel(status(s), NOW))).not.toMatch(/\$\d/);
    }
  });
});
