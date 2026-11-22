/**
 * Keyless Stripe unit tests (ADR 0075/0195): signature verification with
 * locally computed HMACs, event narrowing for both webhook events the
 * subscription flow reacts to, and the checkout-create request shape via
 * an injected fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import {
  createBillingPortalSession,
  createSubscriptionCheckoutSession,
  parseInvoicePaid,
  parseSubscriptionCheckoutCompleted,
  planForPriceId,
  signStripePayload,
  subscriptionCheckoutEnabled,
  verifyStripeSignature,
} from '@/services/stripe.service.js';

const SECRET = 'whsec_test_secret';

describe('verifyStripeSignature', () => {
  const body = JSON.stringify({ type: 'checkout.session.completed' });

  it('accepts a freshly signed payload', () => {
    const sig = signStripePayload(body, SECRET);
    expect(verifyStripeSignature(body, sig, { secret: SECRET })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signStripePayload(body, SECRET);
    expect(verifyStripeSignature(body + ' ', sig, { secret: SECRET })).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const sig = signStripePayload(body, 'whsec_other');
    expect(verifyStripeSignature(body, sig, { secret: SECRET })).toBe(false);
  });

  it('rejects a stale timestamp (replay window)', () => {
    const old = Date.now() - 10 * 60 * 1000;
    const sig = signStripePayload(body, SECRET, old);
    expect(verifyStripeSignature(body, sig, { secret: SECRET })).toBe(false);
    // …but the same signature is valid when "now" is close to signing time.
    expect(verifyStripeSignature(body, sig, { secret: SECRET, nowMs: old + 1000 })).toBe(true);
  });

  it('rejects malformed headers and missing secret', () => {
    expect(verifyStripeSignature(body, undefined, { secret: SECRET })).toBe(false);
    expect(verifyStripeSignature(body, 't=abc,v1=', { secret: SECRET })).toBe(false);
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET), { secret: '' })).toBe(false);
  });

  it('accepts when any one of multiple v1 signatures matches (secret roll)', () => {
    const good = signStripePayload(body, SECRET);
    const [t, v1] = good.split(',');
    const rolled = `${t},v1=deadbeef,${v1}`;
    expect(verifyStripeSignature(body, rolled, { secret: SECRET })).toBe(true);
  });
});

describe('parseSubscriptionCheckoutCompleted', () => {
  it('narrows a completed subscription checkout with customer + subscription ids', () => {
    const raw = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          mode: 'subscription',
          client_reference_id: 'u_1',
          customer: 'cus_1',
          subscription: 'sub_1',
        },
      },
    });
    expect(parseSubscriptionCheckoutCompleted(raw)).toEqual({
      sessionId: 'cs_123',
      userId: 'u_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      plan: null,
      interval: null,
      promoCode: null,
      promoTrialDays: null,
    });
  });

  it('falls back to metadata.userId', () => {
    const raw = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_9',
          mode: 'subscription',
          client_reference_id: null,
          customer: 'cus_9',
          subscription: 'sub_9',
          metadata: { userId: 'u_9' },
        },
      },
    });
    expect(parseSubscriptionCheckoutCompleted(raw)?.userId).toBe('u_9');
  });

  it('returns null for a non-subscription session, other event types, and junk', () => {
    const oneTime = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_pay', mode: 'payment' } },
    });
    expect(parseSubscriptionCheckoutCompleted(oneTime)).toBeNull();
    expect(parseSubscriptionCheckoutCompleted(JSON.stringify({ type: 'invoice.paid' }))).toBeNull();
    expect(parseSubscriptionCheckoutCompleted('not json')).toBeNull();
  });
});

describe('parseInvoicePaid', () => {
  it('narrows a paid invoice with price id and period bounds', () => {
    const raw = JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_1',
          customer: 'cus_1',
          subscription: 'sub_1',
          lines: { data: [{ price: { id: 'price_system' }, period: { start: 1733011200, end: 1735689600 } }] },
        },
      },
    });
    expect(parseInvoicePaid(raw)).toEqual({
      invoiceId: 'in_1',
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      userId: null,
      priceId: 'price_system',
      periodStart: new Date(1733011200 * 1000).toISOString(),
      periodEnd: new Date(1735689600 * 1000).toISOString(),
      prorationOnly: false,
    });
  });

  it('returns null for other event types, junk, and a line with no period', () => {
    expect(parseInvoicePaid(JSON.stringify({ type: 'checkout.session.completed' }))).toBeNull();
    expect(parseInvoicePaid('not json')).toBeNull();
    const noLines = JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_2' } } });
    expect(parseInvoicePaid(noLines)).toEqual({
      invoiceId: 'in_2',
      customerId: null,
      subscriptionId: null,
      userId: null,
      priceId: null,
      periodStart: null,
      periodEnd: null,
      prorationOnly: false,
    });
  });
});

describe('parseInvoicePaid with a plan change', () => {
  it('reads the subscription line, not the proration credit billed beside it', () => {
    const raw = JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_change',
          customer: 'cus_1',
          subscription: 'sub_1',
          lines: {
            data: [
              { price: { id: 'price_old' }, proration: true, period: { start: 1700000000, end: 1700100000 } },
              { price: { id: 'price_new' }, proration: false, period: { start: 1700100000, end: 1702700000 } },
            ],
          },
        },
      },
    });
    expect(parseInvoicePaid(raw)?.priceId).toBe('price_new');
  });
});

describe('parseInvoicePaid on a plan switch inside the paid period (ADR 0236)', () => {
  const line = (price: string, amount: number) => ({
    amount,
    pricing: { type: 'price_details', price_details: { price } },
    parent: { type: 'subscription_item_details', subscription_item_details: { proration: true } },
    period: { start: 1_700_000_000, end: 1_702_600_000 },
  });
  const inv = (lines: object[]) =>
    JSON.stringify({
      type: 'invoice.paid',
      data: { object: { id: 'in_sw', customer: 'cus_1', lines: { data: lines } } },
    });

  it('reads the charge for the new price, not the credit for the old one, whichever is listed first', () => {
    for (const lines of [
      [line('price_old', -533), line('price_new', 1666)],
      [line('price_new', 1666), line('price_old', -533)],
    ]) {
      const out = parseInvoicePaid(inv(lines));
      expect(out?.priceId).toBe('price_new');
      expect(out?.prorationOnly).toBe(true);
    }
  });

  it('a regular full-price line still wins and is not proration-only', () => {
    const regular = { amount: 8789, price: { id: 'price_yearly' }, period: { start: 1, end: 2 } };
    const out = parseInvoicePaid(inv([line('price_old', -533), regular]));
    expect(out?.priceId).toBe('price_yearly');
    expect(out?.prorationOnly).toBe(false);
  });

  it('with no positive line (a fully discounted price) it takes the last, which is the new price', () => {
    const out = parseInvoicePaid(inv([line('price_old', -533), line('price_new', 0)]));
    expect(out?.priceId).toBe('price_new');
  });
});

describe('parseInvoicePaid on the 2025-03-31.basil and later shape', () => {
  // The shape this account's webhook destination sends (API 2026-06-24.dahlia):
  // no `price` or `proration` on a line, no `subscription` on the invoice.
  const invoice = (lines: object[], extra: object = {}) =>
    JSON.stringify({
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_new',
          customer: 'cus_1',
          parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } },
          lines: { data: lines },
          ...extra,
        },
      },
    });
  const line = (price: string, start: number, end: number, parent: object = {}) => ({
    pricing: { type: 'price_details', price_details: { price, product: 'prod_x' } },
    period: { start, end },
    parent: { type: 'subscription_item_details', subscription_item_details: { proration: false, ...parent } },
  });

  it('reads the price from pricing.price_details and the subscription from the parent', () => {
    const out = parseInvoicePaid(invoice([line('price_family_m', 1700000000, 1702700000)]));
    expect(out).toEqual({
      invoiceId: 'in_new',
      customerId: 'cus_1',
      subscriptionId: 'sub_new',
      userId: null,
      priceId: 'price_family_m',
      periodStart: new Date(1700000000 * 1000).toISOString(),
      periodEnd: new Date(1702700000 * 1000).toISOString(),
      prorationOnly: false,
    });
  });

  it('reads the user id from the subscription metadata Stripe copies onto the invoice', () => {
    const raw = invoice([line('price_family_m', 1700000000, 1702700000)], {
      parent: {
        type: 'subscription_details',
        subscription_details: { subscription: 'sub_new', metadata: { userId: 'u_EcC7M-7bT4oZ' } },
      },
    });
    expect(parseInvoicePaid(raw)?.userId).toBe('u_EcC7M-7bT4oZ');
  });

  it('still skips a proration line, now flagged under the line parent', () => {
    const out = parseInvoicePaid(
      invoice([
        line('price_old', 1700000000, 1700100000, { proration: true }),
        line('price_new', 1700100000, 1702700000),
      ]),
    );
    expect(out?.priceId).toBe('price_new');
  });

  it('accepts an expanded price object and an expanded subscription', () => {
    const raw = invoice(
      [
        {
          pricing: { type: 'price_details', price_details: { price: { id: 'price_exp' } } },
          period: { start: 1700000000, end: 1702700000 },
        },
      ],
      { parent: { type: 'subscription_details', subscription_details: { subscription: { id: 'sub_exp' } } } },
    );
    const out = parseInvoicePaid(raw);
    expect(out?.priceId).toBe('price_exp');
    expect(out?.subscriptionId).toBe('sub_exp');
  });

  it('an invoice with no parent subscription still parses, with no subscription id', () => {
    const raw = invoice([line('price_x', 1700000000, 1702700000)], { parent: null });
    expect(parseInvoicePaid(raw)?.subscriptionId).toBeNull();
  });
});

describe('createBillingPortalSession', () => {
  it('posts the customer and a return url, and surfaces a Stripe error', async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    (env as { WEB_ORIGIN: string }).WEB_ORIGIN = 'https://chordapp.ai';
    try {
      let captured: { url: string; body: string } | null = null;
      const ok = (async (u: unknown, init?: RequestInit) => {
        captured = { url: String(u), body: String(init?.body) };
        return new Response(JSON.stringify({ url: 'https://billing.stripe.com/s' }), { status: 200 });
      }) as typeof fetch;
      expect(await createBillingPortalSession('cus_7', 'web', ok)).toEqual({ url: 'https://billing.stripe.com/s' });
      expect(captured!.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
      const params = new URLSearchParams(captured!.body);
      expect(params.get('customer')).toBe('cus_7');
      expect(params.get('return_url')).toBe('https://chordapp.ai/settings');

      await createBillingPortalSession('cus_7', 'native', ok);
      expect(new URLSearchParams(captured!.body).get('return_url')).toBe('chord://settings');

      const bad = (async () =>
        new Response(JSON.stringify({ error: { message: 'no configuration' } }), { status: 400 })) as typeof fetch;
      await expect(createBillingPortalSession('cus_7', 'web', bad)).rejects.toThrow(/no configuration/);
    } finally {
      (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
      (env as { WEB_ORIGIN: string }).WEB_ORIGIN = '';
    }
  });
});

describe('createSubscriptionCheckoutSession', () => {
  beforeEach(() => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    (env as { STRIPE_PRICE_ID: string }).STRIPE_PRICE_ID = 'price_system';
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = 'price_byok';
    (env as { WEB_ORIGIN: string }).WEB_ORIGIN = 'https://chordapp.ai';
  });
  afterEach(() => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    (env as { STRIPE_PRICE_ID: string }).STRIPE_PRICE_ID = '';
    (env as { STRIPE_PRICE_ID_BYOK: string }).STRIPE_PRICE_ID_BYOK = '';
    (env as { WEB_ORIGIN: string }).WEB_ORIGIN = '';
  });

  it('POSTs a subscription-mode session for the system plan', async () => {
    let captured: { url: string; body: string; auth: string } | null = null;
    const fetchFn = (async (url: unknown, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: String(init?.body),
        auth: String((init?.headers as Record<string, string>).authorization),
      };
      return new Response(JSON.stringify({ id: 'cs_new', url: 'https://checkout.stripe.com/x' }), {
        status: 200,
      });
    }) as typeof fetch;

    const out = await createSubscriptionCheckoutSession('u_42', 'system', 'month', 'web', fetchFn);
    expect(out).toEqual({ url: 'https://checkout.stripe.com/x', sessionId: 'cs_new' });
    expect(captured!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(captured!.auth).toBe('Bearer sk_test_x');
    const params = new URLSearchParams(captured!.body);
    expect(params.get('mode')).toBe('subscription');
    expect(params.get('line_items[0][price]')).toBe('price_system');
    expect(params.get('client_reference_id')).toBe('u_42');
    expect(params.get('metadata[plan]')).toBe('system');
    expect(params.get('subscription_data[metadata][userId]')).toBe('u_42');
    expect(params.get('success_url')).toBe('https://chordapp.ai/settings?checkout=success');
    expect(params.get('cancel_url')).toBe('https://chordapp.ai/settings?checkout=cancel');
  });

  it('uses the BYOK base-plan price for that plan', async () => {
    let captured: string | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body);
      return new Response(JSON.stringify({ id: 'cs_byok', url: 'https://checkout.stripe.com/y' }), {
        status: 200,
      });
    }) as typeof fetch;

    await createSubscriptionCheckoutSession('u_43', 'byok_base', 'month', 'web', fetchFn);
    const params = new URLSearchParams(captured!);
    expect(params.get('line_items[0][price]')).toBe('price_byok');
    expect(params.get('metadata[plan]')).toBe('byok_base');
  });

  it('deep-links success/cancel back into the app for a native checkout', async () => {
    let captured: string | null = null;
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body);
      return new Response(JSON.stringify({ id: 'cs_native', url: 'https://checkout.stripe.com/z' }), {
        status: 200,
      });
    }) as typeof fetch;

    await createSubscriptionCheckoutSession('u_44', 'system', 'month', 'native', fetchFn);
    const params = new URLSearchParams(captured!);
    expect(params.get('success_url')).toBe('chord://settings?checkout=success');
    expect(params.get('cancel_url')).toBe('chord://settings?checkout=cancel');
  });

  it('picks the price for each (plan, interval) and refuses one that is not configured', async () => {
    (env as { STRIPE_PRICE_ID_YEARLY: string }).STRIPE_PRICE_ID_YEARLY = 'price_ind_y';
    (env as { STRIPE_PRICE_ID_FAMILY: string }).STRIPE_PRICE_ID_FAMILY = 'price_fam_m';
    try {
      expect(subscriptionCheckoutEnabled('system', 'year')).toBe(true);
      expect(subscriptionCheckoutEnabled('family', 'month')).toBe(true);
      // No family annual price set in this test: not offered.
      expect(subscriptionCheckoutEnabled('family', 'year')).toBe(false);
      // BYOK has no annual price at all.
      expect(subscriptionCheckoutEnabled('byok_base', 'year')).toBe(false);
      expect(planForPriceId('price_ind_y')).toEqual({ plan: 'system', interval: 'year' });
      expect(planForPriceId('price_fam_m')).toEqual({ plan: 'family', interval: 'month' });
      expect(planForPriceId('price_byok')).toEqual({ plan: 'byok_base', interval: 'month' });
      expect(planForPriceId('price_unknown')).toBeNull();
      expect(planForPriceId(null)).toBeNull();

      let captured = '';
      const fetchFn = (async (_u: unknown, init?: RequestInit) => {
        captured = String(init?.body);
        return new Response(JSON.stringify({ id: 'cs_f', url: 'https://checkout.stripe.com/f' }), { status: 200 });
      }) as typeof fetch;
      await createSubscriptionCheckoutSession('u_9', 'family', 'month', 'web', fetchFn);
      const params = new URLSearchParams(captured);
      expect(params.get('line_items[0][price]')).toBe('price_fam_m');
      expect(params.get('metadata[plan]')).toBe('family');
      expect(params.get('metadata[interval]')).toBe('month');
      // No promo, no customer: neither is sent.
      expect(params.has('subscription_data[trial_period_days]')).toBe(false);
      expect(params.has('customer')).toBe(false);
    } finally {
      (env as { STRIPE_PRICE_ID_YEARLY: string }).STRIPE_PRICE_ID_YEARLY = '';
      (env as { STRIPE_PRICE_ID_FAMILY: string }).STRIPE_PRICE_ID_FAMILY = '';
    }
  });

  it('a promo code becomes a trial on the subscription, and an existing customer is reused', async () => {
    let captured = '';
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      captured = String(init?.body);
      return new Response(JSON.stringify({ id: 'cs_p', url: 'https://checkout.stripe.com/p' }), { status: 200 });
    }) as typeof fetch;
    await createSubscriptionCheckoutSession('u_5', 'system', 'month', 'web', fetchFn, {
      customerId: 'cus_existing',
      promo: { code: 'CHORD-ABCD-EFGH', trialDays: 30 },
    });
    const params = new URLSearchParams(captured);
    expect(params.get('subscription_data[trial_period_days]')).toBe('30');
    expect(params.get('metadata[promoCode]')).toBe('CHORD-ABCD-EFGH');
    expect(params.get('metadata[promoTrialDays]')).toBe('30');
    expect(params.get('customer')).toBe('cus_existing');
    // The card is still collected up front: nothing here switches that off.
    expect(params.has('payment_method_collection')).toBe(false);
  });

  it('throws on a Stripe error response', async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ error: { message: 'no such price' } }), { status: 400 })) as typeof fetch;
    await expect(createSubscriptionCheckoutSession('u_1', 'system', 'month', 'web', fetchFn)).rejects.toThrow(
      /no such price/,
    );
  });
});
