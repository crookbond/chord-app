/**
 * ADR 0236 — cancel (and resume) from inside Chord. The Stripe call is the only
 * thing stubbed; the user rows, the entitlement rules and the route are real.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { __resetRenewalCacheForTests } from '@/services/stripe.service.js';
import { renewalStatus, setRenewal } from '@/services/subscription-renewal.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const DAY = 86_400_000;

type Call = { url: string; method: string; body: string; auth: string };

/** A Stripe stand-in that remembers what it was asked and answers like the API. */
function stripeStub(opts: { status?: number; cancelAtPeriodEnd?: boolean } = {}) {
  const calls: Call[] = [];
  let cancels = opts.cancelAtPeriodEnd ?? false;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body,
      auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? ''),
    });
    if (opts.status && opts.status >= 400) {
      return new Response(JSON.stringify({ error: { message: 'No such subscription' } }), { status: opts.status });
    }
    if (init?.method === 'POST') cancels = new URLSearchParams(body).get('cancel_at_period_end') === 'true';
    return new Response(JSON.stringify({ id: 'sub_live', cancel_at_period_end: cancels }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('cancelling and resuming a subscription from the app', () => {
  let db: Kysely<DB>;
  let userId: string;
  const periodEnd = new Date(Date.now() + 20 * DAY).toISOString();

  beforeEach(async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    __resetRenewalCacheForTests();
    db = await openTestDb();
    userId = await createUser(db, 'payer');
    await db
      .updateTable('users')
      .set({
        stripe_customer_id: 'cus_payer',
        stripe_subscription_id: 'sub_live',
        subscription_plan: 'system',
        subscription_interval: 'month',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - 10 * DAY).toISOString(),
        subscription_current_period_end: periodEnd,
        created_at: new Date(Date.now() - 90 * DAY).toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    await closeTestDb(db);
  });

  it('cancel asks Stripe to end the subscription at the period end, never now', async () => {
    const stripe = stripeStub();
    const out = await setRenewal(db, userId, false, stripe.fn);

    expect(out).toEqual({ ok: true, cancelsAtPeriodEnd: true, periodEnd });
    expect(stripe.calls).toHaveLength(1);
    expect(stripe.calls[0]).toMatchObject({
      url: 'https://api.stripe.com/v1/subscriptions/sub_live',
      method: 'POST',
      auth: 'Bearer sk_test_x',
    });
    expect(new URLSearchParams(stripe.calls[0]!.body).get('cancel_at_period_end')).toBe('true');
    // The paid period is untouched: the plan keeps working until it ends.
    const row = await db
      .selectFrom('users')
      .select(['subscription_plan', 'subscription_current_period_end'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ subscription_plan: 'system', subscription_current_period_end: periodEnd });
  });

  it('resume turns renewal back on', async () => {
    const stripe = stripeStub({ cancelAtPeriodEnd: true });
    const out = await setRenewal(db, userId, true, stripe.fn);
    expect(out).toEqual({ ok: true, cancelsAtPeriodEnd: false, periodEnd });
    expect(new URLSearchParams(stripe.calls[0]!.body).get('cancel_at_period_end')).toBe('false');
  });

  it('refuses an App Store subscription without calling Stripe', async () => {
    await db.updateTable('users').set({ subscription_source: 'apple' }).where('id', '=', userId).execute();
    const stripe = stripeStub();
    expect(await setRenewal(db, userId, false, stripe.fn)).toEqual({
      ok: false,
      reason: 'apple',
      source: 'apple',
    });
    expect(stripe.calls).toHaveLength(0);
  });

  it('has nothing to cancel for someone with no live plan of their own', async () => {
    const stripe = stripeStub();
    const other = await createUser(db, 'covered');
    expect(await setRenewal(db, other, false, stripe.fn)).toEqual({ ok: false, reason: 'no_subscription' });
    // A lapsed plan is not cancellable either.
    await db
      .updateTable('users')
      .set({ subscription_current_period_end: new Date(Date.now() - DAY).toISOString() })
      .where('id', '=', userId)
      .execute();
    expect(await setRenewal(db, userId, false, stripe.fn)).toEqual({ ok: false, reason: 'no_subscription' });
    expect(stripe.calls).toHaveLength(0);
  });

  it('reports a Stripe failure as a failure, so nothing is claimed cancelled', async () => {
    const stripe = stripeStub({ status: 404 });
    expect(await setRenewal(db, userId, false, stripe.fn)).toEqual({ ok: false, reason: 'stripe_error' });
  });

  it('shows the live cancel state on the plan, and says nothing when Stripe cannot be reached', async () => {
    expect(await renewalStatus(db, userId, stripeStub({ cancelAtPeriodEnd: true }).fn)).toBe(true);
    __resetRenewalCacheForTests();
    expect(await renewalStatus(db, userId, stripeStub({ cancelAtPeriodEnd: false }).fn)).toBe(false);
    __resetRenewalCacheForTests();
    expect(await renewalStatus(db, userId, stripeStub({ status: 500 }).fn)).toBeUndefined();
  });

  it('getBillingStatus carries cancelsAtPeriodEnd once the user has cancelled', async () => {
    const real = globalThis.fetch;
    const stripe = stripeStub();
    globalThis.fetch = stripe.fn;
    try {
      await setRenewal(db, userId, false, stripe.fn);
      const status = await getBillingStatus(db, userId);
      expect(status.cancelsAtPeriodEnd).toBe(true);
      expect(status.periodEnd).toBe(periodEnd);
    } finally {
      globalThis.fetch = real;
    }
  });

  describe('POST /me/billing/renewal', () => {
    let server: http.Server;
    let base: string;
    let token: string;

    beforeEach(async () => {
      server = http.createServer(buildApp(db));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      token = newId('t');
      const now = new Date().toISOString();
      await db.insertInto('sessions').values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now }).execute();
    });
    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const post = (body: unknown) =>
      fetch(`${base}${API.meBillingRenewal}`, {
        method: 'POST',
        headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('needs a session and a boolean', async () => {
      const anon = await fetch(`${base}${API.meBillingRenewal}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ renew: false }),
      });
      expect(anon.status).toBe(401);
      expect((await post({})).status).toBe(400);
      expect((await post({ renew: 'no' })).status).toBe(400);
    });

    it('answers 409 for an App Store plan and 404 for no plan', async () => {
      await db.updateTable('users').set({ subscription_source: 'apple' }).where('id', '=', userId).execute();
      const apple = await post({ renew: false });
      expect(apple.status).toBe(409);
      expect(await apple.json()).toMatchObject({ error: 'apple' });

      await db
        .updateTable('users')
        .set({ subscription_plan: null, subscription_current_period_end: null })
        .where('id', '=', userId)
        .execute();
      expect((await post({ renew: false })).status).toBe(404);
    });
  });
});
