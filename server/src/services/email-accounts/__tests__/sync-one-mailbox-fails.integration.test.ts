/**
 * One mailbox failing must not stop the others syncing (ADR 0218).
 *
 * `syncAllAccounts` walked the mailboxes in connect order and re-threw the
 * first non-auth error, so a throttled Outlook/Yahoo at the front of the list
 * left every mailbox after it unsynced: mail deleted there stayed in Chord's
 * inbox however often the user pulled to refresh.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { outlookFails } = vi.hoisted(() => ({ outlookFails: { on: false } }));
vi.mock('@/services/email-accounts/outlook.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/email-accounts/outlook.service.js')>();
  return {
    ...real,
    syncOutlookAccount: async (...args: Parameters<typeof real.syncOutlookAccount>) => {
      if (outlookFails.on) throw new Error('graph delta 503 Service Unavailable');
      return real.syncOutlookAccount(...args);
    },
  };
});

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  connectImapAccount,
  connectOutlookAccount,
  syncAccount,
  syncAllAccounts,
} from '@/services/email-accounts/accounts.service.js';
import { __removeImapMockMessage, __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { listThreads } from '@/services/google/gmail.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  outlookFails.on = false;
  __resetOutlookMock();
  __resetImapMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'one-mailbox-fails');
});

afterEach(async () => {
  outlookFails.on = false;
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  (env as { IMAP_PROVIDER: string }).IMAP_PROVIDER = 'real';
  await closeTestDb(db);
});

describe('syncAllAccounts with one failing mailbox', () => {
  it('still syncs the others, so mail removed there leaves the inbox', async () => {
    // Outlook first: it is the mailbox the old loop stopped at.
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
    const accounts = await listAccounts(db, userId);
    for (const a of accounts) await syncAccount(db, a);
    const imap = accounts.find((a) => a.provider === 'imap')!;

    const inboxHasPrescription = async () =>
      (await listThreads(db, userId, { mode: 'traditional', limit: 100 })).some((t) =>
        t.subject.includes('prescription'),
      );
    expect(await inboxHasPrescription()).toBe(true);

    // Deleted in Yahoo; Outlook's server is having a bad minute.
    __removeImapMockMessage(imap.id, 102, { toTrash: true });
    outlookFails.on = true;

    await expect(syncAllAccounts(db, userId, 'mirror')).rejects.toThrow(/503/);
    expect(await inboxHasPrescription()).toBe(false);
  });
});
