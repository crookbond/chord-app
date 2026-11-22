/**
 * IMAP IDLE (ADR 0118) after the user reconnects the mailbox with a new app
 * password: the watcher must log in with the new one, not the password it
 * was started with.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  // Credentials are sealed at rest; the test needs a key to seal with.
  process.env.MASTER_KEY ||= Buffer.alloc(32, 7).toString('base64');
  return { logins: [] as string[], goodPassword: 'new-app-password' };
});

vi.mock('imapflow', () => {
  class FakeImapFlow {
    usable = false;
    private pass: string;
    constructor(opts: { auth: { pass: string } }) {
      this.pass = opts.auth.pass;
    }
    on() {
      return this;
    }
    async connect() {
      fake.logins.push(this.pass);
      if (this.pass !== fake.goodPassword) throw new Error('AUTHENTICATIONFAILED');
      this.usable = true;
    }
    async mailboxOpen() {}
    async idle() {
      return new Promise<void>(() => {});
    }
    async logout() {
      this.usable = false;
    }
  }
  return { ImapFlow: FakeImapFlow };
});

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { sealAuthBlob } from '@/services/email-accounts/account-utils.js';
import { connectImapAccount } from '@/services/email-accounts/accounts.service.js';
import { __resetImapMock } from '@/services/email-accounts/imap-api.js';
import { startImapIdle, type IdleHandle } from '@/services/email-accounts/imap-idle.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

const RETRY_BASE_MS = 30_000;

let db: Kysely<DB>;
let userId: string;
let handle: IdleHandle | null = null;
let retries: Array<() => void>;
const saved = { ...env };

beforeEach(async () => {
  __resetImapMock();
  fake.logins.length = 0;
  Object.assign(env as Record<string, unknown>, {
    IMAP_PROVIDER: 'mock',
    MAIL_PUSH_ENABLED: true,
    IMAP_IDLE_ENABLED: true,
    IMAP_IDLE_REFRESH_MS: 60 * 60 * 1000,
  });
  // Hold the reconnect backoff instead of waiting 30 seconds for it.
  retries = [];
  const realSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
    if (ms === RETRY_BASE_MS) {
      retries.push(fn);
      return { unref() {} } as unknown as NodeJS.Timeout;
    }
    return realSetTimeout(fn, ms);
  }) as typeof setTimeout);
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});

afterEach(async () => {
  handle?.stop();
  handle = null;
  vi.restoreAllMocks();
  Object.assign(env as Record<string, unknown>, saved);
  await closeTestDb(db);
});

/** Connect (or reconnect) the mailbox. The mock provider stores no
 *  credential, so seal the one a real connect would. */
async function connect(password: string): Promise<void> {
  await connectImapAccount(db, userId, { emailAddress: 'family@yahoo.example', password, preset: 'yahoo' });
  await db
    .updateTable('email_accounts')
    .set(
      sealAuthBlob({
        host: 'imap.mail.yahoo.com',
        port: 993,
        smtpHost: 'smtp.mail.yahoo.com',
        smtpPort: 465,
        username: 'family@yahoo.example',
        password,
      }),
    )
    .where('user_id', '=', userId)
    .execute();
}

describe('imap idle after a reconnect', () => {
  it('retries with the password the mailbox was reconnected with', async () => {
    await connect('old-app-password');
    handle = startImapIdle(db);
    expect(await waitFor(() => retries.length === 1)).toBe(true);
    expect(fake.logins).toEqual(['old-app-password']);

    await connect('new-app-password');
    retries.shift()!();

    expect(await waitFor(() => fake.logins.length === 2)).toBe(true);
    expect(fake.logins[1]).toBe('new-app-password');
  });

  it('a refresh restarts a watcher whose credential changed', async () => {
    (env as { IMAP_IDLE_REFRESH_MS: number }).IMAP_IDLE_REFRESH_MS = 50;
    await connect('old-app-password');
    handle = startImapIdle(db);
    expect(await waitFor(() => fake.logins.length >= 1)).toBe(true);

    await connect('new-app-password');
    expect(await waitFor(() => fake.logins.includes('new-app-password'))).toBe(true);
  });
});
