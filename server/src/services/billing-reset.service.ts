/**
 * ADR 0236 addendum — put ONE account's billing back to "never subscribed", so
 * every purchase scenario (first buy, annual, family, promo code, cancel,
 * resume, lapse) can be walked again on the same real account.
 *
 * What it does, and the one thing it is careful about:
 *   - clears the subscription columns `getEntitlement` reads, so the account
 *     is entitled by its free allowance / grandfathering / nothing, as a new one would be;
 *   - first looks at the Stripe subscription. Clearing our columns does NOT
 *     stop Stripe billing: a subscription that is still going to renew would
 *     produce an `invoice.paid` next period and silently re-grant the plan.
 *     So it refuses while Stripe says the subscription will renew, unless it is
 *     told to end it (`cancelInStripe`) or the operator overrides (`force`).
 *   - never touches other people's data: the family roster, group membership,
 *     usage rows and promo codes are left alone and only reported.
 *
 * Dry run unless `apply`. A live Stripe key is refused unless `allowLive`.
 */
import type { Kysely } from 'kysely';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import { cancelSubscriptionNow, getSubscriptionState } from './stripe.service.js';

export interface BillingResetOptions {
  /** End a still-renewing Stripe subscription immediately before clearing. */
  cancelInStripe?: boolean;
  /** Also forget the Stripe customer id (checkout then mints a new customer). */
  dropCustomer?: boolean;
  /** Also remove the free "founding member" allowance. */
  clearGrandfather?: boolean;
  /** Rewrite `created_at`: `fresh` (now) or an ISO date. The ADR 0325 free
   *  allowance counts usage since `created_at`, so `fresh` gives it back. */
  createdAt?: string;
  /** Proceed even though Stripe could not be asked, or says it will renew. */
  force?: boolean;
  /** Allow an `sk_live_` Stripe key. */
  allowLive?: boolean;
  apply?: boolean;
}

export interface BillingChange {
  field: string;
  from: string | null;
  to: string | null;
}

export type BillingResetResult =
  | { ok: false; reason: 'no_user' }
  | { ok: false; reason: 'bad_created_at' }
  | { ok: false; reason: 'live_key' }
  | { ok: false; reason: 'apple_active' }
  | { ok: false; reason: 'stripe_renewing'; stripeStatus: string }
  | { ok: false; reason: 'stripe_unverified' }
  | {
      ok: true;
      applied: boolean;
      userId: string;
      username: string;
      changes: BillingChange[];
      stripe: { subscriptionId: string | null; status: string | null; cancelsAtPeriodEnd: boolean | null; endedNow: boolean };
      /** Left alone on purpose, so the report can name it. */
      untouched: { stripeCustomerId: string | null; grandfatheredAt: string | null; familyMembers: number };
    };

const DEAD = new Set(['canceled', 'incomplete_expired']);

function resolveCreatedAt(spec: string): string | null {
  if (spec === 'fresh') return new Date().toISOString();
  const t = Date.parse(spec);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export async function resetBilling(
  db: Kysely<DB>,
  who: { userId?: string; email?: string },
  opts: BillingResetOptions = {},
  fetchFn: typeof fetch = fetch,
): Promise<BillingResetResult> {
  let q = db
    .selectFrom('users')
    .select([
      'id',
      'username',
      'created_at',
      'grandfathered_at',
      'stripe_customer_id',
      'stripe_subscription_id',
      'subscription_plan',
      'subscription_interval',
      'subscription_source',
      'subscription_period_started_at',
      'subscription_current_period_end',
    ]);
  if (who.userId) q = q.where('id', '=', who.userId);
  else if (who.email) q = q.where('email', '=', who.email.trim().toLowerCase());
  else return { ok: false, reason: 'no_user' };
  const row = await q.executeTakeFirst();
  if (!row) return { ok: false, reason: 'no_user' };

  let newCreatedAt: string | null = null;
  if (opts.createdAt) {
    newCreatedAt = resolveCreatedAt(opts.createdAt);
    if (!newCreatedAt) return { ok: false, reason: 'bad_created_at' };
  }

  if (env.STRIPE_SECRET_KEY.startsWith('sk_live_') && !opts.allowLive) return { ok: false, reason: 'live_key' };

  const periodLive =
    !!row.subscription_current_period_end && Date.parse(row.subscription_current_period_end) > Date.now();
  if (row.subscription_source === 'apple' && periodLive && !opts.force) {
    // Only the device can end an App Store subscription; RevenueCat would grant it again.
    return { ok: false, reason: 'apple_active' };
  }

  const stripe = {
    subscriptionId: row.stripe_subscription_id,
    status: null as string | null,
    cancelsAtPeriodEnd: null as boolean | null,
    endedNow: false,
  };
  if (row.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
    const state = await getSubscriptionState(row.stripe_subscription_id, fetchFn);
    if (state) {
      stripe.status = state.status;
      stripe.cancelsAtPeriodEnd = state.cancelAtPeriodEnd;
    }
    const renewing = state !== null && !DEAD.has(state.status) && !state.cancelAtPeriodEnd;
    if (state === null && !opts.force && !opts.cancelInStripe) return { ok: false, reason: 'stripe_unverified' };
    if (renewing && !opts.cancelInStripe && !opts.force) {
      return { ok: false, reason: 'stripe_renewing', stripeStatus: state!.status };
    }
    if (renewing && opts.cancelInStripe && opts.apply) {
      await cancelSubscriptionNow(row.stripe_subscription_id, fetchFn);
      stripe.endedNow = true;
    }
  }

  const changes: BillingChange[] = [];
  const set: Record<string, string | null> = {};
  const clear = (field: keyof typeof row & string) => {
    const from = row[field] as string | null;
    if (from !== null) {
      changes.push({ field, from, to: null });
      set[field] = null;
    }
  };
  clear('stripe_subscription_id');
  clear('subscription_plan');
  clear('subscription_interval');
  clear('subscription_source');
  clear('subscription_period_started_at');
  clear('subscription_current_period_end');
  if (opts.dropCustomer) clear('stripe_customer_id');
  if (opts.clearGrandfather) clear('grandfathered_at');
  if (newCreatedAt && newCreatedAt !== row.created_at) {
    changes.push({ field: 'created_at', from: row.created_at, to: newCreatedAt });
    set.created_at = newCreatedAt;
  }

  if (opts.apply && Object.keys(set).length > 0) {
    await db.updateTable('users').set(set).where('id', '=', row.id).execute();
  }

  const family = await db
    .selectFrom('family_members')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('owner_user_id', '=', row.id)
    .executeTakeFirst();

  return {
    ok: true,
    applied: opts.apply === true,
    userId: row.id,
    username: row.username,
    changes,
    stripe,
    untouched: {
      stripeCustomerId: opts.dropCustomer ? null : row.stripe_customer_id,
      grandfatheredAt: opts.clearGrandfather ? null : row.grandfathered_at,
      familyMembers: Number(family?.n ?? 0),
    },
  };
}
