/**
 * Inbound webhook endpoint for IM connectors (ADR 0010).
 *
 * WhatsApp and Discord deliver events here; Telegram uses long-poll inside its
 * connector and does not hit this route. We ack 200 fast and run the
 * pipeline asynchronously.
 */
import { Router } from 'express';

import { API } from '@chord/kernel';

import { logger } from '../config/logging';
import { handleInbound } from '../services/connectors/inbound-pipeline';
import { connectorRegistry } from '../services/connectors/registry';
import type {
  ConnectorPlatform,
  VerificationChallenge,
} from '../services/connectors/types';
import {
  parseInvoicePaid,
  parseSubscriptionCheckoutCompleted,
  planForPriceId,
  stripeWebhookEnabled,
  verifyStripeSignature,
} from '../services/stripe.service';
import { DEFAULT_PROMO_TRIAL_DAYS, redeemPromoCode } from '../services/promo.service';
import {
  applyRevenueCatChange,
  parseRevenueCatEvent,
  revenueCatWebhookEnabled,
  verifyRevenueCatAuth,
} from '../services/revenuecat.service';

export const webhooksRouter = Router();

// Slack has no connector since ADR 0154; its events have nowhere to go.
const PLATFORMS: ConnectorPlatform[] = ['discord', 'telegram', 'whatsapp'];

/** Slack's challenge is JSON; Meta's must be plain text (ADR 0090). */
function sendChallenge(
  res: { status: (n: number) => { json: (b: unknown) => void; type: (t: string) => { send: (b: string) => void } } },
  challenge: VerificationChallenge,
): void {
  if (typeof challenge.text === 'string') {
    res.status(challenge.status).type('text/plain').send(challenge.text);
    return;
  }
  res.status(challenge.status).json(challenge.body ?? {});
}

