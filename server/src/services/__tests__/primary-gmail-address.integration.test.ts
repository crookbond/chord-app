/**
 * The primary Gmail's own address is not the sign-in email.
 *
 * Reported 2026-11-16: an account made with Sign in with Microsoft
 * (ownertest@hotmail.com) that later connected Gmail showed the Hotmail
 * address as the Gmail mailbox - in the compose From picker, and in the
 * default-mailbox "from" line on chat-drafted email - because every reader
 * took `users.email`, which stays the Microsoft address when Google is
 * connected afterwards.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type EmailStatus } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { resolveSendMailbox } from '@/services/email/default-mailbox.js';
import {
  __resetGmailAddressLookupsForTests,
  gmailAddressDefault,
  primaryGmailAddress,
} from '@/services/email/primary-gmail-address.js';
import { __resetGmailMock, MOCK_GMAIL_ADDRESS } from '@/services/google/gmail-api.js';
import { disconnectGmail } from '@/services/google/gmail.service.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('the primary Gmail address', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    __resetGmailMock();
    __resetGmailAddressLookupsForTests();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const status = async (userId: string) => {
    const token = newId('t');
    const now = new Date().toISOString();
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
      .execute();
    const res = await fetch(`${base}${API.meEmailStatus}`, { headers: { [SESSION_HEADER]: token } });
    return (await res.json()) as EmailStatus;
  };

  /** Signed in with Microsoft, Gmail connected afterwards (createUser grants the Gmail scope). */
  const microsoftUserWithGmail = async () => {
    const id = await createUser(db, 'crookbond', 'John Doe');
    await db
      .updateTable('users')
      .set({ email: 'ownertest@hotmail.com', microsoft_sub: 'tid:oid-crookbond', google_sub: 'google-123' })
      .where('id', '=', id)
      .execute();
    return id;
  };

  it('never offers the Microsoft sign-in email as the Gmail mailbox', async () => {
    const id = await microsoftUserWithGmail();
    expect((await status(id)).connected).toBe(true);
    expect(await primaryGmailAddress(db, id)).not.toBe('ownertest@hotmail.com');
    const from = await resolveSendMailbox(db, id);
    expect(from?.accountId).toBeNull();
    expect(from?.address).not.toBe('ownertest@hotmail.com');
  });

  it('reads the Gmail address from Gmail once and keeps it', async () => {
    const id = await microsoftUserWithGmail();
    expect((await status(id)).gmailAddress).toBe(MOCK_GMAIL_ADDRESS);
    expect(await gmailAddressDefault.get(db, id)).toBe(MOCK_GMAIL_ADDRESS);
    expect((await resolveSendMailbox(db, id))?.address).toBe(MOCK_GMAIL_ADDRESS);
  });

  it('uses the sign-in email for an account made with Google, where it is the Gmail', async () => {
    const id = await createUser(db, 'ann', 'Ann Lee');
    await db.updateTable('users').set({ email: 'Ann@Gmail.com', google_sub: 'google-ann' }).where('id', '=', id).execute();
    expect((await status(id)).gmailAddress).toBe('ann@gmail.com');
    expect(await gmailAddressDefault.get(db, id)).toBeNull();
  });

  it('forgets the address when Gmail is disconnected', async () => {
    const id = await microsoftUserWithGmail();
    await status(id);
    await disconnectGmail(db, id);
    // (With the mock provider Gmail always reads as connected, so a status
    // read would look it up again; the stored value is what disconnect owns.)
    expect(await gmailAddressDefault.get(db, id)).toBeNull();
  });
});
