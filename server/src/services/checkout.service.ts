/**
 * ADR 0231 — start a Stripe checkout. One function for the REST route
 * (`POST /me/billing/checkout`) and the `get_checkout_link` bot tool, so
 * "may this person buy this right now, and with which code" is decided in one
 * place and the two surfaces can't disagree (the ADR 0196 reasoning, again).
 */
import type { Kysely } from 'kysely';

import type { BillingInterval, SubscriptionPlan, SubscriptionSource } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { getOwnActiveSubscription } from './billing.service.js';
import { checkPromoCode, type PromoFailure } from './promo.service.js';
import { createSubscriptionCheckoutSession, subscriptionCheckoutEnabled } from './stripe.service.js';

export type StartCheckoutResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'billing_unavailable' }
  | { ok: false; reason: 'already_subscribed'; source: SubscriptionSource | null; plan: SubscriptionPlan }
  | { ok: false; reason: PromoFailure };

export async function startCheckout(
  db: Kysely<DB>,
  userId: string,
  args: {
    plan: SubscriptionPlan;
    interval?: BillingInterval;
    platform?: 'web' | 'native';
    code?: string | null;
  },
  fetchFn: typeof fetch = fetch,
): Promise<StartCheckoutResult> {
  const interval = args.interval ?? 'month';
  if (!env.BILLING_ENABLED || !subscriptionCheckoutEnabled(args.plan, interval)) {
    return { ok: false, reason: 'billing_unavailable' };
  }
  // A live subscription is changed in its seller's portal, not stacked under a
  // second one (two subscriptions bill twice).
  const live = await getOwnActiveSubscription(db, userId);
  if (live) return { ok: false, reason: 'already_subscribed', source: live.source, plan: live.plan };

  let promo: { code: string; trialDays: number } | null = null;
  if (args.code?.trim()) {
    const checked = await checkPromoCode(db, args.code);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    promo = { code: checked.code, trialDays: checked.trialDays };
  }
  const customer = await db
    .selectFrom('users')
    .select('stripe_customer_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  const { url } = await createSubscriptionCheckoutSession(
    userId,
    args.plan,
    interval,
    args.platform === 'native' ? 'native' : 'web',
    fetchFn,
    { customerId: customer?.stripe_customer_id ?? null, promo },
  );
  return { ok: true, url };
}
