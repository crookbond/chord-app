/**
 * One AI pipeline run per user per sync round — not one per mailbox (ADR 0137).
 *
 * `afterSync` runs USER-scoped work ("everything of this user's that is
 * unclassified or unmined") but is called from each MAILBOX's sync. The bulk
 * paths walk mailboxes with `for … await`, so the calls never overlap: a user
 * with three mailboxes paid three full pipelines, back to back, over the same
 * rows. That is N× the LLM spend, and N independent extractions of the same
 * thread — which is how one Amex email became two differently-worded to-dos.
 *
 * `runLlmClassifier` stands in for the pipeline here: `afterSync` calls it
 * unconditionally, so counting it counts passes.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above every import, so the factory may not close over a
// module-level variable. `vi.hoisted` runs with it and can.
const { runLlmClassifier } = vi.hoisted(() => ({ runLlmClassifier: vi.fn(async () => {}) }));
vi.mock('@/services/email/llm-classifier.js', () => ({ runLlmClassifier }));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  connectGmailAccount,
  connectImapAccount,
  connectOutlookAccount,
  maybeSyncAccounts,
  syncAccount,
  syncAllAccounts,
  syncAllUserMail,
} from '@/services/email-accounts/accounts.service.js';
import { __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetGmailMock();
  __resetOutlookMock();
  __resetImapMock();
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'sync-round-user');
});

afterEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
  (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

/**
 * Three mailboxes, and every connect fires its own initial sync. Settle those
 * first so the counter starts from a quiet mailbox set rather than from the
 * connects.
 */
async function connectThreeMailboxes(): Promise<void> {
  await connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  await connectImapAccount(db, userId, {
    emailAddress: 'family@yahoo.example',
    password: 'app-password',
    preset: 'yahoo',
  });
  await connectGmailAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });
  // The connects' fire-and-forget syncs are floating promises; run each
  // mailbox once deterministically so nothing lands mid-assertion.
  for (const account of await listAccounts(db, userId)) {
    await syncAccount(db, account);
  }
  runLlmClassifier.mockClear();
}

describe('one AI pipeline run per sync round', () => {
  it('sweeping three mailboxes runs the pipeline ONCE, not three times', async () => {
    await connectThreeMailboxes();
    expect((await listAccounts(db, userId)).length).toBe(3);

    // windowMs 0 so the throttle skips nothing — every mailbox really syncs.
    await maybeSyncAccounts(db, userId, 0);

    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('the explicit Sync-now button is one round too', async () => {
    await connectThreeMailboxes();
    await syncAllAccounts(db, userId);
    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('primary Gmail plus attached mailboxes is still one round', async () => {
    await connectThreeMailboxes();
    await syncAllUserMail(db, userId);
    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });

  it('a lone mailbox sync outside a round still runs the pipeline', async () => {
    await connectThreeMailboxes();
    const [account] = await listAccounts(db, userId);
    await syncAccount(db, account);
    // Not a regression guard for the count — a guard that scoping the round
    // did not simply switch the pipeline off for single-mailbox callers.
    expect(runLlmClassifier).toHaveBeenCalledTimes(1);
  });
});