// ADR 0075/0195/0196 — Stripe subscription events. MUST be registered
// before the `/:platform` catch-all below, which 404s any platform it
// doesn't know.
//
// Two events, two jobs: `checkout.session.completed` only links
// stripe_customer_id/stripe_subscription_id to the user — it never grants.
// `invoice.paid` records the period's bounds (start/end) on the user row —
// there's no separate grant/reset step (ADR 0196): getEntitlement computes
// the system plan's remaining allowance by summing token_usage since
// subscription_period_started_at, so advancing that timestamp IS the
// renewal. Fires uniformly for the first period and every renewal alike,
// so there's no first-time-vs-renewal code path to keep in sync.
webhooksRouter.post(API.webhookStripe, async (req, res) => {
  if (!stripeWebhookEnabled()) {
    res.status(404).json({ error: 'stripe webhook not configured' });
    return;
  }
  const rawBody = req.rawBody ?? '';
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(rawBody, typeof sig === 'string' ? sig : undefined)) {
    logger.warn('stripe webhook signature verification failed');
    res.status(401).json({ error: 'signature mismatch' });
    return;
  }

  const checkout = parseSubscriptionCheckoutCompleted(rawBody);
  if (checkout) {
    if (!checkout.userId || !checkout.customerId) {
      logger.warn('stripe subscription checkout missing user or customer', {
        sessionId: checkout.sessionId,
      });
      res.status(200).json({ received: true });
      return;
    }
    try {
      const updated = await req.db
        .updateTable('users')
        .set({
          stripe_customer_id: checkout.customerId,
          stripe_subscription_id: checkout.subscriptionId,
        })
        .where('id', '=', checkout.userId)
        .executeTakeFirst();
      if (!updated.numUpdatedRows) {
        logger.warn('stripe checkout for unknown user', { userId: checkout.userId });
      } else if (checkout.promoCode && checkout.plan && checkout.interval) {
        // ADR 0231 — the subscription began with a free period. Burn the code
        // now (it was only checked when the session was made) and open the
        // free period immediately, so access doesn't hinge on Stripe issuing
        // and paying a $0 trial invoice. The first real invoice.paid replaces
        // it. A lost burn (a second checkout raced us to the code) still gets
        // the period: the customer was promised it.
        const burned = await redeemPromoCode(req.db, checkout.promoCode, checkout.userId);
        const days = checkout.promoTrialDays ?? DEFAULT_PROMO_TRIAL_DAYS;
        const startedAt = new Date();
        const freeUntil = new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
        const current = await req.db
          .selectFrom('users')
          .select('subscription_current_period_end')
          .where('id', '=', checkout.userId)
          .executeTakeFirst();
        if (!current?.subscription_current_period_end || current.subscription_current_period_end < freeUntil) {
          await req.db
            .updateTable('users')
            .set({
              subscription_plan: checkout.plan,
              subscription_interval: checkout.interval,
              subscription_source: 'stripe',
              subscription_period_started_at: startedAt.toISOString(),
              subscription_current_period_end: freeUntil,
            })
            .where('id', '=', checkout.userId)
            .execute();
        }
        logger.info('stripe subscription started on a promo code', {
          userId: checkout.userId,
          plan: checkout.plan,
          burned,
        });
      } else {
        logger.info('stripe subscription customer linked', {
          userId: checkout.userId,
          customerId: checkout.customerId,
        });
      }
      res.status(200).json({ received: true });
    } catch (err) {
      // Transient DB failure: 500 so Stripe retries; the update is idempotent.
      logger.error('stripe checkout link failed', { err, sessionId: checkout.sessionId });
      res.status(500).json({ error: 'internal error' });
    }
    return;
  }

  const invoice = parseInvoicePaid(rawBody);
  if (invoice) {
    if (!invoice.customerId || !invoice.periodStart || !invoice.periodEnd) {
      logger.warn('stripe invoice.paid missing customer or period bounds', { invoiceId: invoice.invoiceId });
      res.status(200).json({ received: true });
      return;
    }
    const priced = planForPriceId(invoice.priceId);
    if (!priced) {
      // A price this deploy doesn't recognize — log and no-op rather than
      // guess which plan (or none) it should grant.
      logger.warn('stripe invoice.paid for unrecognized price', {
        invoiceId: invoice.invoiceId,
        priceId: invoice.priceId,
      });
      res.status(200).json({ received: true });
      return;
    }
    try {
      let user = await req.db
        .selectFrom('users')
        .select('id')
        .where('stripe_customer_id', '=', invoice.customerId)
        .executeTakeFirst();
      // invoice.paid routinely arrives BEFORE the checkout.session.completed
      // that links the customer (prod: 250 ms ahead). The subscription's
      // metadata names the user (set at checkout), so link them here.
      if (!user && invoice.userId) {
        user = await req.db
          .selectFrom('users')
          .select('id')
          .where('id', '=', invoice.userId)
          .executeTakeFirst();
        if (user) {
          await req.db
            .updateTable('users')
            .set({ stripe_customer_id: invoice.customerId })
            .where('id', '=', user.id)
            .where('stripe_customer_id', 'is', null)
            .execute();
        }
      }
      // Still nobody: answer 500 so Stripe delivers it again once the checkout
      // event has linked the customer. A 200 here dropped the first payment for
      // good — Stripe never resends an event it was told was received.
      if (!user) {
        logger.warn('stripe invoice.paid for unlinked customer; asking Stripe to retry', {
          invoiceId: invoice.invoiceId,
          customerId: invoice.customerId,
        });
        res.status(500).json({ error: 'customer not linked yet' });
        return;
      }
      // ADR 0196 — this update IS the grant/renewal, for both plans. There is
      // no separate "reset the balance" step any more: the system plan's
      // allowance falls out automatically the moment
      // subscription_period_started_at advances, because getEntitlement only
      // ever sums token_usage since that timestamp. Naturally idempotent — a
      // duplicate delivery for the same invoice just writes the same values
      // again, no double-grant to guard against.
      // ADR 0236 — an invoice made only of prorations is a plan switch inside
      // the period already paid for: take the new plan and end, but leave the
      // allowance window alone (its start is the moment of the switch, and
      // moving the window there would hand out a fresh allowance per switch).
      await req.db
        .updateTable('users')
        .set({
          subscription_plan: priced.plan,
          subscription_interval: priced.interval,
          subscription_source: 'stripe',
          ...(invoice.prorationOnly ? {} : { subscription_period_started_at: invoice.periodStart }),
          subscription_current_period_end: invoice.periodEnd,
          stripe_subscription_id: invoice.subscriptionId,
        })
        .where('id', '=', user.id)
        .execute();
      logger.info('stripe subscription period granted', {
        userId: user.id,
        plan: priced.plan,
        interval: priced.interval,
      });
      res.status(200).json({ received: true });
    } catch (err) {
      // Transient DB failure: 500 so Stripe retries; the update is idempotent.
      logger.error('stripe invoice.paid handling failed', { err, invoiceId: invoice.invoiceId });
      res.status(500).json({ error: 'internal error' });
    }
    return;
  }

  // Unknown event types are a 200 no-op — never make Stripe retry them.
  res.status(200).json({ received: true });
});

