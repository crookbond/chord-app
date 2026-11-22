/**
 * ADR 0231 — App Store subscriptions arrive through RevenueCat, which owns
 * receipt validation and Apple's server notifications and tells us what
 * happened in one webhook. This file is the pure half: authenticate the
 * webhook, narrow an event, map a product to a plan. The write lives in
 * `routes/webhooks.ts` beside Stripe's, and lands on the SAME `users`
 * columns, so `getEntitlement` neither knows nor cares who sold it.
 */
import crypto from 'node:crypto';

import type { Kysely } from 'kysely';

import type { BillingInterval, SubscriptionPlan } from '@chord/kernel';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';

export function revenueCatWebhookEnabled(): boolean {
  return env.REVENUECAT_WEBHOOK_SECRET.length > 0;
}

/**
 * RevenueCat sends whatever string was configured as the webhook's
 * Authorization value. Accept it bare or `Bearer`-prefixed, compared in
 * constant time.
 */
export function verifyRevenueCatAuth(header: string | undefined): boolean {
  const secret = env.REVENUECAT_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const got = Buffer.from(header.replace(/^Bearer\s+/i, '').trim(), 'utf8');
  const want = Buffer.from(secret, 'utf8');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** The products we sell, as named in App Store Connect. Read at call time. */
export function appleProducts(): Array<{ productId: string; plan: SubscriptionPlan; interval: BillingInterval }> {
  return [
    { productId: env.APPLE_PRODUCT_INDIVIDUAL_MONTHLY, plan: 'system', interval: 'month' },
    { productId: env.APPLE_PRODUCT_INDIVIDUAL_YEARLY, plan: 'system', interval: 'year' },
    { productId: env.APPLE_PRODUCT_FAMILY_MONTHLY, plan: 'family', interval: 'month' },
    { productId: env.APPLE_PRODUCT_FAMILY_YEARLY, plan: 'family', interval: 'year' },
    // ADR 0238 - the bring-your-own-key base plan, sold in the app like the rest.
    { productId: env.APPLE_PRODUCT_BYOK_MONTHLY, plan: 'byok_base', interval: 'month' },
  ];
}

export function planForAppleProduct(
  productId: string | null | undefined,
): { plan: SubscriptionPlan; interval: BillingInterval } | null {
  if (!productId) return null;
  const hit = appleProducts().find((p) => p.productId && p.productId === productId);
  return hit ? { plan: hit.plan, interval: hit.interval } : null;
}

export type RevenueCatChange =
  | {
      kind: 'grant';
      eventId: string;
      userId: string;
      productId: string;
      periodStart: string;
      periodEnd: string;
    }
  | { kind: 'expire'; eventId: string; userId: string; expiredAt: string }
  | { kind: 'ignore'; reason: string };

// A purchase or a renewal opens (or extends) a paid period.
const GRANT_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION']);

/**
 * Narrow a RevenueCat webhook body. CANCELLATION is deliberately an ignore:
 * the customer paid for the period and keeps it to the end — the same
 * "cancellation needs no handler" reasoning as Stripe (ADR 0195). Only
 * EXPIRATION closes a period.
 */
export function parseRevenueCatEvent(rawBody: unknown): RevenueCatChange {
  const evt = (rawBody as { event?: Record<string, unknown> } | null)?.event;
  if (!evt || typeof evt !== 'object') return { kind: 'ignore', reason: 'no_event' };
  const type = String(evt.type ?? '');
  const userId = typeof evt.app_user_id === 'string' ? evt.app_user_id : '';
  const eventId = typeof evt.id === 'string' ? evt.id : '';
  const isGrant = GRANT_TYPES.has(type);
  if (!isGrant && type !== 'EXPIRATION') return { kind: 'ignore', reason: `type_${type || 'unknown'}` };
  // RevenueCat's anonymous ids are not ours. The app logs in with the Chord
  // user id before purchasing, so an anonymous purchase is unattributable.
  if (!userId || userId.startsWith('$RCAnonymousID')) return { kind: 'ignore', reason: 'anonymous_user' };

  const endMs = Number(evt.expiration_at_ms);
  if (type === 'EXPIRATION') {
    if (!Number.isFinite(endMs)) return { kind: 'ignore', reason: 'no_expiration' };
    return { kind: 'expire', eventId, userId, expiredAt: new Date(endMs).toISOString() };
  }
  const startMs = Number(evt.purchased_at_ms);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return { kind: 'ignore', reason: 'no_period' };
  // On a product change the new product rides `new_product_id`; `product_id`
  // is the one being left.
  const productId = String((type === 'PRODUCT_CHANGE' ? evt.new_product_id : undefined) ?? evt.product_id ?? '');
  return {
    kind: 'grant',
    eventId,
    userId,
    productId,
    periodStart: new Date(startMs).toISOString(),
    periodEnd: new Date(endMs).toISOString(),
  };
}

export type ApplyOutcome =
  | 'granted'
  | 'expired'
  | 'unknown_user'
  | 'unknown_product'
  | 'stale'
  | 'ignored';

/**
 * Write a narrowed change onto the user row. Events can arrive late or out of
 * order, so each write checks it is not older than what is already stored:
 *  - a grant for a period that began BEFORE the stored one is stale (a late
 *    delivery of a previous renewal); an equal start is a harmless re-delivery;
 *  - an expiration only closes the period it names — if a newer renewal has
 *    already moved the end past it, it is stale (a resubscribe won the race).
 * An expiration never touches a subscription Stripe sold.
 */
export async function applyRevenueCatChange(
  db: Kysely<DB>,
  change: RevenueCatChange,
): Promise<ApplyOutcome> {
  if (change.kind === 'ignore') return 'ignored';
  const user = await db
    .selectFrom('users')
    .select(['subscription_source', 'subscription_current_period_end', 'subscription_period_started_at'])
    .where('id', '=', change.userId)
    .executeTakeFirst();
  if (!user) return 'unknown_user';
  const storedEnd = user.subscription_current_period_end ? Date.parse(user.subscription_current_period_end) : 0;

  if (change.kind === 'expire') {
    if (user.subscription_source !== 'apple') return 'ignored';
    if (storedEnd > Date.parse(change.expiredAt)) return 'stale';
    await db
      .updateTable('users')
      .set({ subscription_current_period_end: change.expiredAt })
      .where('id', '=', change.userId)
      .execute();
    return 'expired';
  }

  const priced = planForAppleProduct(change.productId);
  if (!priced) return 'unknown_product';
  // Order by when the period BEGAN, not when it ends: an immediate upgrade
  // from an annual plan to a monthly one legitimately ends sooner than the
  // plan it replaces, and must not be mistaken for a late delivery.
  const storedStart = user.subscription_period_started_at ? Date.parse(user.subscription_period_started_at) : 0;
  if (user.subscription_source === 'apple' && storedStart > Date.parse(change.periodStart)) return 'stale';
  await db
    .updateTable('users')
    .set({
      subscription_plan: priced.plan,
      subscription_interval: priced.interval,
      subscription_source: 'apple',
      subscription_period_started_at: change.periodStart,
      subscription_current_period_end: change.periodEnd,
    })
    .where('id', '=', change.userId)
    .execute();
  return 'granted';
}
