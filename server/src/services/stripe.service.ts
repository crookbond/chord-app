/**
 * Stripe checkout without the SDK (ADR 0075/0195). A few operations only:
 *   - create a subscription Checkout Session (one form-encoded POST to
 *     api.stripe.com)
 *   - verify webhook signatures (HMAC-SHA256 over `${t}.${rawBody}`, the
 *     `v1=` scheme — same shape as the Slack verify in
 *     connectors/slack/slack.connector.ts, replay-window + timingSafeEqual)
 *   - parse the two events the ADR 0195 subscription flow reacts to:
 *     `checkout.session.completed` (customer/subscription identity linking
 *     only — no grant here, see webhooks.ts) and `invoice.paid` (the single
 *     grant/renewal choke point, fires for the first period and every
 *     renewal alike)
 * Keeping it SDK-free keeps the dependency surface flat and every test
 * runnable with zero Stripe keys; all Stripe knowledge lives here, so the
 * SDK can be swapped in later without touching routes.
 */
import crypto from 'node:crypto';

import { env } from '../config/env.js';

const STRIPE_API = 'https://api.stripe.com/v1';
/** Reject events whose timestamp is further than this from now (replay guard). */
const SIGNATURE_TOLERANCE_S = 300;

/** ADR 0195/0231 — which Stripe price a checkout/invoice is for. */
export type SubscriptionPlan = 'system' | 'family' | 'byok_base';
export type BillingInterval = 'month' | 'year';

export function stripeWebhookEnabled(): boolean {
  return env.STRIPE_WEBHOOK_SECRET.length > 0;
}

/** ADR 0231 — every price this deploy can sell, as (plan, interval) pairs.
 *  Read at call time (tests set env after import). BYOK has no annual price. */
function priceTable(): Array<{ plan: SubscriptionPlan; interval: BillingInterval; priceId: string }> {
  return [
    { plan: 'system', interval: 'month', priceId: env.STRIPE_PRICE_ID },
    { plan: 'system', interval: 'year', priceId: env.STRIPE_PRICE_ID_YEARLY },
    { plan: 'family', interval: 'month', priceId: env.STRIPE_PRICE_ID_FAMILY },
    { plan: 'family', interval: 'year', priceId: env.STRIPE_PRICE_ID_FAMILY_YEARLY },
    { plan: 'byok_base', interval: 'month', priceId: env.STRIPE_PRICE_ID_BYOK },
  ];
}

function priceIdFor(plan: SubscriptionPlan, interval: BillingInterval): string {
  return priceTable().find((p) => p.plan === plan && p.interval === interval)?.priceId ?? '';
}

/** Which (plan, interval) a Stripe price id is, or null for a price this
 *  deploy doesn't recognize (a removed price, or an unrelated product). */
export function planForPriceId(
  priceId: string | null,
): { plan: SubscriptionPlan; interval: BillingInterval } | null {
  if (!priceId) return null;
  const hit = priceTable().find((p) => p.priceId && p.priceId === priceId);
  return hit ? { plan: hit.plan, interval: hit.interval } : null;
}

/** Checkout is offered for a (plan, interval) only once its price is actually
 *  configured — ADR 0195: BYOK stays free (today's behavior) until
 *  STRIPE_PRICE_ID_BYOK is set; ADR 0231: same rule for each of the others. */
export function subscriptionCheckoutEnabled(
  plan: SubscriptionPlan,
  interval: BillingInterval = 'month',
): boolean {
  return env.STRIPE_SECRET_KEY.length > 0 && priceIdFor(plan, interval).length > 0;
}

/** Web origin for success/cancel redirects: WEB_ORIGIN, else SIGNUP_URL's origin. */
export function webOrigin(): string {
  if (env.WEB_ORIGIN) return env.WEB_ORIGIN.replace(/\/$/, '');
  try {
    return new URL(env.SIGNUP_URL).origin;
  } catch {
    return '';
  }
}

/** The app's own custom URL scheme (mobile/app.json `expo.scheme`) — already
 *  used for the Google-reconnect deep link (`chord://settings?reconnect=…`).
 *  Stripe explicitly supports a non-https success/cancel URL for native apps. */
const NATIVE_RETURN_BASE = 'chord://settings';

