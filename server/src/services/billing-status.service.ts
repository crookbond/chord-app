/**
 * ADR 0063/0193/0194/0196 — assembles the one `BillingStatus` object both
 * `GET /me/billing` (Settings) and the `get_billing_status` bot tool
 * return. Lives in its own file rather than inside `billing.service.ts`
 * because it needs `resolveTurnLlm` (`llm/factory.ts`), which already
 * imports `getEntitlement` FROM `billing.service.ts` — putting the
 * assembler there would create a cycle. This file sits above both, so
 * there's exactly one place that combines them, and "what does Settings
 * show" and "what does the bot say" can never drift apart the way the
 * pre-ADR-0196 balance/usage split did.
 */
import type { Kysely } from 'kysely';

import { derivePlanPrices, usageIsFreeAllowance, type BillingStatus } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { getEntitlement } from './billing.service.js';
import { getFamilyOverview } from './family-plan.service.js';
import { resolveTurnLlm } from './llm/factory.js';
import { getByokKeyIssue } from './llm/key-health.js';
import { revenueCatWebhookEnabled } from './revenuecat.service.js';
import { renewalStatus } from './subscription-renewal.service.js';
import { subscriptionCheckoutEnabled } from './stripe.service.js';
import { getTokenUsageThisMonth, tokenQuotaPerMonth } from './tokens.service.js';

export async function getBillingStatus(db: Kysely<DB>, userId: string): Promise<BillingStatus> {
  const [resolved, ent] = await Promise.all([resolveTurnLlm(db, userId), getEntitlement(db, userId)]);
  const status: BillingStatus = {
    balance: ent.balance,
    tier: resolved.tier,
    model: resolved.llm.defaultModel,
    billingEnabled: env.BILLING_ENABLED,
    checkoutAvailable: env.BILLING_ENABLED && subscriptionCheckoutEnabled('system'),
    byokCheckoutAvailable: env.BILLING_ENABLED && subscriptionCheckoutEnabled('byok_base'),
    entitlement: ent.reason,
    ...(ent.free ? { freeTokens: ent.free } : {}),
    prices: derivePlanPrices({
      individualMonthly: env.PRICE_INDIVIDUAL_USD,
      familyMonthly: env.PRICE_FAMILY_USD,
      annualFreeMonths: env.ANNUAL_FREE_MONTHS,
      individualYearly: env.PRICE_INDIVIDUAL_YEARLY_USD,
      familyYearly: env.PRICE_FAMILY_YEARLY_USD,
    }),
    checkoutPlans: {
      system: {
        month: env.BILLING_ENABLED && subscriptionCheckoutEnabled('system', 'month'),
        year: env.BILLING_ENABLED && subscriptionCheckoutEnabled('system', 'year'),
      },
      family: {
        month: env.BILLING_ENABLED && subscriptionCheckoutEnabled('family', 'month'),
        year: env.BILLING_ENABLED && subscriptionCheckoutEnabled('family', 'year'),
      },
    },
    appleAvailable: env.BILLING_ENABLED && revenueCatWebhookEnabled(),
    appleProducts: {
      system: { month: env.APPLE_PRODUCT_INDIVIDUAL_MONTHLY, year: env.APPLE_PRODUCT_INDIVIDUAL_YEARLY },
      family: { month: env.APPLE_PRODUCT_FAMILY_MONTHLY, year: env.APPLE_PRODUCT_FAMILY_YEARLY },
    },
    // ADR 0251 — sent ONLY while a base price is configured; its absence is how
    // the app knows BYOK is free.
    ...(env.STRIPE_PRICE_ID_BYOK
      ? { byokPriceUsd: env.PRICE_BYOK_USD, appleByokProduct: env.APPLE_PRODUCT_BYOK_MONTHLY }
      : {}),
  };
  const keyIssue = await getByokKeyIssue(db, userId);
  if (keyIssue) status.byokKeyIssue = keyIssue;
  if (ent.plan) status.plan = ent.plan;
  if (ent.interval) status.interval = ent.interval;
  if (ent.source) status.source = ent.source;
  if (ent.periodEnd) status.periodEnd = ent.periodEnd;
  // ADR 0236 — only a Stripe subscription can be told not to renew from here.
  if (ent.source === 'stripe' && ent.periodEnd) {
    const cancels = await renewalStatus(db, userId);
    if (cancels !== undefined) status.cancelsAtPeriodEnd = cancels;
  }
  if (ent.allowanceResetsAt) status.allowanceResetsAt = ent.allowanceResetsAt;
  if (ent.family) {
    const fam = await getFamilyOverview(db, userId);
    status.family = {
      role: ent.family.role,
      seats: fam.seats,
      seatsUsed: fam.seatsUsed,
      ...(fam.ownerName ? { ownerName: fam.ownerName } : {}),
    };
  }
  // ADR 0193/0196 — visibility only; BYOK gets no total to show a used/total
  // line against. `ent.reason === 'tokens'` means an ACTIVE system
  // subscription, whose balance IS allowance-minus-usage (ADR 0196) —
  // derive "used" from it (one query, can't drift from what actually gates
  // them) instead of re-querying. ADR 0325 — on the free allowance (or once
  // it is spent with no plan behind it) the line is that one-time total.
  // Everyone else (billing off, no allowance at all) falls back to ADR 0193's
  // original calendar-month display.
  if (resolved.tier !== 'byok') {
    // The same rule the app reads the line by (kernel), so they cannot disagree.
    if (usageIsFreeAllowance(status) && ent.free) {
      status.tokensUsedThisMonth = ent.free.used;
      status.tokensQuotaPerMonth = ent.free.allowance;
    } else if (ent.allowance > 0) {
      // An allowance exists (even one that is all spent): report against it.
      // ADR 0231 — the allowance the balance was measured against: the
      // family's pool for a family plan, the individual figure otherwise.
      status.tokensUsedThisMonth = ent.allowance - ent.balance;
      status.tokensQuotaPerMonth = ent.allowance;
    } else {
      status.tokensUsedThisMonth = await getTokenUsageThisMonth(db, userId);
      status.tokensQuotaPerMonth = tokenQuotaPerMonth();
    }
  }
  return status;
}
