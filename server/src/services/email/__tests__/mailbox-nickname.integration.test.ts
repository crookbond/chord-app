/**
 * Naming a mailbox (ADR 0145).
 *
 * The nickname gets its OWN column rather than reusing `display_name`, which
 * the provider owns and rewrites on every re-attach — the ADR 0141 failure
 * (writing into a column the sync owns) in a different place. The re-attach
 * case below is the one that pins that reasoning.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mailboxDisplayName,
  normalizeMailboxNickname,
  primaryMailboxDisplayName,
  MAILBOX_NICKNAME_MAX,
} from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  connectOutlookAccount,
  setAccountPrefs,
} from '@/services/email-accounts/accounts.service.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import { __resetOutlookMock } from '@/services/email-accounts/outlook-api.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetOutlookMock();
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
  db = await openTestDb();
  userId = await createUser(db, 'nick-user');
});

afterEach(async () => {
  (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
  await closeTestDb(db);
});

const connect = () =>
  connectOutlookAccount(db, userId, {
    code: 'mock',
    codeVerifier: 'mock',
    redirectUri: 'chord://oauthredirect',
  });

describe('display name rule', () => {
  it('prefers the nickname, falls back to the local part', () => {
    expect(mailboxDisplayName('Work', 'john_doe@outlook.example')).toBe('Work');
    expect(mailboxDisplayName(null, 'john_doe@outlook.example')).toBe('john_doe');
  });

  it('treats a whitespace-only nickname as no nickname', () => {
    // Otherwise the chip renders blank and the mailbox becomes unpickable.
    expect(mailboxDisplayName('   ', 'jdoe@yahoo.example')).toBe('jdoe');
  });

  it('names the primary Gmail', () => {
    expect(primaryMailboxDisplayName(null)).toBe('Gmail');
    expect(primaryMailboxDisplayName('Personal')).toBe('Personal');
  });

  it('normalizes an empty nickname to null and caps the length', () => {
    expect(normalizeMailboxNickname('  ')).toBeNull();
    expect(normalizeMailboxNickname(null)).toBeNull();
    expect(normalizeMailboxNickname('  Work  ')).toBe('Work');
    expect(normalizeMailboxNickname('x'.repeat(200))).toHaveLength(MAILBOX_NICKNAME_MAX);
  });
});

describe('setAccountPrefs', () => {
  it('stores a nickname and returns it on the summary', async () => {
    const account = await connect();

    const updated = await setAccountPrefs(db, userId, account.id, { nickname: 'Work' });

    expect(updated?.nickname).toBe('Work');
  });

  it('clears the nickname when given an empty string', async () => {
    const account = await connect();
    await setAccountPrefs(db, userId, account.id, { nickname: 'Work' });

    const updated = await setAccountPrefs(db, userId, account.id, { nickname: '' });

    expect(updated?.nickname).toBeNull();
  });

  it('renaming does not disturb the label-push opt-in', async () => {
    // A partial patch: an absent field is left alone. Renaming a mailbox must
    // not silently switch its push off.
    const account = await connect();
    await setAccountPrefs(db, userId, account.id, { labelPushEnabled: true });

    const updated = await setAccountPrefs(db, userId, account.id, { nickname: 'Work' });

    expect(updated?.labelPushEnabled).toBe(true);
    expect(updated?.nickname).toBe('Work');
  });

  it('toggling push does not disturb the nickname', async () => {
    const account = await connect();
    await setAccountPrefs(db, userId, account.id, { nickname: 'Work' });

    const updated = await setAccountPrefs(db, userId, account.id, { labelPushEnabled: true });

    expect(updated?.nickname).toBe('Work');
  });

  it('survives a re-attach, which rewrites the provider display name', async () => {
    // The whole reason for a separate column. `insertAccount` refreshes
    // `display_name` on re-attach; a nickname stored there would be erased by
    // reconnecting a mailbox.
    const account = await connect();
    await setAccountPrefs(db, userId, account.id, { nickname: 'Work' });

    await connect();

    const [row] = await listAccounts(db, userId);
    expect(row.nickname).toBe('Work');
  });

  it('is null for another user', async () => {
    const account = await connect();
    const bob = await createUser(db, 'bob');

    expect(await setAccountPrefs(db, bob, account.id, { nickname: 'Mine' })).toBeNull();
  });
});
