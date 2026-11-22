/**
 * Real push (ADR 0118). What can honestly be tested here is everything except
 * the network: no public URL exists, so Gmail cannot publish to us and Graph
 * cannot validate a callback. What IS testable is the part that decides what a
 * notification means and when a registration needs renewing - which is where
 * the bugs would be anyway.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { parseGmailNotification } from '@/services/email/mail-push-providers.js';
import {
  armMailbox,
  dueForRenewal,
  registerArmer,
  resolveSubscription,
} from '@/services/email/mail-subscriptions.js';
import { __resetMailPush, setMailboxSyncRunner, wakeMailbox } from '@/services/email/mail-push.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  __resetMailPush();
  db = await openTestDb();
  userId = await createUser(db, 'alice');
});
afterEach(async () => {
  __resetMailPush();
  await closeTestDb(db);
});

describe('parsing a Pub/Sub notification', () => {
  const envelope = (payload: unknown) => ({
    message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') },
  });

  it('reads the mailbox address out of the envelope', () => {
    const out = parseGmailNotification(envelope({ emailAddress: 'me@example.com', historyId: 9 }));

    expect(out).toEqual({ emailAddress: 'me@example.com' });
  });

  it('returns null for anything malformed rather than throwing', () => {
    // Pub/Sub retries on a non-2xx, so a payload we can never parse would be
    // redelivered forever. Null lets the route answer 204 and move on.
    expect(parseGmailNotification({})).toBeNull();
    expect(parseGmailNotification({ message: { data: 'not-base64-json' } })).toBeNull();
    expect(parseGmailNotification(null)).toBeNull();
    expect(parseGmailNotification(envelope({ historyId: 9 }))).toBeNull();
  });
});

describe('subscription lifecycle', () => {
  const armOk = (expiresAt: Date) =>
    vi.fn(async () => ({ externalId: 'sub-1', expiresAt }));

  it('records what the provider handed back', async () => {
    const expires = new Date(Date.now() + 3 * 24 * 3600_000);
    registerArmer('outlook', armOk(expires));

    const ok = await armMailbox(db, { userId, accountId: null, provider: 'outlook' });

    expect(ok).toBe(true);
    const row = await db
      .selectFrom('mail_subscriptions')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.external_id).toBe('sub-1');
    expect(row.client_state).toBeTruthy();
  });

  it('keeps the same clientState across a renewal', async () => {
    // Notifications already in flight carry the old secret; rotating it every
    // few days would drop them.
    const armer = armOk(new Date(Date.now() + 3 * 24 * 3600_000));
    registerArmer('outlook', armer);
    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });
    const first = await db
      .selectFrom('mail_subscriptions')
      .select('client_state')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });

    const second = await db
      .selectFrom('mail_subscriptions')
      .select('client_state')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(second.client_state).toBe(first.client_state);
  });

  it('records a failure instead of throwing, because polling continues', async () => {
    registerArmer('outlook', vi.fn(async () => ({ externalId: 'x', expiresAt: new Date() })));
    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });
    registerArmer(
      'outlook',
      vi.fn(async () => {
        throw new Error('topic not configured');
      }),
    );

    const ok = await armMailbox(db, { userId, accountId: null, provider: 'outlook' });

    expect(ok).toBe(false);
    const row = await db
      .selectFrom('mail_subscriptions')
      .selectAll()
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.failed_at).toBeTruthy();
    expect(row.last_error).toContain('topic not configured');
  });

  it('finds what is close to expiring, and leaves the rest', async () => {
    registerArmer('outlook', armOk(new Date(Date.now() + 60 * 60 * 1000)));
    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });

    expect(await dueForRenewal(db)).toHaveLength(1);

    registerArmer('outlook', armOk(new Date(Date.now() + 5 * 24 * 3600_000)));
    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });

    expect(await dueForRenewal(db)).toHaveLength(0);
  });

  it('refuses a notification carrying the wrong clientState', async () => {
    // Graph's callback is otherwise an unauthenticated POST.
    registerArmer('outlook', armOk(new Date(Date.now() + 3 * 24 * 3600_000)));
    await armMailbox(db, { userId, accountId: null, provider: 'outlook' });
    const row = await db
      .selectFrom('mail_subscriptions')
      .select('client_state')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();

    expect(await resolveSubscription(db, { externalId: 'sub-1' }, 'wrong')).toBeNull();
    expect(await resolveSubscription(db, { externalId: 'sub-1' }, row.client_state)).toMatchObject(
      { userId },
    );
  });
});

describe('waking a mailbox', () => {
  it('coalesces a burst into one sync', async () => {
    // Gmail publishes per history change, so five messages arriving together
    // is five notifications for one sync's worth of work.
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    setMailboxSyncRunner(run);

    wakeMailbox(db, userId, null);
    wakeMailbox(db, userId, null);
    wakeMailbox(db, userId, null);
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('keeps separate mailboxes separate', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    setMailboxSyncRunner(run);

    wakeMailbox(db, userId, null);
    wakeMailbox(db, userId, 'acct-1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('survives a sync that throws', async () => {
    // A failed push-triggered sync is not an incident: the poll retries.
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new Error('provider down');
    });
    setMailboxSyncRunner(run);

    wakeMailbox(db, userId, null);
    // Not rejecting IS the assertion: the throw is swallowed inside the
    // drain, so it never escapes as an unhandled rejection.
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('the Gmail push webhook', () => {
  it('wakes a mailbox whose address was stored with capitals', async () => {
    // An attached mailbox keeps the address as typed; Gmail's notification
    // names it in lower case, and a plain `=` never matched.
    const e = env as { MAIL_PUSH_ENABLED: boolean; MAIL_PUSH_GMAIL_TOKEN: string };
    const saved = { enabled: e.MAIL_PUSH_ENABLED, token: e.MAIL_PUSH_GMAIL_TOKEN };
    e.MAIL_PUSH_ENABLED = true;
    e.MAIL_PUSH_GMAIL_TOKEN = 'push-token';
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({ id: 'acct-kids', user_id: userId, provider: 'gmail', email_address: 'Kids.School@Gmail.com', created_at: now, updated_at: now })
      .execute();
    await db
      .insertInto('mail_subscriptions')
      .values({ id: 'sub-kids', user_id: userId, account_id: 'acct-kids', provider: 'gmail', client_state: 'cs', expires_at: now, created_at: now, updated_at: now })
      .execute();
    const run = vi.fn(async () => {});
    setMailboxSyncRunner(run);

    const server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const data = Buffer.from(JSON.stringify({ emailAddress: 'kids.school@gmail.com', historyId: 1 })).toString('base64');
      const res = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/webhooks/mail/gmail?token=push-token`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { data } }) },
      );
      expect(res.status).toBe(204);
      expect(await waitFor(() => run.mock.calls.length > 0)).toBe(true);
      expect(run.mock.calls[0]).toEqual(expect.arrayContaining([userId, 'acct-kids']));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      e.MAIL_PUSH_ENABLED = saved.enabled;
      e.MAIL_PUSH_GMAIL_TOKEN = saved.token;
    }
  });
});