export type CheckoutPlatform = 'web' | 'native';

/** Where Stripe sends the browser after checkout. Native deep-links straight
 *  back into the app so the in-app browser session (opened via
 *  `WebBrowser.openAuthSessionAsync`) auto-closes on this redirect instead of
 *  stranding the user on a page they have to manually dismiss. */
function returnUrl(outcome: 'success' | 'cancel', platform: CheckoutPlatform): string {
  const base = platform === 'native' ? NATIVE_RETURN_BASE : `${webOrigin()}/settings`;
  return `${base}?checkout=${outcome}`;
}

type FetchFn = typeof fetch;

/**
 * Create a hosted Checkout Session for a recurring subscription (ADR 0195 —
 * `mode: 'payment'` retired with the one-time bundle it was for). Returns
 * the URL the client opens in a browser. `client_reference_id` carries the
 * Chord user id back on `checkout.session.completed`, which uses it only to
 * link `stripe_customer_id` — the actual token grant happens on `invoice.paid`.
 */
export async function createSubscriptionCheckoutSession(
  userId: string,
  plan: SubscriptionPlan,
  interval: BillingInterval = 'month',
  platform: CheckoutPlatform = 'web',
  fetchFn: FetchFn = fetch,
  opts: {
    /** ADR 0231 — reuse the buyer's Stripe customer so a re-subscribe lands on
     *  the same customer the billing portal already manages. */
    customerId?: string | null;
    /** ADR 0231 — a promo code: the subscription starts with this many free
     *  days (a trial; the card is still taken now). Burned on completion. */
    promo?: { code: string; trialDays: number } | null;
  } = {},
): Promise<{ url: string; sessionId: string }> {
  const body = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': priceIdFor(plan, interval),
    'line_items[0][quantity]': '1',
    client_reference_id: userId,
    'metadata[userId]': userId,
    'metadata[plan]': plan,
    'metadata[interval]': interval,
    // Copied by Stripe onto every invoice of the subscription, so invoice.paid
    // can name the user even when it arrives before checkout.session.completed
    // (which it does: prod saw it 250 ms ahead).
    'subscription_data[metadata][userId]': userId,
    success_url: returnUrl('success', platform),
    cancel_url: returnUrl('cancel', platform),
  });
  if (opts.customerId) body.set('customer', opts.customerId);
  if (opts.promo) {
    body.set('subscription_data[trial_period_days]', String(opts.promo.trialDays));
    body.set('metadata[promoCode]', opts.promo.code);
    body.set('metadata[promoTrialDays]', String(opts.promo.trialDays));
  }
  const res = await fetchFn(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    url?: string;
    error?: { message?: string };
  };
  if (!res.ok || !json.url || !json.id) {
    throw new Error(`stripe checkout create failed (${res.status}): ${json.error?.message ?? ''}`);
  }
  return { url: json.url, sessionId: json.id };
}

/**
 * ADR 0231 — Stripe's hosted billing portal: change plan, update the card,
 * cancel. Needs the portal configured once in the Stripe dashboard (Settings →
 * Billing → Customer portal); without it Stripe answers 400 and this throws.
 */
export async function createBillingPortalSession(
  customerId: string,
  platform: CheckoutPlatform = 'web',
  fetchFn: FetchFn = fetch,
): Promise<{ url: string }> {
  const body = new URLSearchParams({
    customer: customerId,
    return_url: platform === 'native' ? NATIVE_RETURN_BASE : `${webOrigin()}/settings`,
  });
  const res = await fetchFn(`${STRIPE_API}/billing_portal/sessions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
  if (!res.ok || !json.url) {
    throw new Error(`stripe billing portal create failed (${res.status}): ${json.error?.message ?? ''}`);
  }
  return { url: json.url };
}

const renewalCache = new Map<string, { at: number; cancels: boolean }>();
const RENEWAL_CACHE_MS = 20_000;

/**
 * ADR 0236 — stop (`renew: false`) or resume (`renew: true`) a subscription's
 * renewal at the end of the paid period. Stripe keeps the subscription active
 * until then, so nothing here touches entitlement: the period-end check
 * (ADR 0195) already ends access when no further invoice is paid.
 */
export async function setSubscriptionRenewal(
  subscriptionId: string,
  renew: boolean,
  fetchFn: FetchFn = fetch,
): Promise<{ cancelsAtPeriodEnd: boolean }> {
  const res = await fetchFn(`${STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ cancel_at_period_end: renew ? 'false' : 'true' }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
    cancel_at_period_end?: boolean;
    error?: { message?: string };
  };
  if (!res.ok || typeof json.cancel_at_period_end !== 'boolean') {
    throw new Error(`stripe subscription update failed (${res.status}): ${json.error?.message ?? ''}`);
  }
  renewalCache.set(subscriptionId, { at: Date.now(), cancels: json.cancel_at_period_end });
  return { cancelsAtPeriodEnd: json.cancel_at_period_end };
}

