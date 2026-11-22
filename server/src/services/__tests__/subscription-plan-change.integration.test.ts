/**
 * ADR 0236 — switching a live Stripe subscription to another plan/interval from
 * the app. Only Stripe is stubbed; the user rows, the price table and the route
 * are real. The two things that must hold: the existing item is swapped (never
 * a second subscription) and a repeat of the SAME plan never charges.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { __resetRenewalCacheForTests } from '@/services/stripe.service.js';
import { changePlan } from '@/services/subscription-renewal.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const DAY = 86_400_000;
type E = Record<string, string>;
const setEnv = (k: string, v: string) => ((env as unknown as E)[k] = v);

type Call = { method: string; body: URLSearchParams };

/** Stripe stand-in: GET returns the subscription with one item; POST applies the change. */
function stripeStub(opts: { cancelling?: boolean; postStatus?: number } = {}) {
  const calls: Call[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = new URLSearchParams(String(init?.body ?? ''));
    calls.push({ method, body });
    if (method === 'POST' && opts.postStatus && opts.postStatus >= 400) {
      return new Response(JSON.stringify({ error: { type: 'card_error', message: 'Your card was declined.' } }), {
        status: opts.postStatus,
      });
    }
    return new Response(
      JSON.stringify({
        id: 'sub_live',
        status: 'active',
        cancel_at_period_end: opts.cancelling ?? false,
        items: { data: [{ id: 'si_1' }] },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fn, calls, posts: () => calls.filter((c) => c.method === 'POST') };
}

describe('changing plan from inside the app', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    setEnv('STRIPE_PRICE_ID', 'price_ind_m');
    setEnv('STRIPE_PRICE_ID_YEARLY', 'price_ind_y');
    setEnv('STRIPE_PRICE_ID_FAMILY', 'price_fam_m');
    setEnv('STRIPE_PRICE_ID_FAMILY_YEARLY', 'price_fam_y');
    __resetRenewalCacheForTests();
    db = await openTestDb();
    userId = await createUser(db, 'switcher');
    await db
      .updateTable('users')
      .set({
        stripe_customer_id: 'cus_s',
        stripe_subscription_id: 'sub_live',
        subscription_plan: 'system',
        subscription_interval: 'month',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - 10 * DAY).toISOString(),
        subscription_current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    for (const k of [
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID',
      'STRIPE_PRICE_ID_YEARLY',
      'STRIPE_PRICE_ID_FAMILY',
      'STRIPE_PRICE_ID_FAMILY_YEARLY',
    ]) {
      setEnv(k, '');
    }
    await closeTestDb(db);
  });

  it('swaps the price on the existing item, invoices the difference now, and clears a cancel', async () => {
    const stripe = stripeStub();
    const out = await changePlan(db, userId, 'family', 'year', stripe.fn);

    expect(out).toEqual({ ok: true, plan: 'family', interval: 'year', resumed: false });
    expect(stripe.posts()).toHaveLength(1);
    const post = stripe.posts()[0]!.body;
    expect(post.get('items[0][id]')).toBe('si_1');
    expect(post.get('items[0][price]')).toBe('price_fam_y');
    expect(post.get('proration_behavior')).toBe('always_invoice');
    expect(post.get('payment_behavior')).toBe('error_if_incomplete');
    expect(post.get('cancel_at_period_end')).toBe('false');
    // The screen must not wait for the webhook: the new plan is written at once.
    const row = await db
      .selectFrom('users')
      .select(['subscription_plan', 'subscription_interval'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ subscription_plan: 'family', subscription_interval: 'year' });
  });

  it('the same plan again is refused and charges nothing', async () => {
    const stripe = stripeStub();
    expect(await changePlan(db, userId, 'system', 'month', stripe.fn)).toEqual({ ok: false, reason: 'same_plan' });
    expect(stripe.posts()).toHaveLength(0);
  });

  it('the same plan while it is set to cancel means resume, with no price change', async () => {
    const stripe = stripeStub({ cancelling: true });
    const out = await changePlan(db, userId, 'system', 'month', stripe.fn);
    expect(out).toEqual({ ok: true, plan: 'system', interval: 'month', resumed: true });
    expect(stripe.posts()).toHaveLength(1);
    const post = stripe.posts()[0]!.body;
    expect(post.get('cancel_at_period_end')).toBe('false');
    expect(post.get('items[0][price]')).toBeNull();
  });

  it('a declined card is reported as such and the subscription is left alone', async () => {
    const stripe = stripeStub({ postStatus: 402 });
    expect(await changePlan(db, userId, 'family', 'month', stripe.fn)).toEqual({
      ok: false,
      reason: 'payment_failed',
    });
    const row = await db.selectFrom('users').select('subscription_plan').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(row.subscription_plan).toBe('system');
  });

  it('refuses without a Stripe plan of their own, an unconfigured price, and the BYOK base plan', async () => {
    const stripe = stripeStub();
    const stranger = await createUser(db, 'nobody');
    expect(await changePlan(db, stranger, 'family', 'month', stripe.fn)).toEqual({
      ok: false,
      reason: 'no_subscription',
    });

    setEnv('STRIPE_PRICE_ID_FAMILY_YEARLY', '');
    expect(await changePlan(db, userId, 'family', 'year', stripe.fn)).toEqual({
      ok: false,
      reason: 'billing_unavailable',
    });

    expect(await changePlan(db, userId, 'byok_base', 'month', stripe.fn)).toEqual({
      ok: false,
      reason: 'not_switchable',
    });

    await db.updateTable('users').set({ subscription_source: 'apple' }).where('id', '=', userId).execute();
    expect(await changePlan(db, userId, 'family', 'month', stripe.fn)).toEqual({
      ok: false,
      reason: 'apple',
      source: 'apple',
    });
    expect(stripe.posts()).toHaveLength(0);
  });

  describe('change_subscription_plan (bot tool)', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const ask = async (mode: 'propose' | 'commit') => {
      const personal = (await ensurePersonalGroup(db, userId)).id;
      const res = await applyToolCall(db, {
        groupId: personal,
        actorUserId: userId,
        provenance: null,
        mode,
        turnId: 'turn-1',
        call: { name: 'change_subscription_plan', args: { plan: 'family', interval: 'year' } } as never,
      });
      return { res, personal };
    };

    it('only stages a card when the model calls it - nothing is charged', async () => {
      const stripe = stripeStub();
      globalThis.fetch = stripe.fn;
      const { res, personal } = await ask('propose');
      expect(res.summary).toContain('awaiting confirmation');
      expect(res.card).toMatchObject({ kind: 'action', title: 'Switch to the Family plan, annual' });
      const [p] = await listProposalsForGroup(db, personal);
      expect(p).toMatchObject({ toolName: 'change_subscription_plan', status: 'pending' });
      expect(stripe.calls).toHaveLength(0);
    });

    it('switches the plan once the user has confirmed', async () => {
      const stripe = stripeStub();
      globalThis.fetch = stripe.fn;
      const { res } = await ask('commit');
      expect(res.data).toMatchObject({ ok: true, plan: 'family', interval: 'year', resumed: false });
      expect(stripe.posts()[0]!.body.get('items[0][price]')).toBe('price_fam_y');
    });
  });

  describe('POST /me/billing/plan', () => {
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
      fetch(`${base}${API.meBillingPlan}`, {
        method: 'POST',
        headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('validates the plan and interval, and needs a session', async () => {
      expect((await post({ plan: 'byok_base', interval: 'month' })).status).toBe(400);
      expect((await post({ plan: 'family', interval: 'week' })).status).toBe(400);
      expect((await post({})).status).toBe(400);
      const anon = await fetch(`${base}${API.meBillingPlan}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: 'family', interval: 'year' }),
      });
      expect(anon.status).toBe(401);
    });
  });
});
