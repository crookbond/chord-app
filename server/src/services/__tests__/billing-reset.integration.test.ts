/**
 * ADR 0236 addendum — the operator reset for one account's billing. The point
 * of the guard under test: clearing our columns must never leave a Stripe
 * subscription that would renew and re-grant the plan.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getEntitlement } from '@/services/billing.service.js';
import { resetBilling } from '@/services/billing-reset.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

type Call = { method: string; url: string };

function stripeStub(sub: { status: string; cancel_at_period_end?: boolean } | 'down') {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) });
    if (sub === 'down') return new Response('{}', { status: 500 });
    return new Response(JSON.stringify({ id: 'sub_old', ...sub }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('resetBilling', () => {
  let db: Kysely<DB>;
  let userId: string;
  const periodEnd = new Date(Date.now() + 12 * DAY).toISOString();
  const oldCreated = new Date(Date.now() - 90 * DAY).toISOString();

  beforeEach(async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db
      .updateTable('users')
      .set({
        email: 'john@example.com',
        created_at: oldCreated,
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_old',
        subscription_plan: 'system',
        subscription_interval: 'month',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - 18 * DAY).toISOString(),
        subscription_current_period_end: periodEnd,
      })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    await closeTestDb(db);
  });

  const row = () =>
    db
      .selectFrom('users')
      .select([
        'stripe_customer_id',
        'stripe_subscription_id',
        'subscription_plan',
        'subscription_interval',
        'subscription_source',
        'subscription_period_started_at',
        'subscription_current_period_end',
        'created_at',
      ])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  it('is a dry run unless asked, and says what it would clear', async () => {
    const stripe = stripeStub({ status: 'active', cancel_at_period_end: true });
    const out = await resetBilling(db, { email: 'John@Example.com' }, {}, stripe.fn);
    expect(out.ok && out.applied).toBe(false);
    expect(out.ok && out.changes.map((c) => c.field)).toEqual([
      'stripe_subscription_id',
      'subscription_plan',
      'subscription_interval',
      'subscription_source',
      'subscription_period_started_at',
      'subscription_current_period_end',
    ]);
    expect((await row()).subscription_plan).toBe('system');
  });

  it('clears a cancelled subscription so the account has no plan, and keeps the customer', async () => {
    const stripe = stripeStub({ status: 'active', cancel_at_period_end: true });
    const out = await resetBilling(db, { userId }, { apply: true }, stripe.fn);

    expect(out.ok && out.applied).toBe(true);
    expect(await row()).toMatchObject({
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: null,
      subscription_plan: null,
      subscription_interval: null,
      subscription_source: null,
      subscription_period_started_at: null,
      subscription_current_period_end: null,
    });
    // Nothing to renew, so nothing was sent to Stripe except the read.
    expect(stripe.calls.map((c) => c.method)).toEqual(['GET']);
    // The entitlement no longer comes from a plan.
    const ent = await getEntitlement(db, userId);
    expect(ent.plan).toBeFalsy();
    expect(ent.reason).not.toBe('tokens');
  });

  it('refuses while Stripe will still renew, and changes nothing', async () => {
    const stripe = stripeStub({ status: 'active', cancel_at_period_end: false });
    const out = await resetBilling(db, { userId }, { apply: true }, stripe.fn);
    expect(out).toEqual({ ok: false, reason: 'stripe_renewing', stripeStatus: 'active' });
    expect((await row()).subscription_plan).toBe('system');
    expect(stripe.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('ends a renewing subscription in Stripe when told to, then clears', async () => {
    const stripe = stripeStub({ status: 'active', cancel_at_period_end: false });
    const out = await resetBilling(db, { userId }, { apply: true, cancelInStripe: true }, stripe.fn);
    expect(out.ok && out.stripe.endedNow).toBe(true);
    expect(stripe.calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect((await row()).subscription_plan).toBeNull();
  });

  it('a dry run never ends anything in Stripe', async () => {
    const stripe = stripeStub({ status: 'active', cancel_at_period_end: false });
    await resetBilling(db, { userId }, { cancelInStripe: true }, stripe.fn);
    expect(stripe.calls.map((c) => c.method)).toEqual(['GET']);
    expect((await row()).subscription_plan).toBe('system');
  });

  it('treats an already-cancelled Stripe subscription as safe', async () => {
    const stripe = stripeStub({ status: 'canceled' });
    const out = await resetBilling(db, { userId }, { apply: true }, stripe.fn);
    expect(out.ok).toBe(true);
    expect((await row()).subscription_plan).toBeNull();
  });

  it('will not guess when Stripe cannot be asked, unless forced', async () => {
    const down = stripeStub('down');
    expect(await resetBilling(db, { userId }, { apply: true }, down.fn)).toEqual({
      ok: false,
      reason: 'stripe_unverified',
    });
    expect((await row()).subscription_plan).toBe('system');
    const forced = await resetBilling(db, { userId }, { apply: true, force: true }, down.fn);
    expect(forced.ok).toBe(true);
    expect((await row()).subscription_plan).toBeNull();
  });

  it('refuses a live Stripe key, and an App Store plan that is still paid up', async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_live_x';
    expect(await resetBilling(db, { userId }, { apply: true }, stripeStub({ status: 'canceled' }).fn)).toEqual({
      ok: false,
      reason: 'live_key',
    });
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    await db.updateTable('users').set({ subscription_source: 'apple' }).where('id', '=', userId).execute();
    expect(await resetBilling(db, { userId }, { apply: true }, stripeStub({ status: 'canceled' }).fn)).toEqual({
      ok: false,
      reason: 'apple_active',
    });
  });

  it('optionally drops the customer, removes grandfathering, and moves the sign-up time', async () => {
    await db.updateTable('users').set({ grandfathered_at: new Date().toISOString() }).where('id', '=', userId).execute();
    const stripe = stripeStub({ status: 'canceled' });
    const out = await resetBilling(
      db,
      { userId },
      { apply: true, dropCustomer: true, clearGrandfather: true, createdAt: '2026-01-02T03:04:05.000Z' },
      stripe.fn,
    );
    expect(out.ok).toBe(true);
    const after = await row();
    expect(after.stripe_customer_id).toBeNull();
    const g = await db.selectFrom('users').select('grandfathered_at').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(g.grandfathered_at).toBeNull();
    expect(after.created_at).toBe('2026-01-02T03:04:05.000Z');
    expect(out.ok && out.changes.find((c) => c.field === 'created_at')?.from).toBe(oldCreated);
  });

  it('reports unknown users and bad dates without writing', async () => {
    expect(await resetBilling(db, { email: 'nobody@example.com' }, {}, stripeStub('down').fn)).toEqual({
      ok: false,
      reason: 'no_user',
    });
    // 'ended' moved the old 30-day trial; a date cannot end the ADR 0325 free allowance.
    for (const createdAt of ['sometime', 'ended']) {
      expect(await resetBilling(db, { userId }, { createdAt }, stripeStub('down').fn)).toEqual({
        ok: false,
        reason: 'bad_created_at',
      });
    }
  });
});
