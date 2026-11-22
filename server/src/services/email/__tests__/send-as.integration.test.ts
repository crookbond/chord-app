/**
 * Send-as (ADR 0130).
 *
 * The rule everything here serves: Gmail silently REWRITES an unverified From
 * to the authenticated address and returns success, so offering an unverified
 * alias would promise something that does not happen.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let sendAsRows: {
  sendAsEmail: string;
  isPrimary?: boolean;
  verificationStatus?: string;
  displayName?: string;
}[] = [];
let throwOnList = false;

vi.mock('@/services/google/gmail-api.js', () => ({
  getGmailApi: async () => ({
    listSendAs: async () => {
      if (throwOnList) throw new Error('gmail disconnected');
      return sendAsRows;
    },
  }),
}));

const { assertSendAsAllowed, listSendAsAddresses } = await import(
  '@/services/email/send-as.js'
);

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  throwOnList = false;
  sendAsRows = [
    { sendAsEmail: 'me@example.com', isPrimary: true },
    { sendAsEmail: 'Alias@Example.com', verificationStatus: 'accepted', displayName: 'Alias' },
    { sendAsEmail: 'pending@example.com', verificationStatus: 'pending' },
  ];
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('which addresses are offered', () => {
  it('offers the primary and any verified alias', async () => {
    const rows = await listSendAsAddresses(db, userId);

    expect(rows.map((r) => r.email)).toEqual(['me@example.com', 'alias@example.com']);
  });

  it('never offers an unverified alias', async () => {
    // Gmail would send it from the primary address and report success.
    const rows = await listSendAsAddresses(db, userId);

    expect(rows.map((r) => r.email)).not.toContain('pending@example.com');
  });

  it('puts the primary first, whatever order the provider used', async () => {
    sendAsRows = [
      { sendAsEmail: 'zzz@example.com', verificationStatus: 'accepted' },
      { sendAsEmail: 'me@example.com', isPrimary: true },
    ];

    expect((await listSendAsAddresses(db, userId))[0].isPrimary).toBe(true);
  });

  it('returns nothing rather than failing when the mailbox is unreachable', async () => {
    // Composing from the mailbox's own address must still work.
    throwOnList = true;

    expect(await listSendAsAddresses(db, userId)).toEqual([]);
  });

  it('ignores a malformed entry', async () => {
    sendAsRows = [{ sendAsEmail: 'not-an-address', verificationStatus: 'accepted' }];

    expect(await listSendAsAddresses(db, userId)).toEqual([]);
  });
});

describe('checking a From on the way in', () => {
  it('accepts a verified alias, case-insensitively', async () => {
    expect(await assertSendAsAllowed(db, userId, 'ALIAS@example.com')).toBe('alias@example.com');
  });

  it('refuses an unverified one', async () => {
    expect(await assertSendAsAllowed(db, userId, 'pending@example.com')).toBeNull();
  });

  it('refuses an address the mailbox never mentioned', async () => {
    // The client picked from a list we gave it, but the request is a client's.
    expect(await assertSendAsAllowed(db, userId, 'someone@elsewhere.example')).toBeNull();
  });

  it('treats an absent From as "use the default"', async () => {
    expect(await assertSendAsAllowed(db, userId, undefined)).toBeNull();
  });
});
