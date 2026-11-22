/**
 * A mailbox that fails to sync is left alone for a while, not retried on every
 * tick.
 *
 * `gmail_synced_at` (and each account's `synced_at`) only move when a sync
 * SUCCEEDS, so the sweep's "stale" test kept selecting a failing mailbox on
 * every 15-second proactive tick. When the failure was Gmail's own per-minute
 * quota that made it permanent: each retry spent the quota it was waiting for.
 *
 * In memory on purpose. The sweep and the opportunistic syncs run in the
 * worker, one instance, and losing this on a restart costs one early retry.
 * It applies only to those background paths; a sync the person asked for
 * (the Email tab, the sync button, a push wake) never consults it, though its
 * outcome still updates it, so a good explicit sync clears a stale wait.
 */
import { env } from '../../config/env.js';

interface Entry {
  failures: number;
  /** Epoch ms before which the background paths leave the mailbox alone. */
  until: number;
}

const entries = new Map<string, Entry>();
// A key per mailbox. Bounded so a long-lived process that sees many one-off
// failures cannot grow without limit; the oldest goes first.
const MAX_KEYS = 20_000;

const MIN = 60_000;
/** A quota 403 says "come back later", so it starts longer than an ordinary error. */
const RATE_LIMIT_BASE_MIN = 10;

export const gmailKey = (userId: string): string => `gmail:${userId}`;
export const accountKey = (accountId: string): string => `acct:${accountId}`;

/**
 * Gmail's per-minute quota arrives as a 403 with "Quota exceeded" in the body
 * (not a 429, which the API layer already retries), Graph and others as 429.
 */
export function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /quota exceeded|rate ?limit|too many requests|\b429\b/i.test(message);
}

/** How long to wait after the `failures`-th consecutive failure. 0 = backoff is off. */
export function backoffDelayMs(failures: number, rateLimited: boolean): number {
  const capMin = env.MAIL_SYNC_BACKOFF_MAX_MINUTES;
  if (capMin <= 0) return 0;
  const baseMin = rateLimited ? RATE_LIMIT_BASE_MIN : Math.max(env.MAIL_SWEEP_MINUTES, 1);
  const min = Math.min(capMin, baseMin * 2 ** Math.max(failures - 1, 0));
  return min * MIN;
}

/** Note a failed sync and return how long the background paths will now wait. */
export function recordSyncFailure(key: string, err: unknown, now: number = Date.now()): number {
  const failures = (entries.get(key)?.failures ?? 0) + 1;
  const delay = backoffDelayMs(failures, isRateLimitError(err));
  if (delay === 0) {
    entries.delete(key);
    return 0;
  }
  entries.delete(key); // re-insert last, so the map stays oldest-first
  entries.set(key, { failures, until: now + delay });
  if (entries.size > MAX_KEYS) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  return delay;
}

/**
 * A backfill stopped on the provider's quota but kept what it fetched, and
 * resumes from there next time. Wait like a quota failure, but a pass that made
 * progress does not escalate the wait: it starts again from the first step.
 */
export function recordSyncPause(
  key: string,
  err: unknown,
  madeProgress: boolean,
  now: number = Date.now(),
): number {
  if (madeProgress) entries.delete(key);
  return recordSyncFailure(key, err, now);
}

/** A sync went through: forget the wait, and the failure count with it. */
export function recordSyncSuccess(key: string): void {
  entries.delete(key);
}

/** Milliseconds left before the background paths may try this mailbox again; 0 if they may. */
export function backoffRemainingMs(key: string, now: number = Date.now()): number {
  const e = entries.get(key);
  if (!e) return 0;
  return Math.max(0, e.until - now);
}

export function __resetSyncBackoffForTests(): void {
  entries.clear();
}
