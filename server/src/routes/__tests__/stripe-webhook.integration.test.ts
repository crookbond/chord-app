/**
 * ADR 0075/0195/0196 — Stripe subscription webhook + checkout routes over
 * the real app. Keyless: signatures are computed locally with the same HMAC
 * scheme Stripe uses. Covers the two-event flow: `checkout.session.completed`
 * links stripe_customer_id only, `invoice.paid` records the period's bounds
 * — ADR 0196: that IS the grant/renewal, there's no separate balance write.
 * "Balance" is verified through `getEntitlement`, which computes it from
 * `token_usage`, not read off a stored column.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getEntitlement } from '@/services/billing.service.js';
import { signStripePayload } from '@/services/stripe.service.js';
import { recordTokenUsage } from '@/services/tokens.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

// ADR 0325 — these tests are about the plans' own rules (and back-date accounts
// to step past the old 30-day trial). The one-time free allowance would cover
// every gated case here, so it is switched off; billing-free-allowance covers it.
const savedFreeAllowance = env.FREE_TOKEN_ALLOWANCE;
beforeEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = 0;
});
afterEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = savedFreeAllowance;
});

const SECRET = 'whsec_route_test';

function checkoutCompletedEvent(sessionId: string, userId: string | null, customerId: string): string {
  return JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        mode: 'subscription',
        client_reference_id: userId,
        customer: customerId,
        subscription: `sub_${sessionId}`,
      },
    },
  });
}

// Defaults are relative to "now" — a fixed unix constant drifts into the
// past or future as real time passes, and a period START must stay behind
// "now" (or usage recorded during the test falls outside the window) while
// the period END must stay ahead of it (or the subscription reads lapsed).
const DEFAULT_PERIOD_START = () => Math.floor(Date.now() / 1000) - 5 * 86_400;
const DEFAULT_PERIOD_END = () => Math.floor(Date.now() / 1000) + 25 * 86_400;

function invoicePaidEvent(
  invoiceId: string,
  customerId: string | null,
  priceId: string | null,
  periodStartUnix = DEFAULT_PERIOD_START(),
  periodEndUnix = DEFAULT_PERIOD_END(),
): string {
  return JSON.stringify({
    type: 'invoice.paid',
    data: {
      object: {
        id: invoiceId,
        customer: customerId,
        subscription: 'sub_x',
        lines: priceId
          ? { data: [{ price: { id: priceId }, period: { start: periodStartUnix, end: periodEndUnix } }] }
          : { data: [] },
      },
    },
  });
}

describe('POST /api/v1/webhooks/stripe + /me/billing/checkout', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;

  beforeEach(async () => {
    (env as { STRIPE_WEBHOOK_SECRET: string }).STRIPE_WEBHOOK_SECRET = SECRET;
    (env as { STRIPE_PRICE_ID: string }).STRIPE_PRICE_ID = 'price_system';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'stripe-subscriber');
    // Clear of the 30-day trial window so getEntitlement exercises the
    // subscription path, not the trial one.
    await db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    (env as { STRIPE_WEBHOOK_SECRET: string }).STRIPE_WEBHOOK_SECRET = '';
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    (env as { STRIPE_PRICE_ID: string }).STRIPE_PRICE_ID = '';
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = '';
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const post = (body: string, sig?: string) =>
    fetch(`${base}${API.webhookStripe}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(sig ? { 'stripe-signature': sig } : {}),
      },
      body,
    });

  const userRow = async () =>
    db
      .selectFrom('users')
      .select([
        'stripe_customer_id',
        'stripe_subscription_id',
        'subscription_plan',
        'subscription_period_started_at',
        'subscription_current_period_end',
      ])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  it('links the customer on checkout, then invoice.paid records the period; entitlement computes the full allowance', async () => {
    const checkout = checkoutCompletedEvent('cs_int_1', userId, 'cus_1');
    const linkRes = await post(checkout, signStripePayload(checkout, SECRET));
    expect(linkRes.status).toBe(200);
    let row = await userRow();
    expect(row.stripe_customer_id).toBe('cus_1');
    expect(row.subscription_plan).toBeNull(); // checkout links only, never grants
    expect((await getEntitlement(db, userId)).entitled).toBe(false);

    const periodStart = DEFAULT_PERIOD_START();
    const periodEnd = DEFAULT_PERIOD_END();
    const invoice = invoicePaidEvent('in_1', 'cus_1', 'price_system', periodStart, periodEnd);
    const grantRes = await post(invoice, signStripePayload(invoice, SECRET));
    expect(grantRes.status).toBe(200);
    row = await userRow();
    expect(row.subscription_plan).toBe('system');
    expect(row.subscription_period_started_at).toBe(new Date(periodStart * 1000).toISOString());
    expect(row.subscription_current_period_end).toBe(new Date(periodEnd * 1000).toISOString());
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE);

    // Replay of the same invoice — naturally idempotent, writes the same values.
    const replay = await post(invoice, signStripePayload(invoice, SECRET));
    expect(replay.status).toBe(200);
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE);
  });

  it('a renewal invoice advances the period start, so old usage stops counting — no rollover', async () => {
    const checkout = checkoutCompletedEvent('cs_int_r', userId, 'cus_r');
    await post(checkout, signStripePayload(checkout, SECRET));
    const first = invoicePaidEvent('in_r1', 'cus_r', 'price_system');
    await post(first, signStripePayload(first, SECRET));

    // Spend some of this period's allowance (simulating real turns/passes).
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: 'spend-1',
      model: 'gpt-x',
      promptTokens: 1234,
      completionTokens: 0,
    });
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 1234);

    // Renewal: a NEW period, starting after that spend.
    const nextStart = Math.floor(Date.now() / 1000) + 1000;
    const renewal = invoicePaidEvent('in_r2', 'cus_r', 'price_system', nextStart, nextStart + 30 * 86_400);
    await post(renewal, signStripePayload(renewal, SECRET));
    // Full allowance again — the earlier spend falls before the new period
    // and was neither carried forward nor added on top of a fresh grant.
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE);
  });

  it('a BYOK base-plan invoice sets subscription state but never grants a token balance', async () => {
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
    const checkout = checkoutCompletedEvent('cs_int_byok', userId, 'cus_byok');
    await post(checkout, signStripePayload(checkout, SECRET));
    const invoice = invoicePaidEvent('in_byok', 'cus_byok', 'price_byok');
    const res = await post(invoice, signStripePayload(invoice, SECRET));
    expect(res.status).toBe(200);
    const row = await userRow();
    expect(row.subscription_plan).toBe('byok_base');
    // The BYOK path never reads token_usage at all — balance stays 0.
    expect((await getEntitlement(db, userId)).balance).toBe(0);
  });

  it('rejects a bad signature and an unset secret', async () => {
    const body = checkoutCompletedEvent('cs_int_2', userId, 'cus_2');
    const bad = await post(body, signStripePayload(body, 'whsec_wrong'));
    expect(bad.status).toBe(401);

    (env as { STRIPE_WEBHOOK_SECRET: string }).STRIPE_WEBHOOK_SECRET = '';
    const off = await post(body, signStripePayload(body, SECRET));
    expect(off.status).toBe(404);
  });

  it('200-no-ops other event types and an unrecognized price', async () => {
    for (const body of [
      JSON.stringify({ type: 'customer.subscription.updated' }),
      invoicePaidEvent('in_ghost_price', 'cus_1', 'price_unknown'),
    ]) {
      const res = await post(body, signStripePayload(body, SECRET));
      expect(res.status).toBe(200);
    }
    expect((await userRow()).subscription_plan).toBeNull();
  });

  // Prod 2026-11-04: a trial user paid; Stripe delivered invoice.paid 250 ms
  // BEFORE checkout.session.completed. The webhook answered 200 for the
  // unlinked customer, Stripe never resent it, no plan was recorded - and even
  // once recorded the card said "Free trial" with no way to cancel.
  const PROD_CUSTOMER = 'cus_VZFztV22N90PTD';
  const PROD_INVOICE = 'in_1UY7TWJgrAQrlLt5SdIMz7MB';
  const basilInvoice = (metadataUserId: string | null) =>
    JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: PROD_INVOICE,
          customer: PROD_CUSTOMER,
          parent: {
            subscription_details: {
              subscription: 'sub_prod',
              metadata: metadataUserId ? { userId: metadataUserId } : {},
            },
          },
          lines: {
            data: [
              {
                pricing: { type: 'price_details', price_details: { price: 'price_system' } },
                period: { start: DEFAULT_PERIOD_START(), end: DEFAULT_PERIOD_END() },
              },
            ],
          },
        },
      },
    });
  // ADR 0325 — still on the free allowance (it replaced the trial), so the
  // test proves the paid plan is what is reported over it.
  const inTrial = async () => {
    (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = 10_000_000;
    await db.updateTable('users').set({ created_at: new Date().toISOString() }).where('id', '=', userId).execute();
    expect((await getEntitlement(db, userId)).reason).toBe('free');
  };

  it('invoice.paid ahead of checkout: the subscription metadata names the user, and the paid plan beats the free allowance', async () => {
    await inTrial();
    const invoice = basilInvoice(userId);
    const res = await post(invoice, signStripePayload(invoice, SECRET));
    expect(res.status).toBe(200);
    const row = await userRow();
    expect(row.stripe_customer_id).toBe(PROD_CUSTOMER);
    expect(row.subscription_plan).toBe('system');

    const checkout = checkoutCompletedEvent('cs_prod', userId, PROD_CUSTOMER);
    expect((await post(checkout, signStripePayload(checkout, SECRET))).status).toBe(200);

    const ent = await getEntitlement(db, userId);
    expect(ent).toMatchObject({ entitled: true, reason: 'tokens', plan: 'system', source: 'stripe' });
    expect(ent.periodEnd).toBeTruthy();
  });

  it('invoice.paid ahead of checkout with no metadata (older sessions): 500 so Stripe retries, then it grants', async () => {
    await inTrial();
    const invoice = basilInvoice(null);
    expect((await post(invoice, signStripePayload(invoice, SECRET))).status).toBe(500);
    expect((await userRow()).subscription_plan).toBeNull();

    const checkout = checkoutCompletedEvent('cs_prod', userId, PROD_CUSTOMER);
    await post(checkout, signStripePayload(checkout, SECRET));
    expect((await post(invoice, signStripePayload(invoice, SECRET))).status).toBe(200);
    expect((await getEntitlement(db, userId)).reason).toBe('tokens');
  });

  it('checkout route: 400 on a missing/invalid plan, 503 when unconfigured, 401 without a session', async () => {
    const token = newId('t');
    const now = new Date().toISOString();
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
      .execute();

    const noAuth = await fetch(`${base}${API.meBillingCheckout}`, { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const badPlan = await fetch(`${base}${API.meBillingCheckout}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'enterprise' }),
    });
    expect(badPlan.status).toBe(400);

    const unconfigured = await fetch(`${base}${API.meBillingCheckout}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'system' }),
    });
    expect(unconfigured.status).toBe(503);

    // BYOK base plan is independently unconfigured (STRIPE_PRICE_ID_BYOK unset).
    const byokUnconfigured = await fetch(`${base}${API.meBillingCheckout}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
      body: JSON.stringify({ plan: 'byok_base' }),
    });
    expect(byokUnconfigured.status).toBe(503);
  });
});
