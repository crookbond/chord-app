/**
 * Where providers tell us a mailbox changed (ADR 0118).
 *
 * Both endpoints do the same small job: work out which mailbox, prove the
 * caller is entitled to speak for it, answer fast, and let the shared
 * `wakeMailbox` decide when to actually sync. Neither notification carries
 * mail — they are hints, and we re-read the mailbox ourselves either way,
 * which is what keeps a forged one boring.
 *
 * Answering fast is not politeness. Pub/Sub retries on any non-2xx and Graph
 * drops a subscription that keeps failing, so a slow handler turns one late
 * sync into a dead registration.
 */
import { Router } from 'express';
import { sql } from 'kysely';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { wakeMailbox } from '../services/email/mail-push.js';
import { parseGmailNotification } from '../services/email/mail-push-providers.js';
import { resolveSubscription } from '../services/email/mail-subscriptions.js';
import { secretsEqual } from '../utils/secret-compare.js';

export const mailPushRouter = Router();

/**
 * Graph validates a notificationUrl before it will create the subscription:
 * it POSTs with `?validationToken=` and wants the token back as plain text.
 * Same handshake shape as ADR 0090's Meta challenge — and, as there, the body
 * must be the bare token: JSON would quote it and fail the check.
 */
function respondToGraphValidation(
  token: string,
  res: import('express').Response,
): void {
  res.status(200).type('text/plain').send(token);
}

mailPushRouter.post('/api/v1/webhooks/mail/graph', async (req, res) => {
  const validationToken = req.query.validationToken;
  if (typeof validationToken === 'string') {
    respondToGraphValidation(validationToken, res);
    return;
  }
  if (!env.MAIL_PUSH_ENABLED) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // Answer first. Graph counts a slow reply against the subscription, and
  // nothing below needs to be inside the response.
  res.status(202).end();

  const notifications = (req.body as { value?: unknown[] })?.value ?? [];
  for (const raw of notifications) {
    const n = raw as { subscriptionId?: string; clientState?: string };
    if (!n.subscriptionId) continue;
    try {
      const ref = await resolveSubscription(
        req.db,
        { externalId: n.subscriptionId },
        n.clientState ?? '',
      );
      // A mismatch is already logged inside resolveSubscription; nothing more
      // to do here than not act on it.
      if (ref) wakeMailbox(req.db, ref.userId, ref.accountId);
    } catch (err) {
      logger.warn('graph mail notification failed', { err: (err as Error).message });
    }
  }
});

mailPushRouter.post('/api/v1/webhooks/mail/gmail', async (req, res) => {
  if (!env.MAIL_PUSH_ENABLED) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  // Gmail's Pub/Sub payload carries no secret of its own, so the URL does. The
  // notification has no content and only ever causes a sync, so this is about
  // not offering a free way to make the server work — not about secrecy.
  if (typeof req.query.token !== 'string' || !secretsEqual(req.query.token, env.MAIL_PUSH_GMAIL_TOKEN)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  // 2xx before doing the work: Pub/Sub redelivers anything else, and a
  // redelivery of a sync we already ran is pure waste.
  res.status(204).end();

  const parsed = parseGmailNotification(req.body);
  if (!parsed) return;
  try {
    // Gmail identifies the mailbox by address. The primary mailbox lives on
    // the users row; an attached Gmail lives on email_accounts, and the two
    // can hold the same address for different people, so both are matched
    // against the ADDRESS and then confirmed against a real subscription.
    // Addresses are compared without case: an attached mailbox keeps the
    // address as the user typed it, and Gmail may send it differently.
    const address = parsed.emailAddress.toLowerCase();
    const user = await req.db
      .selectFrom('users')
      .select('id')
      .where(sql`lower(email)`, '=', address)
      .executeTakeFirst();
    if (user) {
      const ref = await resolveSubscription(req.db, { userId: user.id, accountId: null }, null);
      if (ref) wakeMailbox(req.db, ref.userId, null);
    }

    const accounts = await req.db
      .selectFrom('email_accounts')
      .select(['id', 'user_id'])
      .where(sql`lower(email_address)`, '=', address)
      .where('provider', '=', 'gmail')
      .execute();
    for (const a of accounts) {
      const ref = await resolveSubscription(
        req.db,
        { userId: a.user_id, accountId: a.id },
        null,
      );
      if (ref) wakeMailbox(req.db, a.user_id, a.id);
    }
  } catch (err) {
    logger.warn('gmail mail notification failed', { err: (err as Error).message });
  }
});
