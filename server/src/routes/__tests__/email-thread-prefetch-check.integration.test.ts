/**
 * The reader pre-loads the next email (`?prefetch=1`). That used to skip the
 * one-time check, so opening the pre-loaded email still waited up to
 * EMAIL_READ_TIME_WAIT_MS for it. The prefetch now STARTS the check, so the open
 * finds it done or joins it, and the model is asked once per email either way.
 * It follows the warm-up's mail rule (ADR 0221): old, already-read mail is not
 * checked before anyone opens it.
 *
 * No sync runs here, so every model call is this test's own.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const gate = vi.hoisted(() => {
  const g = {
    open: () => {},
    promise: Promise.resolve() as Promise<void>,
    /** Calls carrying the one-time check's own prompt (it offers "advisory"). */
    checks: 0,
    reset() {
      g.promise = new Promise<void>((resolve) => {
        g.open = resolve;
      });
    },
  };
  g.reset();
  return g;
});

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'gated-mock',
    defaultModel: 'gated-mock',
    supportsNativeTools: false,
    complete: async (messages: { role: string; content: string }[]) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const isCheck = system.includes('"advisory"');
      if (isCheck) gate.checks += 1;
      await gate.promise;
      if (isCheck) return JSON.stringify({ kind: 'advisory', note: 'This looks like a phishing attempt, be careful.' });
      return JSON.stringify({ kind: 'other' });
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

const mutableEnv = env as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let tok: string;
let userId: string;

async function thread(opts: { gid: string; unread: boolean; daysOld: number }): Promise<string> {
  const at = new Date(Date.now() - opts.daysOld * 86_400_000).toISOString();
  const labels = JSON.stringify(opts.unread ? ['INBOX', 'UNREAD'] : ['INBOX']) as never;
  const id = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: opts.gid,
      subject: 'Verify your account now',
      snippet: 'Click here to keep your account',
      from_name: 'Bank',
      from_email: 'alerts@bank-secure.example',
      last_message_at: at,
      message_count: 1,
      is_unread: opts.unread ? 1 : 0,
      gmail_label_ids: labels,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: `${opts.gid}-m`,
      gmail_thread_id: opts.gid,
      internal_date: at,
      created_at: at,
      subject: 'Verify your account now',
      from_name: 'Bank',
      from_email: 'alerts@bank-secure.example',
      body_text: 'Click the link below to keep your account open.',
      snippet: 'Click here to keep your account',
      is_unread: opts.unread ? 1 : 0,
      gmail_label_ids: labels,
      attachments_json: '[]',
      // What a Gmail sync stores for a message with no invite (ADR 0080).
      ics_text: '',
    })
    .execute();
  return id;
}

const get = (path: string) => fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: tok } });
const readMarks = async (gid: string) =>
  (
    await db
      .selectFrom('email_extraction_marks')
      .select('kind')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .where('kind', '=', 'read')
      .execute()
  ).length;
/** The request comes back while the model is held, or the test fails (instead
 *  of hanging) saying it waited. */
const beforeTheModel = <T,>(request: Promise<T>): Promise<T> =>
  Promise.race([
    request,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the request waited for the model')), 15_000)),
  ]);
const until = async (cond: () => Promise<boolean>, ms = 5000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
};

beforeEach(async () => {
  for (const k of [
    'GMAIL_ENABLED',
    'EMAIL_READ_TIME_WAIT_MS',
    'EMAIL_PREPROCESS_READTIME_ENABLED',
    'EMAIL_READ_TIME_MAGICS_ENABLED',
    'EMAIL_PREFETCH_READTIME_ENABLED',
  ])
    saved[k] = mutableEnv[k];
  mutableEnv.GMAIL_ENABLED = true;
  // Far longer than beforeTheModel's guard: a request that waited on the held
  // model fails the race, so no test here measures how long anything took.
  mutableEnv.EMAIL_READ_TIME_WAIT_MS = 60_000;
  mutableEnv.EMAIL_PREPROCESS_READTIME_ENABLED = false;
  mutableEnv.EMAIL_READ_TIME_MAGICS_ENABLED = true;
  mutableEnv.EMAIL_PREFETCH_READTIME_ENABLED = true;
  gate.reset();
  gate.checks = 0;
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userId = await createUser(db, 'reader');
  tok = newId('t');
  const now = new Date().toISOString();
  await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
});

afterEach(async () => {
  gate.open();
  for (const [k, v] of Object.entries(saved)) mutableEnv[k] = v;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

it('a pre-loaded email opens at once, caution included, after one check', async () => {
  const id = await thread({ gid: 'g-next', unread: true, daysOld: 0 });

  // The model is held shut: the prefetch comes back anyway.
  expect((await beforeTheModel(get(`${API.meEmailThread(id)}?prefetch=1`))).status).toBe(200);
  await until(async () => gate.checks === 1);

  gate.open();
  await until(async () => (await readMarks('g-next')) === 1);

  const opened = (await (await get(API.meEmailThread(id))).json()) as { readAdvisory?: { note: string } | null };
  expect(opened.readAdvisory?.note).toMatch(/phishing/i);
  expect(gate.checks).toBe(1);
});

it('an open while the pre-load check is still running joins it, not a second check', async () => {
  const id = await thread({ gid: 'g-next', unread: true, daysOld: 0 });
  await get(`${API.meEmailThread(id)}?prefetch=1`);
  await until(async () => gate.checks === 1);

  const opening = get(API.meEmailThread(id));
  await new Promise((r) => setTimeout(r, 50));
  gate.open();
  const opened = (await (await opening).json()) as { readAdvisory?: { note: string } | null };
  expect(opened.readAdvisory?.note).toMatch(/phishing/i);
  expect(gate.checks).toBe(1);
  expect(await readMarks('g-next')).toBe(1);
});

it('old, already-read mail is not checked before anyone opens it (ADR 0221)', async () => {
  const id = await thread({ gid: 'g-old', unread: false, daysOld: 30 });
  gate.open();
  await get(`${API.meEmailThread(id)}?prefetch=1`);
  await settleBackgroundWork();
  expect(gate.checks).toBe(0);
  expect(await readMarks('g-old')).toBe(0);

  // Opening it still runs the check, as before.
  await get(API.meEmailThread(id));
  await until(async () => (await readMarks('g-old')) === 1);
  expect(gate.checks).toBe(1);
});

it('the switch turns the pre-load check off', async () => {
  mutableEnv.EMAIL_PREFETCH_READTIME_ENABLED = false;
  const id = await thread({ gid: 'g-next', unread: true, daysOld: 0 });
  gate.open();
  await get(`${API.meEmailThread(id)}?prefetch=1`);
  await settleBackgroundWork();
  expect(gate.checks).toBe(0);
});

it('the phone filling its store (?prefetch=cache) gets the email but starts no check (ADR 0302)', async () => {
  const id = await thread({ gid: 'g-store', unread: true, daysOld: 0 });
  gate.open();
  const res = await get(`${API.meEmailThread(id)}?prefetch=cache`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { thread: { id: string }; messages: unknown[] };
  expect(body.thread.id).toBe(id);
  expect(body.messages).toHaveLength(1);
  await settleBackgroundWork();
  expect(gate.checks).toBe(0);
  expect(await readMarks('g-store')).toBe(0);
});
