/**
 * Opening an email waited for the model's one-time check (EMAIL_READ_TIME_WAIT_MS)
 * only AFTER reading the thread, and only then ran its other lookups (provider
 * link, images, unsubscribe, flight/parcel) one after another. In prod one open
 * took 2.36 s with a 1.5 s limit: the limit plus the thread read plus the
 * lookups. Now the limit counts from when the request arrived and the lookups
 * run during the wait.
 *
 * Nothing here is timed. The model and the lookups are held shut and opened by
 * the test, and the thread read moves the clock the route reads instead of
 * taking real time, so each claim is an order of events: the lookups all start
 * before any finishes, and a read that used up the limit is not followed by a
 * second wait.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';
import { hashSessionToken } from '@/utils/session-token.js';

const gate = vi.hoisted(() => {
  const g = { open: () => {}, promise: Promise.resolve() as Promise<void> };
  g.promise = new Promise<void>((resolve) => {
    g.open = resolve;
  });
  return g;
});

/** The four lookups: how many have started, and the gate that holds them. */
const lookups = vi.hoisted(() => {
  const l = { started: 0, open: () => {}, promise: Promise.resolve() as Promise<void> };
  l.promise = new Promise<void>((resolve) => {
    l.open = resolve;
  });
  return l;
});
const lookup = async (): Promise<void> => {
  lookups.started += 1;
  await lookups.promise;
};

/** How far the thread read moves the route's clock (Date.now). */
const clock = vi.hoisted(() => ({ readTakesMs: 0, ahead: 0 }));

// The model never answers until the test ends: the open must not wait for it.
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'held-mock',
    defaultModel: 'held-mock',
    supportsNativeTools: false,
    complete: async () => {
      await gate.promise;
      return JSON.stringify({ items: [] });
    },
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
    __resetLlmCacheForTests: () => {},
  };
});

vi.mock('@/services/google/gmail.service.js', async (orig) => {
  const mod = (await orig()) as typeof import('@/services/google/gmail.service.js');
  return {
    ...mod,
    getThread: async (...args: Parameters<typeof mod.getThread>) => {
      clock.ahead += clock.readTakesMs;
      return mod.getThread(...args);
    },
  };
});
vi.mock('@/services/email/trackables.js', async (orig) => {
  const mod = (await orig()) as typeof import('@/services/email/trackables.js');
  return {
    ...mod,
    threadTrackables: async (...args: Parameters<typeof mod.threadTrackables>) => {
      await lookup();
      return mod.threadTrackables(...args);
    },
  };
});
vi.mock('@/services/email/unsubscribe.service.js', async (orig) => {
  const mod = (await orig()) as typeof import('@/services/email/unsubscribe.service.js');
  return {
    ...mod,
    resolveThreadUnsubscribe: async (...args: Parameters<typeof mod.resolveThreadUnsubscribe>) => {
      await lookup();
      return mod.resolveThreadUnsubscribe(...args);
    },
  };
});
vi.mock('@/services/email/image-senders.js', async (orig) => {
  const mod = (await orig()) as typeof import('@/services/email/image-senders.js');
  return {
    ...mod,
    autoLoadsImages: async (...args: Parameters<typeof mod.autoLoadsImages>) => {
      await lookup();
      return mod.autoLoadsImages(...args);
    },
  };
});
vi.mock('@/services/email-accounts/accounts.service.js', async (orig) => {
  const mod = (await orig()) as typeof import('@/services/email-accounts/accounts.service.js');
  return {
    ...mod,
    threadProviderLink: async (...args: Parameters<typeof mod.threadProviderLink>) => {
      await lookup();
      return mod.threadProviderLink(...args);
    },
  };
});

const mutableEnv = env as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let tok: string;
let threadId: string;

beforeEach(async () => {
  for (const k of ['GMAIL_ENABLED', 'EMAIL_READ_TIME_WAIT_MS', 'EMAIL_PREPROCESS_READTIME_ENABLED', 'EMAIL_READ_TIME_MAGICS_ENABLED'])
    saved[k] = mutableEnv[k];
  mutableEnv.GMAIL_ENABLED = true;
  mutableEnv.EMAIL_READ_TIME_WAIT_MS = 0;
  gate.promise = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  lookups.started = 0;
  lookups.promise = new Promise<void>((resolve) => {
    lookups.open = resolve;
  });
  clock.readTakesMs = 0;
  clock.ahead = 0;
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock.ahead);
  mutableEnv.EMAIL_PREPROCESS_READTIME_ENABLED = false;
  mutableEnv.EMAIL_READ_TIME_MAGICS_ENABLED = true;
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const userId = await createUser(db, 'reader');
  tok = newId('t');
  const now = new Date().toISOString();
  await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
  threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: 'g-open-1',
      subject: '20% off this weekend',
      snippet: 'Save on everything',
      from_name: 'Retailer',
      from_email: 'deals@retailer.example',
      last_message_at: now,
      message_count: 1,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']) as never,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: 'gm-open-1',
      gmail_thread_id: 'g-open-1',
      internal_date: now,
      created_at: now,
      subject: '20% off this weekend',
      from_name: 'Retailer',
      from_email: 'deals@retailer.example',
      body_text: 'Save on everything this weekend.',
      snippet: 'Save on everything',
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']) as never,
      attachments_json: '[]',
    })
    .execute();
});

afterEach(async () => {
  gate.open();
  lookups.open();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) mutableEnv[k] = v;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

const open = () => fetch(`${base}${API.meEmailThread(threadId)}`, { headers: { [SESSION_HEADER]: tok } });

/** The request comes back while the model is still shut, or the test fails
 *  (instead of hanging) saying it waited. */
const beforeTheModel = <T,>(request: Promise<T>): Promise<T> =>
  Promise.race([
    request,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the open waited for the model')), 15_000)),
  ]);

it('the four lookups run side by side, not one after another', async () => {
  const response = open();
  // Held shut, the lookups can only all have started if none waited for another.
  const allStarted = await waitFor(() => lookups.started === 4);
  lookups.open();
  const res = await beforeTheModel(response);
  expect(allStarted).toBe(true);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { thread: { id: string } }).thread.id).toBe(threadId);
});

it('a thread read that used up the limit is not followed by a second wait', async () => {
  // The limit is a minute, and the read takes all of it. Counted from when the
  // open arrived, nothing is left to wait for; counted from after the read, the
  // open would wait the whole minute on the shut model.
  mutableEnv.EMAIL_READ_TIME_WAIT_MS = 60_000;
  clock.readTakesMs = 60_000;
  lookups.open();
  const res = await beforeTheModel(open());
  expect(res.status).toBe(200);
});
