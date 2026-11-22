/**
 * A mailbox that fails to sync is not retried on every tick.
 *
 * Prod, 2026-09-24: one Gmail user's `users.history.list` returned the
 * per-minute quota 403. `gmail_synced_at` only moves when a sync SUCCEEDS, so
 * the ADR 0144 sweep kept finding that user "stale" and retried them on every
 * 15-second proactive tick, 271 times in an hour, each retry spending the very
 * quota that was exhausted. The same loop turned the CONTENT_KEK outage earlier
 * that day into ~12,600 warnings.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runLlmClassifier, notifyNewMail } = vi.hoisted(() => ({
  runLlmClassifier: vi.fn(async () => {}),
  notifyNewMail: vi.fn(async () => {}),
}));
vi.mock('@/services/email/llm-classifier.js', () => ({
  runLlmClassifier,
  deterministicPathFor: () => null,
}));
vi.mock('@/services/email/new-mail-notify.js', () => ({ notifyNewMail }));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { sweepMailboxes } from '@/services/email/mirror-sweep.js';
import { __resetSyncBackoffForTests } from '@/services/email/sync-backoff.js';
import { connectGmailAccount } from '@/services/email-accounts/accounts.service.js';
import { syncGmailIncremental } from '@/services/google/gmail.service.js';
import {
  __failGmailMockHistory,
  __gmailMockHistoryCalls,
  __resetGmailMock,
} from '@/services/google/gmail-api.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// The message prod logged, as it reaches the caller from gfetch().
const QUOTA_403 =
  'gmail GET /history 403: {\n  "error": {\n    "code": 403,\n    "message": "Quota exceeded for quota metric \'Total Query Cost\' and limit \'Units per minute per user\' of service \'gmail.googleapis.com\' for consumer \'project_number:178917388887\'.",\n    "errors": [';

const MIN = 60_000;

let db: Kysely<DB>;
let clock = 0;

beforeEach(async () => {
  __resetGmailMock();
  __resetSyncBackoffForTests();
  runLlmClassifier.mockClear();
  notifyNewMail.mockClear();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { MAIL_SWEEP_ENABLED: boolean }).MAIL_SWEEP_ENABLED = true;
  clock = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock);
  db = await openTestDb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  await closeTestDb(db);
});

/** A connected, already-backfilled mailbox that the sweep sees as stale. */
async function staleGmailUser(name: string): Promise<string> {
  const userId = await createUser(db, name);
  await connectGmailAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  await syncGmailIncremental(db, userId); // backfill: stores the history cursor
  await makeStale(userId);
  return userId;
}

async function makeStale(userId: string): Promise<void> {
  await db
    .updateTable('users')
    // mail_swept_at too: the sweep takes each user in turn (b2c07c70), so
    // "stale" means not taken by the sweep lately either.
    .set({ gmail_synced_at: new Date(Date.now() - 60 * MIN).toISOString(), mail_swept_at: null })
    .where('id', '=', userId)
    .execute();
}

async function sweepTimes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await sweepMailboxes(db);
}

describe('a failing mailbox backs off', () => {
  it('is attempted once, not on every sweep, while Gmail answers 403 quota', async () => {
    const userId = await staleGmailUser('quota-user');
    __failGmailMockHistory(userId, QUOTA_403);
    const before = __gmailMockHistoryCalls(userId);

    await sweepTimes(6); // six proactive ticks in a row

    expect(__gmailMockHistoryCalls(userId) - before).toBe(1);
  });

  it('is attempted again once the backoff has passed, and waits longer after a second failure', async () => {
    const userId = await staleGmailUser('quota-retry');
    __failGmailMockHistory(userId, QUOTA_403);
    const before = __gmailMockHistoryCalls(userId);

    await sweepTimes(2);
    expect(__gmailMockHistoryCalls(userId) - before).toBe(1);

    clock += 11 * MIN; // past the 10-minute quota backoff
    await sweepTimes(2);
    expect(__gmailMockHistoryCalls(userId) - before).toBe(2);

    clock += 11 * MIN; // the second wait is longer (20 minutes), so this is still inside it
    await sweepTimes(2);
    expect(__gmailMockHistoryCalls(userId) - before).toBe(2);

    clock += 10 * MIN; // 21 minutes since the second failure
    await sweepTimes(1);
    expect(__gmailMockHistoryCalls(userId) - before).toBe(3);
  });

  it('a recovered mailbox syncs again and its backoff is forgotten', async () => {
    const userId = await staleGmailUser('quota-recovers');
    __failGmailMockHistory(userId, QUOTA_403);
    await sweepTimes(1);

    __failGmailMockHistory(userId, null);
    clock += 11 * MIN;
    await makeStale(userId);
    await sweepTimes(1);
    const row = await db.selectFrom('users').select('gmail_synced_at').where('id', '=', userId).executeTakeFirstOrThrow();
    // Real time has not moved (only the mocked clock), so a fresh stamp is within a minute of it.
    expect(Date.parse(row.gmail_synced_at as string)).toBeGreaterThan(Date.now() - clock - MIN);

    // Forgotten: the next failure starts from the short wait again, not the doubled one.
    __failGmailMockHistory(userId, QUOTA_403);
    await makeStale(userId);
    const before = __gmailMockHistoryCalls(userId);
    await sweepTimes(1);
    clock += 11 * MIN;
    await makeStale(userId);
    await sweepTimes(1);
    expect(__gmailMockHistoryCalls(userId) - before).toBe(2);
  });

  it('does not hold back a healthy user swept in the same pass', async () => {
    const failing = await staleGmailUser('quota-a');
    const healthy = await staleGmailUser('quota-b');
    __failGmailMockHistory(failing, QUOTA_403);
    await sweepTimes(1); // failing is now backed off

    await makeStale(healthy);
    await sweepTimes(1);

    const row = await db.selectFrom('users').select('gmail_synced_at').where('id', '=', healthy).executeTakeFirstOrThrow();
    expect(Date.now() - Date.parse(row.gmail_synced_at as string)).toBeLessThan(MIN + clock);
    expect(Date.parse(row.gmail_synced_at as string)).toBeGreaterThan(Date.now() - clock - MIN);
  });

  it('never blocks a sync the person asked for', async () => {
    const userId = await staleGmailUser('quota-explicit');
    __failGmailMockHistory(userId, QUOTA_403);
    await sweepTimes(1); // backed off
    const before = __gmailMockHistoryCalls(userId);

    await expect(syncGmailIncremental(db, userId)).rejects.toThrow(/Quota exceeded/);

    expect(__gmailMockHistoryCalls(userId) - before).toBe(1);
  });
});