// ADR 0231 — App Store subscriptions, via RevenueCat. Same registration rule
// as Stripe's above: before the `/:platform` catch-all. Authenticated by a
// shared secret in the Authorization header; always 200 for anything we don't
// act on so RevenueCat doesn't retry it.
webhooksRouter.post(API.webhookRevenueCat, async (req, res) => {
  if (!revenueCatWebhookEnabled()) {
    res.status(404).json({ error: 'revenuecat webhook not configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!verifyRevenueCatAuth(typeof auth === 'string' ? auth : undefined)) {
    logger.warn('revenuecat webhook auth failed');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const change = parseRevenueCatEvent(req.body);
    const outcome = await applyRevenueCatChange(req.db, change);
    if (outcome === 'unknown_user' || outcome === 'unknown_product') {
      logger.warn('revenuecat event not applied', { outcome, change });
    } else if (outcome !== 'ignored') {
      logger.info('revenuecat subscription change', { outcome, change });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    // Transient DB failure: 500 so RevenueCat retries; every write is idempotent.
    logger.error('revenuecat webhook handling failed', { err });
    res.status(500).json({ error: 'internal error' });
  }
});

/**
 * ADR 0090 — Meta verifies a webhook subscription with a GET carrying
 * `hub.challenge`, which must be echoed back as plain text. Only the
 * challenge path runs here; anything else on GET is a 404.
 */
webhooksRouter.get('/api/v1/webhooks/:platform', (req, res) => {
  const platform = req.params.platform as ConnectorPlatform;
  if (!PLATFORMS.includes(platform)) {
    res.status(404).json({ error: `unknown platform: ${platform}` });
    return;
  }
  const connector = connectorRegistry.getDeployWide(platform);
  const challenge = connector?.handleVerificationChallenge?.(req) ?? null;
  if (!challenge) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  sendChallenge(res, challenge);
});

webhooksRouter.post('/api/v1/webhooks/:platform', async (req, res) => {
  const platform = req.params.platform as ConnectorPlatform;
  if (!PLATFORMS.includes(platform)) {
    res.status(404).json({ error: `unknown platform: ${platform}` });
    return;
  }
  // Webhooks are inherently deploy-wide: only one webhook URL exists per
  // platform on a given server, so it must hit the deploy-wide bot. BYO
  // bots run via long-poll/gateway and never enter through this route.
  const connector = connectorRegistry.getDeployWide(platform);
  if (!connector) {
    res.status(404).json({ error: `unknown platform: ${platform}` });
    return;
  }

  try {
    const challenge = connector.handleVerificationChallenge?.(req) ?? null;
    if (challenge) {
      sendChallenge(res, challenge);
      return;
    }

    if (!connector.verifySignature(req)) {
      logger.warn('webhook signature verification failed', { platform });
      res.status(401).json({ error: 'signature mismatch' });
      return;
    }

    // ADR 0090 — Meta batches several messages into one notification. Prefer
    // the batch parser where a connector has one; taking only the first would
    // silently drop the rest.
    const inbound = connector.parseInboundBatch
      ? await connector.parseInboundBatch(req)
      : [await connector.parseInbound(req)];
    res.status(200).end();

    for (const m of inbound) {
      if (!m) continue;
      handleInbound(req.db, m).catch((err) =>
        logger.error('inbound pipeline failed', { err, platform }),
      );
    }
  } catch (err) {
    logger.error('webhook handler crashed', { err, platform });
    if (!res.headersSent) res.status(500).json({ error: 'internal error' });
  }
});
