/**
 * The provider-specific half of real push (ADR 0118): how each mailbox is
 * asked to notify us, and how each notification is understood.
 *
 * Two shapes, not three. Gmail and Graph both register an external
 * subscription against a callback URL; IMAP has no registration at all and is
 * handled by `imap-idle.ts` instead.
 *
 * Kept apart from `mail-subscriptions.ts` so the lifecycle (arm, renew, record
 * the failure) is written once and knows nothing about either provider.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { getAccount } from '../email-accounts/account-utils.js';
import { gmailAccountApi } from '../email-accounts/gmail-account.service.js';
import { getOutlookApi } from '../email-accounts/outlook-api.js';
import { getGmailApi } from '../google/gmail-api.js';
import { registerArmer, type ArmResult, type MailboxRef } from './mail-subscriptions.js';

/** Graph refuses a subscription longer than ~4230 minutes for mail. Asking for
 *  slightly less avoids arguing with the boundary. */
const GRAPH_MAX_MINUTES = 4000;

export function graphCallbackUrl(): string {
  const base = env.MAIL_PUSH_PUBLIC_URL.replace(/\/+$/, '');
  return `${base}/api/v1/webhooks/mail/graph`;
}

/**
 * Gmail: `users.watch` publishes to a Pub/Sub topic we own, and Pub/Sub pushes
 * to our URL. The registration is addressed by mailbox rather than by an id,
 * so renewal is simply calling it again.
 *
 * The topic is deploy-level config, not per-user: every user's watch publishes
 * to the same topic and the notification says which mailbox it is about.
 */
const armGmail = async (
  db: Kysely<DB>,
  ref: MailboxRef,
): Promise<ArmResult> => {
  if (!env.MAIL_PUSH_GMAIL_TOPIC) {
    throw new Error('MAIL_PUSH_GMAIL_TOPIC is not set');
  }
  const api = ref.accountId
    ? await gmailAccountApi(db, (await getAccount(db, ref.userId, ref.accountId))!)
    : await getGmailApi(db, ref.userId);
  const res = await api.watch(env.MAIL_PUSH_GMAIL_TOPIC);
  return {
    // Gmail hands back no handle; the mailbox address is the identity.
    externalId: null,
    expiresAt: new Date(Number(res.expiration) || Date.now() + 7 * 24 * 3600_000),
  };
};

/**
 * Graph: a subscription on the inbox, which Graph validates by calling our URL
 * with a `validationToken` before it will create anything.
 *
 * `clientState` comes back on every notification and is how we know one is
 * ours — Graph's callback is otherwise an unauthenticated POST.
 */
const armGraph = async (
  db: Kysely<DB>,
  ref: MailboxRef,
  clientState: string,
): Promise<ArmResult> => {
  if (!ref.accountId) throw new Error('graph push needs an account');
  const account = await getAccount(db, ref.userId, ref.accountId);
  if (!account) throw new Error('account not found');
  const api = await getOutlookApi(db, account);
  const expiry = new Date(Date.now() + GRAPH_MAX_MINUTES * 60_000);
  const id = await api.subscribe({
    notificationUrl: graphCallbackUrl(),
    clientState,
    expiresAt: expiry,
  });
  return { externalId: id, expiresAt: expiry };
};

let registered = false;

/** Wire the armers in. Idempotent so a second call (tests, a re-init) is a
 *  no-op rather than a duplicate registration. */
export function registerMailPushProviders(): void {
  if (registered) return;
  registered = true;
  registerArmer('gmail', armGmail);
  registerArmer('outlook', armGraph);
  logger.info('mail push providers registered (gmail watch, graph subscriptions)');
}

/**
 * Decode a Pub/Sub push envelope into the mailbox it concerns.
 *
 * The payload is base64 JSON `{emailAddress, historyId}` wrapped in Pub/Sub's
 * own envelope. It carries no message content, which is why the notification
 * is only ever a HINT to sync — we re-read history ourselves rather than
 * trusting anything in here.
 */
export function parseGmailNotification(body: unknown): { emailAddress: string } | null {
  const message = (body as { message?: { data?: string } })?.message;
  if (!message?.data) return null;
  try {
    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8')) as {
      emailAddress?: string;
    };
    return decoded.emailAddress ? { emailAddress: decoded.emailAddress } : null;
  } catch {
    // A malformed envelope is not worth an error: Pub/Sub retries on a non-2xx
    // and would keep redelivering something we can never parse.
    return null;
  }
}
