/**
 * Keeping a push registration alive (ADR 0118).
 *
 * Gmail's `users.watch` and Graph's subscription are the same kind of object:
 * an external registration with an id and a deadline measured in days. Neither
 * survives on its own, so something has to notice what is close to expiring
 * and renew it — which is all this module is.
 *
 * IMAP has no registration; its IDLE connection is held open instead, so it
 * does not appear here.
 */
import { randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { secretsEqual } from '../../utils/secret-compare.js';

/**
 * Renew this far before the provider's deadline. Generous on purpose: a
 * renewal that fails still has several ticks to succeed before the
 * registration lapses, and a lapse costs latency until the next poll.
 */
const RENEW_BEFORE_MS = 12 * 60 * 60 * 1000;

export interface MailboxRef {
  userId: string;
  accountId: string | null;
  provider: 'gmail' | 'outlook' | 'imap';
}

/** What a provider's arm/renew call has to hand back. */
export interface ArmResult {
  /** The provider's handle, when it has one. Gmail's watch is addressed by
   *  the mailbox rather than by an id, so it returns null. */
  externalId: string | null;
  expiresAt: Date;
}

export type Armer = (
  db: Kysely<DB>,
  ref: MailboxRef,
  clientState: string,
) => Promise<ArmResult>;

const armers = new Map<string, Armer>();

/** Registered by each provider module, so this one imports none of them. */
export function registerArmer(provider: 'gmail' | 'outlook', fn: Armer): void {
  armers.set(provider, fn);
}

/** A secret per subscription, not per deploy: a leaked one is worth exactly
 *  one mailbox's early sync. */
function newClientState(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Arm (or re-arm) push for one mailbox. Safe to call repeatedly — the row is
 * keyed by mailbox, so this is how both first-arm and renewal work.
 *
 * A failure is recorded and swallowed. Polling still carries the mailbox, so
 * the honest posture is a latency regression rather than a connect flow that
 * fails because a Pub/Sub topic is misconfigured.
 */
export async function armMailbox(db: Kysely<DB>, ref: MailboxRef): Promise<boolean> {
  const armer = armers.get(ref.provider);
  if (!armer) return false;

  const now = new Date().toISOString();
  const existing = await db
    .selectFrom('mail_subscriptions')
    .select(['id', 'client_state'])
    .where('user_id', '=', ref.userId)
    .where((eb) =>
      ref.accountId ? eb('account_id', '=', ref.accountId) : eb('account_id', 'is', null),
    )
    .executeTakeFirst();

  // Reuse the secret across renewals: notifications already in flight carry
  // the old one, and rotating it every few days would drop them.
  const clientState = existing?.client_state ?? newClientState();

  try {
    const result = await armer(db, ref, clientState);
    const values = {
      user_id: ref.userId,
      account_id: ref.accountId,
      provider: ref.provider,
      external_id: result.externalId,
      client_state: clientState,
      expires_at: result.expiresAt.toISOString(),
      failed_at: null,
      last_error: null,
      updated_at: now,
    };
    if (existing) {
      await db
        .updateTable('mail_subscriptions')
        .set(values)
        .where('id', '=', existing.id)
        .execute();
    } else {
      await db
        .insertInto('mail_subscriptions')
        .values({ id: newId('msub'), created_at: now, ...values })
        .execute();
    }
    return true;
  } catch (err) {
    const message = (err as Error).message;
    logger.warn('mail push: arm failed, polling continues', {
      userId: ref.userId,
      accountId: ref.accountId,
      provider: ref.provider,
      err: message,
    });
    if (existing) {
      await db
        .updateTable('mail_subscriptions')
        .set({ failed_at: now, last_error: message.slice(0, 500), updated_at: now })
        .where('id', '=', existing.id)
        .execute();
    }
    return false;
  }
}

/** Subscriptions close enough to expiry to be worth renewing now. */
export async function dueForRenewal(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<MailboxRef[]> {
  const cutoff = new Date(now.getTime() + RENEW_BEFORE_MS).toISOString();
  const rows = await db
    .selectFrom('mail_subscriptions')
    .select(['user_id', 'account_id', 'provider'])
    .where('expires_at', '<=', cutoff)
    .orderBy('expires_at', 'asc')
    .limit(100)
    .execute();
  return rows.map((r) => ({
    userId: r.user_id,
    accountId: r.account_id,
    provider: r.provider as MailboxRef['provider'],
  }));
}

/**
 * Find the mailbox a notification belongs to, and prove the notification is
 * entitled to speak for it.
 *
 * `clientState` is checked for Graph, which sends one back. Gmail's Pub/Sub
 * payload carries no secret of its own, so its route authenticates differently
 * (a token on the URL) and passes null here.
 */
export async function resolveSubscription(
  db: Kysely<DB>,
  match: { externalId?: string; userId?: string; accountId?: string | null },
  clientState: string | null,
): Promise<MailboxRef | null> {
  let q = db
    .selectFrom('mail_subscriptions')
    .select(['user_id', 'account_id', 'provider', 'client_state']);
  if (match.externalId) {
    q = q.where('external_id', '=', match.externalId);
  } else if (match.userId) {
    q = q.where('user_id', '=', match.userId).where((eb) =>
      match.accountId ? eb('account_id', '=', match.accountId) : eb('account_id', 'is', null),
    );
  } else {
    return null;
  }
  const row = await q.executeTakeFirst();
  if (!row) return null;
  if (clientState !== null && !secretsEqual(clientState, row.client_state)) {
    logger.warn('mail push: clientState mismatch, ignoring notification', {
      userId: row.user_id,
    });
    return null;
  }
  return {
    userId: row.user_id,
    accountId: row.account_id,
    provider: row.provider as MailboxRef['provider'],
  };
}

export interface RenewalHandle {
  stop: () => void;
}

export function startSubscriptionRenewal(db: Kysely<DB>): RenewalHandle {
  if (!env.MAIL_PUSH_ENABLED) {
    logger.info('mail push disabled (MAIL_PUSH_ENABLED=0)');
    return { stop: () => {} };
  }
  logger.info(`mail push renewal tick=${env.MAIL_PUSH_RENEW_TICK_MS}ms`);
  let inFlight = false;
  const interval = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      for (const ref of await dueForRenewal(db)) await armMailbox(db, ref);
    } catch (err) {
      logger.error('mail push renewal pass failed', { err });
    } finally {
      inFlight = false;
    }
  }, env.MAIL_PUSH_RENEW_TICK_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}
