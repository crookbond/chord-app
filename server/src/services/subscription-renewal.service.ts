/**
 * ADR 0236 — cancel (or resume) a subscription from inside Chord. One function
 * for `POST /me/billing/renewal` and the `set_subscription_renewal` bot tool,
 * so "may this person do that, and what happened" is decided once (the ADR
 * 0196 / 0231 reasoning).
 *
 * "Cancel" means stop renewing at the end of the paid period, never an
 * immediate end: the money is spent and the plan keeps working until then.
 * That is also why it is one click with no refund logic, and why Resume exists.
 */
import type { Kysely } from 'kysely';

import type { BillingInterval, SubscriptionPlan, SubscriptionSource } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { getOwnActiveSubscription } from './billing.service.js';
import {
  changeSubscriptionPlan,
  getSubscriptionCancelsAtPeriodEnd,
  setSubscriptionRenewal,
  subscriptionCheckoutEnabled,
} from './stripe.service.js';

export type RenewalResult =
  | { ok: true; cancelsAtPeriodEnd: boolean; periodEnd: string | null }
  | { ok: false; reason: 'apple'; source: SubscriptionSource }
  | { ok: false; reason: 'no_subscription' | 'billing_unavailable' | 'stripe_error' };

export async function setRenewal(
  db: Kysely<DB>,
  userId: string,
  renew: boolean,
  fetchFn: typeof fetch = fetch,
): Promise<RenewalResult> {
  const live = await getOwnActiveSubscription(db, userId);
  if (!live) return { ok: false, reason: 'no_subscription' };
  // The App Store owns an Apple subscription: only the device can cancel it.
  if (live.source === 'apple') return { ok: false, reason: 'apple', source: 'apple' };
  const row = await db
    .selectFrom('users')
    .select('stripe_subscription_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.stripe_subscription_id) return { ok: false, reason: 'no_subscription' };
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: 'billing_unavailable' };
  try {
    const { cancelsAtPeriodEnd } = await setSubscriptionRenewal(row.stripe_subscription_id, renew, fetchFn);
    return { ok: true, cancelsAtPeriodEnd, periodEnd: live.periodEnd };
  } catch {
    return { ok: false, reason: 'stripe_error' };
  }
}

export type ChangePlanResult =
  | { ok: true; plan: SubscriptionPlan; interval: BillingInterval; resumed: boolean }
  | { ok: false; reason: 'apple'; source: SubscriptionSource }
  | {
      ok: false;
      reason:
        | 'no_subscription'
        | 'not_switchable'
        | 'same_plan'
        | 'billing_unavailable'
        | 'payment_failed'
        | 'stripe_error';
    };

/**
 * ADR 0236 — switch the user's own live Stripe subscription to another
 * (plan, interval). The same plan and interval is not a change: if the
 * subscription was set to cancel that means "resume" and is done as one, else
 * it is refused so a double tap never charges anything.
 */
export async function changePlan(
  db: Kysely<DB>,
  userId: string,
  plan: SubscriptionPlan,
  interval: BillingInterval,
  fetchFn: typeof fetch = fetch,
): Promise<ChangePlanResult> {
  if (plan === 'byok_base') return { ok: false, reason: 'not_switchable' };
  const live = await getOwnActiveSubscription(db, userId);
  if (!live) return { ok: false, reason: 'no_subscription' };
  if (live.source === 'apple') return { ok: false, reason: 'apple', source: 'apple' };
  // The bring-your-own-key base plan is a different product, not a tier of this one.
  if (live.plan === 'byok_base') return { ok: false, reason: 'not_switchable' };
  const row = await db
    .selectFrom('users')
    .select(['stripe_subscription_id', 'subscription_interval'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.stripe_subscription_id) return { ok: false, reason: 'no_subscription' };
  if (!env.STRIPE_SECRET_KEY || !subscriptionCheckoutEnabled(plan, interval)) {
    return { ok: false, reason: 'billing_unavailable' };
  }
  if (live.plan === plan && row.subscription_interval === interval) {
    const cancelling = await getSubscriptionCancelsAtPeriodEnd(row.stripe_subscription_id, fetchFn);
    if (cancelling !== true) return { ok: false, reason: 'same_plan' };
    const out = await setRenewal(db, userId, true, fetchFn);
    return out.ok ? { ok: true, plan, interval, resumed: true } : { ok: false, reason: 'stripe_error' };
  }
  try {
    const out = await changeSubscriptionPlan(row.stripe_subscription_id, plan, interval, fetchFn);
    if (out.paymentFailed) return { ok: false, reason: 'payment_failed' };
    // Stripe accepted the change and charged for it, so the new plan is true
    // now. The paid-invoice webhook later sets the exact period dates.
    await db
      .updateTable('users')
      .set({ subscription_plan: plan, subscription_interval: interval, subscription_source: 'stripe' })
      .where('id', '=', userId)
      .execute();
    return { ok: true, plan, interval, resumed: false };
  } catch {
    return { ok: false, reason: 'stripe_error' };
  }
}

/** The `cancelsAtPeriodEnd` shown on the plan card; undefined = unknown. */
export async function renewalStatus(
  db: Kysely<DB>,
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | undefined> {
  if (!env.STRIPE_SECRET_KEY) return undefined;
  const row = await db
    .selectFrom('users')
    .select(['stripe_subscription_id', 'subscription_source'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.stripe_subscription_id || row.subscription_source === 'apple') return undefined;
  const cancels = await getSubscriptionCancelsAtPeriodEnd(row.stripe_subscription_id, fetchFn);
  return cancels === null ? undefined : cancels;
}
