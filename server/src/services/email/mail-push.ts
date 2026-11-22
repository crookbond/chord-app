/**
 * Real push (ADR 0118) — the half that is the same for every provider.
 *
 * Gmail's Pub/Sub notification, Graph's subscription callback and IMAP's IDLE
 * `exists` event all answer one question: *this mailbox has new mail, sync it
 * now*. They differ only in how the nudge arrives, so they converge here
 * before anything provider-specific happens, and none of them gets to invent
 * its own idea of what "sync" means.
 *
 * The load-bearing rule: **push pre-empts polling, it never replaces it.**
 * Both webhook registrations expire on a timer measured in days, so sooner or
 * later one dies unnoticed. Because the poll still runs, that is a latency
 * regression rather than an outage — which is the only reason it is safe to
 * ship a mechanism that cannot be verified end to end without a public URL.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';

/**
 * A burst of notifications about one mailbox must not start a sync each. Gmail
 * publishes per history change, so five messages arriving together is five
 * pushes for one sync's worth of work.
 */
const COALESCE_MS = 2000;

type SyncFn = (db: Kysely<DB>, userId: string, accountId: string | null) => Promise<void>;

interface Pending {
  timer: NodeJS.Timeout;
  userId: string;
  accountId: string | null;
}

const pending = new Map<string, Pending>();
/** Mailboxes with a sync in flight; a nudge arriving mid-sync re-arms rather
 *  than running a second one concurrently against the same cursor. */
const inFlight = new Set<string>();

const keyOf = (userId: string, accountId: string | null) => `${userId}:${accountId ?? ''}`;

/**
 * The sync to run. Injected rather than imported so this module stays below
 * the provider services in the dependency order — importing them here would
 * close the cycle that `attachment-fetch.ts` and `body-backfill.ts` already
 * sit above.
 */
let runSync: SyncFn | null = null;

export function setMailboxSyncRunner(fn: SyncFn): void {
  runSync = fn;
}

/**
 * Nudge a mailbox. Returns immediately: the caller is a webhook that must
 * answer the provider fast, or an IDLE handler that must get back to idling.
 */
export function wakeMailbox(
  db: Kysely<DB>,
  userId: string,
  accountId: string | null = null,
): void {
  const key = keyOf(userId, accountId);
  const existing = pending.get(key);
  if (existing) {
    // Push the deadline out rather than stacking timers: a steady trickle of
    // notifications should still settle into one sync.
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pending.delete(key);
    void drain(db, userId, accountId);
  }, COALESCE_MS);
  timer.unref?.();
  pending.set(key, { timer, userId, accountId });
}

async function drain(db: Kysely<DB>, userId: string, accountId: string | null): Promise<void> {
  const key = keyOf(userId, accountId);
  if (inFlight.has(key)) {
    // Someone is already syncing this mailbox. Re-arm so the change that
    // arrived mid-sync is not lost to a cursor that had already moved.
    wakeMailbox(db, userId, accountId);
    return;
  }
  if (!runSync) {
    logger.warn('mail push: no sync runner registered', { userId });
    return;
  }
  inFlight.add(key);
  try {
    await runSync(db, userId, accountId);
  } catch (err) {
    // A failed push-triggered sync is not an incident: the poll will retry on
    // its own schedule. Logged at warn so a persistent failure is still
    // visible without paging on a transient one.
    logger.warn('mail push: sync failed', {
      userId,
      accountId,
      err: (err as Error).message,
    });
  } finally {
    inFlight.delete(key);
  }
}

/** Tests and shutdown: drop timers so nothing fires after teardown. */
export function __resetMailPush(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  inFlight.clear();
}
