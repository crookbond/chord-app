/**
 * ADR 0231 — the two selling channels over the real app: Stripe (annual and
 * family prices, a promo-code trial) and the App Store via RevenueCat. Both
 * land on the same `users` columns, so the assertions are about what
 * `getEntitlement` then says, not about the plumbing.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { familyTokenAllowance, getEntitlement } from '@/services/billing.service.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { checkPromoCode, generatePromoCodes } from '@/services/promo.service.js';
import { signStripePayload } from '@/services/stripe.service.js';
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

const WH = 'whsec_family_test';
const RC = 'rc_secret_test';
const DAY = 86_400_000;

type E = Record<string, string>;
const setEnv = (k: string, v: string) => ((env as unknown as E)[k] = v);

function invoice(priceId: string, customer: string, startMs: number, endMs: number, extraLines: object[] = []): string {
  return JSON.stringify({
    type: 'invoice.paid',
    data: {
      object: {
        id: `in_${Math.random().toString(36).slice(2)}`,
        customer,
        subscription: 'sub_x',
        lines: {
          data: [
            ...extraLines,
            { price: { id: priceId }, period: { start: Math.floor(startMs / 1000), end: Math.floor(endMs / 1000) } },
          ],
        },
      },
    },
  });
}

function checkoutCompleted(userId: string, customer: string, metadata: Record<string, string>): string {
  return JSON.stringify({
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${Math.random().toString(36).slice(2)}`,
        mode: 'subscription',
        client_reference_id: userId,
        customer,
        subscription: 'sub_y',
        metadata,
      },
    },
  });
}

describe('selling channels: Stripe and RevenueCat', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;

  beforeEach(async () => {
    setEnv('STRIPE_WEBHOOK_SECRET', WH);
    setEnv('STRIPE_SECRET_KEY', 'sk_test_x');
    setEnv('STRIPE_PRICE_ID', 'price_ind_m');
    setEnv('STRIPE_PRICE_ID_YEARLY', 'price_ind_y');
    setEnv('STRIPE_PRICE_ID_FAMILY', 'price_fam_m');
    setEnv('STRIPE_PRICE_ID_FAMILY_YEARLY', 'price_fam_y');
    setEnv('REVENUECAT_WEBHOOK_SECRET', RC);
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'buyer');
    await db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 90 * DAY).toISOString(), stripe_customer_id: 'cus_buyer' })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    for (const k of [
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SECRET_KEY',
      'STRIPE_PRICE_ID',
      'STRIPE_PRICE_ID_YEARLY',
      'STRIPE_PRICE_ID_FAMILY',
      'STRIPE_PRICE_ID_FAMILY_YEARLY',
      'STRIPE_PRICE_ID_BYOK',
      'REVENUECAT_WEBHOOK_SECRET',
    ]) {
      setEnv(k, '');
    }
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const stripePost = (body: string) =>
    fetch(`${base}${API.webhookStripe}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signStripePayload(body, WH) },
      body,
    });

  const rcPost = (event: object, auth: string | null = `Bearer ${RC}`) =>
    fetch(`${base}${API.webhookRevenueCat}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({ event }),
    });

  const row = () =>
    db
      .selectFrom('users')
      .select([
        'subscription_plan',
        'subscription_interval',
        'subscription_source',
        'subscription_period_started_at',
        'subscription_current_period_end',
      ])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

  describe('Stripe', () => {
    it('an annual family invoice records plan, interval and source, and the owner has the family pool', async () => {
      const inv = invoice('price_fam_y', 'cus_buyer', Date.now() - DAY, Date.now() + 364 * DAY);
      expect((await stripePost(inv)).status).toBe(200);
      expect(await row()).toMatchObject({
        subscription_plan: 'family',
        subscription_interval: 'year',
        subscription_source: 'stripe',
      });
      expect(await getEntitlement(db, userId)).toMatchObject({
        reason: 'tokens',
        plan: 'family',
        balance: familyTokenAllowance(),
      });
    });

    it('a plan change through the portal bills proration lines first — the subscription line wins, not the credit', async () => {
      const credit = { price: { id: 'price_ind_m' }, proration: true, period: { start: 1, end: 2 } };
      const inv = invoice('price_fam_m', 'cus_buyer', Date.now() - DAY, Date.now() + 29 * DAY, [credit]);
      await stripePost(inv);
      expect((await row()).subscription_plan).toBe('family');
    });

    // The invoice a SAME-interval switch inside the paid period produces has no
    // full-price line at all - only a credit for the old price's unused time and a
    // charge for the new price's remaining time. Reading the first line resolved
    // the OLD plan, so the switch was undone by its own invoice.
    describe('a switch inside the paid period (proration lines only)', () => {
      const periodStart = Math.floor((Date.now() - 10 * DAY) / 1000);
      const switchedAt = Math.floor(Date.now() / 1000);
      const periodEnd = Math.floor((Date.now() + 20 * DAY) / 1000);
      const credit = {
        amount: -533,
        pricing: { type: 'price_details', price_details: { price: 'price_ind_m' } },
        parent: { type: 'subscription_item_details', subscription_item_details: { proration: true } },
        period: { start: switchedAt, end: periodEnd },
      };
      const charge = {
        amount: 1666,
        pricing: { type: 'price_details', price_details: { price: 'price_fam_m' } },
        parent: { type: 'subscription_item_details', subscription_item_details: { proration: true } },
        period: { start: switchedAt, end: periodEnd },
      };
      const prorationInvoice = (lines: object[]) =>
        JSON.stringify({
          type: 'invoice.paid',
          data: {
            object: {
              id: `in_${Math.random().toString(36).slice(2)}`,
              customer: 'cus_buyer',
              parent: { subscription_details: { subscription: 'sub_x' } },
              lines: { data: lines },
            },
          },
        });

      beforeEach(async () => {
        await db
          .updateTable('users')
          .set({
            subscription_plan: 'system',
            subscription_interval: 'month',
            subscription_source: 'stripe',
            subscription_period_started_at: new Date(periodStart * 1000).toISOString(),
            subscription_current_period_end: new Date(periodEnd * 1000).toISOString(),
          })
          .where('id', '=', userId)
          .execute();
      });

      it.each([
        ['credit listed first', () => [credit, charge]],
        ['charge listed first', () => [charge, credit]],
      ])('moves the plan to the NEW price, %s', async (_name, lines) => {
        expect((await stripePost(prorationInvoice(lines()))).status).toBe(200);
        expect(await row()).toMatchObject({
          subscription_plan: 'family',
          subscription_interval: 'month',
          subscription_source: 'stripe',
        });
      });

      it('keeps the allowance window where it was, so a switch is not a fresh allowance', async () => {
        await stripePost(prorationInvoice([credit, charge]));
        const r = await row();
        expect(r.subscription_period_started_at).toBe(new Date(periodStart * 1000).toISOString());
        expect(r.subscription_current_period_end).toBe(new Date(periodEnd * 1000).toISOString());
      });
    });

    it('a checkout with a promo code opens the free period at once and burns the code', async () => {
      const [code] = await generatePromoCodes(db, { count: 1, trialDays: 30 });
      const body = checkoutCompleted(userId, 'cus_buyer', {
        plan: 'system',
        interval: 'month',
        promoCode: code!,
        promoTrialDays: '30',
      });
      expect((await stripePost(body)).status).toBe(200);

      const r = await row();
      expect(r).toMatchObject({ subscription_plan: 'system', subscription_source: 'stripe' });
      const days = (Date.parse(r.subscription_current_period_end!) - Date.parse(r.subscription_period_started_at!)) / DAY;
      expect(Math.round(days)).toBe(30);
      expect((await getEntitlement(db, userId)).entitled).toBe(true);
      expect(await checkPromoCode(db, code!)).toEqual({ ok: false, reason: 'code_used' });

      // The first real invoice replaces the free period; a re-delivery of the
      // checkout event doesn't shrink or reset anything.
      // One timestamp, reused: reading the clock again in the assertion fails
      // whenever a second boundary passes between the invoice and the check.
      const realEnd = Date.now() + 59 * DAY;
      const real = invoice('price_ind_m', 'cus_buyer', Date.now() + 29 * DAY, realEnd);
      await stripePost(real);
      await stripePost(body);
      expect((await row()).subscription_current_period_end).toBe(
        new Date(Math.floor(realEnd / 1000) * 1000).toISOString(),
      );
    });

    it('a checkout with no promo code grants nothing — only an invoice does', async () => {
      await stripePost(checkoutCompleted(userId, 'cus_buyer', { plan: 'system', interval: 'month' }));
      expect((await row()).subscription_plan).toBeNull();
    });
  });

  describe('checkout and portal routes', () => {
    let token: string;
    beforeEach(async () => {
      token = newId('t');
      const now = new Date().toISOString();
      await db.insertInto('sessions').values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now }).execute();
    });
    const call = (path: string, body: object) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { [SESSION_HEADER]: token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('rejects an invalid interval and an unconfigured (plan, interval)', async () => {
      expect((await call(API.meBillingCheckout, { plan: 'system', interval: 'week' })).status).toBe(400);
      setEnv('STRIPE_PRICE_ID_FAMILY_YEARLY', '');
      expect((await call(API.meBillingCheckout, { plan: 'family', interval: 'year' })).status).toBe(503);
    });

    it('refuses a second subscription on top of a live one, naming the seller', async () => {
      await stripePost(invoice('price_ind_m', 'cus_buyer', Date.now() - DAY, Date.now() + 29 * DAY));
      const res = await call(API.meBillingCheckout, { plan: 'family', interval: 'month' });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: 'already_subscribed', source: 'stripe', plan: 'system' });
    });

    it('answers a bad, used or expired promo code before any Stripe call is made', async () => {
      expect(await (await call(API.meBillingCheckout, { plan: 'system', code: 'CHORD-AAAA-BBBB' })).json()).toEqual({
        error: 'invalid_code',
      });
      const [used] = await generatePromoCodes(db, { count: 1 });
      await db.updateTable('promo_codes').set({ redeemed_at: new Date().toISOString() }).where('code', '=', used!).execute();
      expect((await call(API.meBillingCheckout, { plan: 'system', code: used })).status).toBe(400);
    });

    it('has no portal for a user with no Stripe customer, or an App Store subscriber', async () => {
      await db.updateTable('users').set({ stripe_customer_id: null }).where('id', '=', userId).execute();
      expect((await call(API.meBillingPortal, {})).status).toBe(404);
      await db
        .updateTable('users')
        .set({ stripe_customer_id: 'cus_buyer', subscription_source: 'apple' })
        .where('id', '=', userId)
        .execute();
      const res = await call(API.meBillingPortal, {});
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ source: 'apple' });
    });
  });

  describe('RevenueCat (App Store)', () => {
    const purchase = (type: string, over: Record<string, unknown> = {}) => ({
      type,
      id: `evt_${Math.random().toString(36).slice(2)}`,
      app_user_id: userId,
      product_id: env.APPLE_PRODUCT_FAMILY_YEARLY,
      purchased_at_ms: Date.now() - DAY,
      expiration_at_ms: Date.now() + 364 * DAY,
      ...over,
    });

    it('is shared-secret authenticated and 404s when unconfigured', async () => {
      expect((await rcPost(purchase('INITIAL_PURCHASE'), null)).status).toBe(401);
      expect((await rcPost(purchase('INITIAL_PURCHASE'), 'Bearer nope')).status).toBe(401);
      setEnv('REVENUECAT_WEBHOOK_SECRET', '');
      expect((await rcPost(purchase('INITIAL_PURCHASE'))).status).toBe(404);
    });

    it('a purchase writes the same columns Stripe does, and the entitlement follows', async () => {
      expect((await rcPost(purchase('INITIAL_PURCHASE'))).status).toBe(200);
      expect(await row()).toMatchObject({
        subscription_plan: 'family',
        subscription_interval: 'year',
        subscription_source: 'apple',
      });
      expect(await getEntitlement(db, userId)).toMatchObject({ reason: 'tokens', plan: 'family', source: 'apple' });
    });

    it('a cancellation changes nothing — the paid period runs to its end', async () => {
      await rcPost(purchase('INITIAL_PURCHASE'));
      await rcPost(purchase('CANCELLATION'));
      expect((await getEntitlement(db, userId)).entitled).toBe(true);
    });

    it('an expiration closes the period; a late one for an older period does not cut a renewal', async () => {
      const oldEnd = Date.now() + 5 * DAY;
      await rcPost(purchase('INITIAL_PURCHASE', { product_id: env.APPLE_PRODUCT_INDIVIDUAL_MONTHLY, expiration_at_ms: oldEnd }));
      // The renewal moved the end out...
      await rcPost(
        purchase('RENEWAL', {
          product_id: env.APPLE_PRODUCT_INDIVIDUAL_MONTHLY,
          purchased_at_ms: oldEnd,
          expiration_at_ms: oldEnd + 30 * DAY,
        }),
      );
      // ...so the old period's EXPIRATION arriving afterwards is stale.
      await rcPost({ type: 'EXPIRATION', id: 'e1', app_user_id: userId, expiration_at_ms: oldEnd });
      expect((await getEntitlement(db, userId)).entitled).toBe(true);

      // A genuine expiration (the current period's own end) closes it.
      await rcPost({ type: 'EXPIRATION', id: 'e2', app_user_id: userId, expiration_at_ms: oldEnd + 30 * DAY });
      await db.updateTable('users').set({ subscription_current_period_end: new Date(Date.now() - 1000).toISOString() }).where('id', '=', userId).execute();
      expect((await getEntitlement(db, userId)).entitled).toBe(false);
    });

    it('an expiration never closes a subscription Stripe sold', async () => {
      await stripePost(invoice('price_ind_m', 'cus_buyer', Date.now() - DAY, Date.now() + 29 * DAY));
      await rcPost({ type: 'EXPIRATION', id: 'e3', app_user_id: userId, expiration_at_ms: Date.now() - 1000 });
      expect((await getEntitlement(db, userId)).entitled).toBe(true);
    });

    it('ignores an anonymous RevenueCat id, an unknown product and an unknown user — all 200, nothing written', async () => {
      expect((await rcPost(purchase('INITIAL_PURCHASE', { app_user_id: '$RCAnonymousID:abc' }))).status).toBe(200);
      expect((await rcPost(purchase('INITIAL_PURCHASE', { product_id: 'something.else' }))).status).toBe(200);
      expect((await rcPost(purchase('INITIAL_PURCHASE', { app_user_id: 'u_ghost' }))).status).toBe(200);
      expect((await row()).subscription_plan).toBeNull();
    });

    // ADR 0238 - the bring-your-own-key base plan is sold in the app like the
    // others, so it needs an App Store product and an entitlement that says
    // when it ends (the plan card renders Cancel / Manage from that).
    describe('the BYOK base plan', () => {
      beforeEach(async () => {
        setEnv('STRIPE_PRICE_ID_BYOK', 'price_byok');
        await db
          .updateTable('users')
          .set({ model_key_ciphertext: Buffer.from('k') })
          .where('id', '=', userId)
          .execute();
      });

      it('a purchase of its product turns "owes the base fee" into a live BYOK plan', async () => {
        expect((await getEntitlement(db, userId)).reason).toBe('byok_unpaid');
        const end = Date.now() + 29 * DAY;
        const res = await rcPost(
          purchase('INITIAL_PURCHASE', { product_id: env.APPLE_PRODUCT_BYOK_MONTHLY, expiration_at_ms: end }),
        );
        expect(res.status).toBe(200);
        expect(await row()).toMatchObject({
          subscription_plan: 'byok_base',
          subscription_interval: 'month',
          subscription_source: 'apple',
        });
        expect(await getEntitlement(db, userId)).toMatchObject({
          entitled: true,
          reason: 'byok',
          plan: 'byok_base',
          interval: 'month',
          source: 'apple',
          periodEnd: new Date(end).toISOString(),
        });
      });

      it('its expiration closes it again, and the status offers the price and the product', async () => {
        const end = Date.now() + 29 * DAY;
        await rcPost(purchase('INITIAL_PURCHASE', { product_id: env.APPLE_PRODUCT_BYOK_MONTHLY, expiration_at_ms: end }));
        await rcPost({ type: 'EXPIRATION', id: 'ex_byok', app_user_id: userId, expiration_at_ms: end });
        await db
          .updateTable('users')
          .set({ subscription_current_period_end: new Date(Date.now() - 1000).toISOString() })
          .where('id', '=', userId)
          .execute();
        expect((await getEntitlement(db, userId)).reason).toBe('byok_unpaid');
        expect(await getBillingStatus(db, userId)).toMatchObject({
          byokPriceUsd: env.PRICE_BYOK_USD,
          appleByokProduct: env.APPLE_PRODUCT_BYOK_MONTHLY,
          appleAvailable: true,
        });
      });
    });

    it('a product change reads the NEW product', async () => {
      // From an ANNUAL plan to a monthly one: the new period ends sooner than
      // the one it replaces, which is not a reason to call it stale.
      await rcPost(purchase('INITIAL_PURCHASE', { product_id: env.APPLE_PRODUCT_INDIVIDUAL_YEARLY }));
      await rcPost(
        purchase('PRODUCT_CHANGE', {
          product_id: env.APPLE_PRODUCT_INDIVIDUAL_YEARLY,
          new_product_id: env.APPLE_PRODUCT_FAMILY_MONTHLY,
          purchased_at_ms: Date.now(),
          expiration_at_ms: Date.now() + 30 * DAY,
        }),
      );
      expect(await row()).toMatchObject({ subscription_plan: 'family', subscription_interval: 'month' });
      // ...while a late re-delivery of the original purchase does not undo it.
      await rcPost(purchase('INITIAL_PURCHASE', { product_id: env.APPLE_PRODUCT_INDIVIDUAL_YEARLY }));
      expect((await row()).subscription_plan).toBe('family');
    });
  });
});