/**
 * Whether a subscription is set to end at its period end, read live because a
 * cancel can also happen in Stripe's portal, which Chord is never told about
 * (no `customer.subscription.updated` handler). Best effort: null = unknown.
 */
export async function getSubscriptionCancelsAtPeriodEnd(
  subscriptionId: string,
  fetchFn: FetchFn = fetch,
): Promise<boolean | null> {
  const hit = renewalCache.get(subscriptionId);
  if (hit && Date.now() - hit.at < RENEWAL_CACHE_MS) return hit.cancels;
  try {
    const res = await fetchFn(`${STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { cancel_at_period_end?: boolean; cancel_at?: number | null };
    const cancels = json.cancel_at_period_end === true || typeof json.cancel_at === 'number';
    renewalCache.set(subscriptionId, { at: Date.now(), cancels });
    return cancels;
  } catch {
    return null;
  }
}

/**
 * ADR 0236 — move a live subscription to another price in place. The price is
 * swapped on the existing item (no second subscription, so nothing bills
 * twice), the difference is invoiced NOW (`always_invoice`, so the plan changes
 * when the user presses the button rather than at the next renewal), and a
 * subscription that was set to cancel is resumed. `error_if_incomplete`
 * makes a declined card an error instead of a half-applied change.
 */
export async function changeSubscriptionPlan(
  subscriptionId: string,
  plan: SubscriptionPlan,
  interval: BillingInterval,
  fetchFn: FetchFn = fetch,
): Promise<{ paymentFailed: boolean }> {
  const priceId = priceIdFor(plan, interval);
  if (!priceId) throw new Error('stripe price not configured');
  const headers = { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` };
  const url = `${STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`;
  const current = await fetchFn(url, { headers });
  const sub = (await current.json().catch(() => ({}))) as {
    items?: { data?: Array<{ id?: string }> };
    error?: { message?: string };
  };
  const itemId = sub.items?.data?.[0]?.id;
  if (!current.ok || !itemId) {
    throw new Error(`stripe subscription read failed (${current.status}): ${sub.error?.message ?? 'no item'}`);
  }
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'items[0][id]': itemId,
      'items[0][price]': priceId,
      proration_behavior: 'always_invoice',
      payment_behavior: 'error_if_incomplete',
      cancel_at_period_end: 'false',
    }).toString(),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string } };
    if (res.status === 402 || json.error?.type === 'card_error') return { paymentFailed: true };
    throw new Error(`stripe plan change failed (${res.status}): ${json.error?.message ?? ''}`);
  }
  renewalCache.delete(subscriptionId);
  return { paymentFailed: false };
}

