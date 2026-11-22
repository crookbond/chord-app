import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import {
  accountKey,
  backoffDelayMs,
  backoffRemainingMs,
  gmailKey,
  isRateLimitError,
  recordSyncFailure,
  recordSyncSuccess,
  __resetSyncBackoffForTests,
} from '@/services/email/sync-backoff.js';

const MIN = 60_000;
const e = env as { MAIL_SYNC_BACKOFF_MAX_MINUTES: number; MAIL_SWEEP_MINUTES: number };
let savedMax: number;
let savedSweep: number;

beforeEach(() => {
  __resetSyncBackoffForTests();
  savedMax = e.MAIL_SYNC_BACKOFF_MAX_MINUTES;
  savedSweep = e.MAIL_SWEEP_MINUTES;
  e.MAIL_SYNC_BACKOFF_MAX_MINUTES = 60;
  e.MAIL_SWEEP_MINUTES = 5;
});
afterEach(() => {
  e.MAIL_SYNC_BACKOFF_MAX_MINUTES = savedMax;
  e.MAIL_SWEEP_MINUTES = savedSweep;
});

// What prod logged for 271 retries in an hour.
const PROD_QUOTA_403 =
  'gmail GET /history 403: {\n  "error": {\n    "code": 403,\n    "message": "Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\' of service \'gmail.googleapis.com\'';

describe('isRateLimitError', () => {
  it('recognises the Gmail per-minute quota 403 prod hit', () => {
    expect(isRateLimitError(new Error(PROD_QUOTA_403))).toBe(true);
  });
  it('recognises a 429 and a rate-limit message from another provider', () => {
    expect(isRateLimitError(new Error('graph GET /messages 429: throttled'))).toBe(true);
    expect(isRateLimitError(new Error('[LIMIT] AUTHENTICATE Rate limit hit'))).toBe(true);
  });
  it('does not treat an ordinary failure, or a message id containing digits, as rate limiting', () => {
    expect(isRateLimitError(new Error('CONTENT_KEK is required for the local key provider in production'))).toBe(false);
    expect(isRateLimitError(new Error('gmail GET /messages/1a0429b7 500: backend error'))).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('starts at the sweep interval for an ordinary failure and doubles', () => {
    expect(backoffDelayMs(1, false)).toBe(5 * MIN);
    expect(backoffDelayMs(2, false)).toBe(10 * MIN);
    expect(backoffDelayMs(3, false)).toBe(20 * MIN);
  });
  it('starts longer for a rate limit', () => {
    expect(backoffDelayMs(1, true)).toBe(10 * MIN);
    expect(backoffDelayMs(2, true)).toBe(20 * MIN);
  });
  it('is capped', () => {
    expect(backoffDelayMs(10, true)).toBe(60 * MIN);
    e.MAIL_SYNC_BACKOFF_MAX_MINUTES = 15;
    expect(backoffDelayMs(3, false)).toBe(15 * MIN);
  });
  it('is off at zero or below, which restores retrying on every tick', () => {
    e.MAIL_SYNC_BACKOFF_MAX_MINUTES = 0;
    expect(backoffDelayMs(1, true)).toBe(0);
  });
});

describe('recording outcomes', () => {
  it('waits after a failure and counts down', () => {
    recordSyncFailure(gmailKey('u1'), new Error(PROD_QUOTA_403), 1_000);
    expect(backoffRemainingMs(gmailKey('u1'), 1_000)).toBe(10 * MIN);
    expect(backoffRemainingMs(gmailKey('u1'), 1_000 + 4 * MIN)).toBe(6 * MIN);
    expect(backoffRemainingMs(gmailKey('u1'), 1_000 + 10 * MIN)).toBe(0);
  });

  it('doubles on consecutive failures and forgets on success', () => {
    const k = accountKey('ema_1');
    recordSyncFailure(k, new Error('boom'), 0);
    recordSyncFailure(k, new Error('boom'), 0);
    expect(backoffRemainingMs(k, 0)).toBe(10 * MIN);
    recordSyncSuccess(k);
    expect(backoffRemainingMs(k, 0)).toBe(0);
    recordSyncFailure(k, new Error('boom'), 0);
    expect(backoffRemainingMs(k, 0)).toBe(5 * MIN);
  });

  it('keeps mailboxes independent, including a user and their attached account', () => {
    recordSyncFailure(gmailKey('u1'), new Error('boom'), 0);
    expect(backoffRemainingMs(gmailKey('u2'), 0)).toBe(0);
    expect(backoffRemainingMs(accountKey('u1'), 0)).toBe(0);
  });

  it('records nothing when the backoff is off', () => {
    e.MAIL_SYNC_BACKOFF_MAX_MINUTES = 0;
    expect(recordSyncFailure(gmailKey('u1'), new Error('boom'), 0)).toBe(0);
    expect(backoffRemainingMs(gmailKey('u1'), 0)).toBe(0);
  });
});