/** The subscription's status, for the operator billing reset. null = unknown. */
export async function getSubscriptionState(
  subscriptionId: string,
  fetchFn: FetchFn = fetch,
): Promise<{ status: string; cancelAtPeriodEnd: boolean } | null> {
  try {
    const res = await fetchFn(`${STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      cancel_at_period_end?: boolean;
      cancel_at?: number | null;
    };
    if (typeof json.status !== 'string') return null;
    return {
      status: json.status,
      cancelAtPeriodEnd: json.cancel_at_period_end === true || typeof json.cancel_at === 'number',
    };
  } catch {
    return null;
  }
}

/** End a subscription immediately (operator reset only - the app never does). */
export async function cancelSubscriptionNow(subscriptionId: string, fetchFn: FetchFn = fetch): Promise<void> {
  const res = await fetchFn(`${STRIPE_API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`stripe subscription cancel failed (${res.status}): ${json.error?.message ?? ''}`);
  }
  renewalCache.delete(subscriptionId);
}

/** Test seam: drop the live-read cache between cases. */
export function __resetRenewalCacheForTests(): void {
  renewalCache.clear();
}

/**
 * Verify a `Stripe-Signature` header against the raw request body.
 * Header shape: `t=<unix>,v1=<hex>[,v1=<hex>…]` — any valid v1 passes
 * (Stripe sends multiples during secret rolls).
 */
export function verifyStripeSignature(
  rawBody: string,
  sigHeader: string | undefined,
  opts: { secret?: string; nowMs?: number } = {},
): boolean {
  const secret = opts.secret ?? env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return false;
  const parts = new Map<string, string[]>();
  for (const kv of sigHeader.split(',')) {
    const [k, v] = kv.split('=', 2).map((s) => s?.trim());
    if (!k || !v) continue;
    const arr = parts.get(k) ?? [];
    arr.push(v);
    parts.set(k, arr);
  }
  const t = Number(parts.get('t')?.[0]);
  const v1s = parts.get('v1') ?? [];
  if (!Number.isFinite(t) || v1s.length === 0) return false;
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  return v1s.some((v1) => {
    const got = Buffer.from(v1, 'utf8');
    return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
  });
}

/** Test helper — build a valid `Stripe-Signature` header for a payload. */
export function signStripePayload(rawBody: string, secret: string, nowMs = Date.now()): string {
  const t = Math.floor(nowMs / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export interface CompletedSubscriptionCheckout {
  sessionId: string;
  userId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  /** ADR 0231 — the plan chosen, and the promo code (with its free days) if
   *  one was applied. */
  plan: SubscriptionPlan | null;
  interval: BillingInterval | null;
  promoCode: string | null;
  promoTrialDays: number | null;
}

/**
 * Narrow a verified event body to a completed subscription checkout —
 * identity-linking only (ADR 0195: `invoice.paid` does the actual grant).
 * Null for every other event type or a non-subscription session (the
 * webhook 200s those as no-ops).
 */
export function parseSubscriptionCheckoutCompleted(rawBody: string): CompletedSubscriptionCheckout | null {
  let evt: unknown;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const e = evt as {
    type?: string;
    data?: {
      object?: {
        id?: string;
        mode?: string;
        client_reference_id?: string | null;
        customer?: string | null;
        subscription?: string | null;
        metadata?: {
          userId?: string;
          plan?: string;
          interval?: string;
          promoCode?: string;
          promoTrialDays?: string;
        };
      };
    };
  };
  if (e.type !== 'checkout.session.completed') return null;
  const s = e.data?.object;
  if (!s?.id || s.mode !== 'subscription') return null;
  return {
    sessionId: s.id,
    userId: s.client_reference_id ?? s.metadata?.userId ?? null,
    customerId: s.customer ?? null,
    subscriptionId: s.subscription ?? null,
    plan:
      s.metadata?.plan === 'system' || s.metadata?.plan === 'family' || s.metadata?.plan === 'byok_base'
        ? s.metadata.plan
        : null,
    interval: s.metadata?.interval === 'month' || s.metadata?.interval === 'year' ? s.metadata.interval : null,
    promoCode: s.metadata?.promoCode ?? null,
    promoTrialDays: Number.isFinite(Number(s.metadata?.promoTrialDays)) ? Number(s.metadata?.promoTrialDays) : null,
  };
}

export interface PaidInvoice {
  invoiceId: string;
  customerId: string | null;
  subscriptionId: string | null;
  /** The Chord user id from the subscription's metadata (set at checkout),
   *  for an invoice that arrives before its customer is linked. */
  userId: string | null;
  priceId: string | null;
  /** ISO — start of the period this invoice paid for (ADR 0196: what
   *  "usage since" is computed from). */
  periodStart: string | null;
  /** ISO — end of the period this invoice paid for. */
  periodEnd: string | null;
  /** ADR 0236 — every line was a proration: a plan switch inside a paid
   *  period. The period did not start now, so its start is not a new window. */
  prorationOnly: boolean;
}

/**
 * Narrow a verified event body to a paid subscription invoice — the single
 * grant/renewal choke point (ADR 0195). Reads the subscription's own line
 * (see below). Null for every
 * other event type (the webhook 200s those as no-ops).
 */
export function parseInvoicePaid(rawBody: string): PaidInvoice | null {
  let evt: unknown;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return null;
  }
  // Two shapes, because the shape follows the API version of the webhook
  // destination. Up to 2025-02-24.acacia a line carries `price.id` / `proration`
  // and the invoice carries `subscription`; from 2025-03-31.basil (this account's
  // default is newer still) those moved to `pricing.price_details.price`,
  // `parent.*.proration` and `parent.subscription_details.subscription`. Reading
  // only the old one would grant nothing on a paid invoice and say nothing.
  type Line = {
    price?: { id?: string };
    pricing?: { type?: string; price_details?: { price?: string | { id?: string } } };
    period?: { start?: number; end?: number };
    metadata?: { userId?: string } | null;
    /** Minor units; negative for a credit. */
    amount?: number;
    proration?: boolean;
    parent?: {
      subscription_item_details?: { proration?: boolean };
      invoice_item_details?: { proration?: boolean };
    };
  };
  const e = evt as {
    type?: string;
    data?: {
      object?: {
        id?: string;
        customer?: string | null;
        subscription?: string | null;
        parent?: {
          subscription_details?: {
            subscription?: string | { id?: string } | null;
            metadata?: { userId?: string } | null;
          };
        };
        subscription_details?: { metadata?: { userId?: string } | null };
        lines?: { data?: Line[] };
      };
    };
  };
  if (e.type !== 'invoice.paid') return null;
  const inv = e.data?.object;
  if (!inv?.id) return null;
  const isProration = (l: Line): boolean =>
    l.proration === true ||
    l.parent?.subscription_item_details?.proration === true ||
    l.parent?.invoice_item_details?.proration === true;
  const linePriceId = (l: Line | undefined): string | null => {
    if (!l) return null;
    if (l.price?.id) return l.price.id;
    const p = l.pricing?.price_details?.price;
    return (typeof p === 'string' ? p : p?.id) ?? null;
  };
  const newSub = inv.parent?.subscription_details?.subscription;
  const subscriptionId = inv.subscription ?? (typeof newSub === 'string' ? newSub : (newSub?.id ?? null));
  // ADR 0231 — a plan change through the billing portal bills the new price
  // together with PRORATION lines (a credit for the old price's unused time),
  // so "the first line" can be the old plan. The subscription's own line is
  // the first non-proration one; a single-price invoice has exactly that.
  const lines = inv.lines?.data ?? [];
  // ADR 0236 — a switch to a price of the SAME interval inside the paid period
  // has no full-price line at all: Stripe invoices a credit for the old
  // price's unused time and a charge for the new price's remaining time, both
  // prorations. The old price's credit is listed first, so taking the first
  // line resolved the plan being LEFT and undid the switch. The charge is the
  // new plan: the positive line (the last one if nothing is positive, e.g. a
  // fully discounted price).
  const regular = lines.find((l) => !isProration(l));
  const prorationOnly = !regular && lines.length > 0;
  const charges = lines.filter((l) => (l.amount ?? 0) > 0);
  const line = regular ?? (prorationOnly ? (charges[charges.length - 1] ?? lines[lines.length - 1]) : undefined);
  const periodStartUnix = line?.period?.start;
  const periodEndUnix = line?.period?.end;
  return {
    invoiceId: inv.id,
    customerId: inv.customer ?? null,
    subscriptionId,
    userId:
      inv.parent?.subscription_details?.metadata?.userId ??
      inv.subscription_details?.metadata?.userId ??
      line?.metadata?.userId ??
      null,
    priceId: linePriceId(line),
    // ADR 0196 — the period's START, not just its end: SUM(token_usage)
    // since this timestamp is what "remaining balance" is computed from.
    periodStart: typeof periodStartUnix === 'number' ? new Date(periodStartUnix * 1000).toISOString() : null,
    periodEnd: typeof periodEndUnix === 'number' ? new Date(periodEndUnix * 1000).toISOString() : null,
    prorationOnly,
  };
}
