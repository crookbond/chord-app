/**
 * The Email tab's sync used to return only after the AI passes had run over what
 * it fetched, so its latency was the sum of every LLM call (3.9 s mean with a
 * half-second mock model in the load test; several seconds each with a real
 * one). It now returns once the mail is stored and the AI layer follows, with
 * `email.synced` telling the client to refetch. Opening a thread waits for its
 * one-time LLM check only up to EMAIL_READ_TIME_WAIT_MS, then finishes behind
 * the response and emits `email.thread.updated`.
 *
 * The model here is held shut by a gate the test opens, so "returned while the
 * model was still running" is a fact, not a timing guess.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { SESSION_HEADER, SSE, API, type EmailThreadDetail } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { __settleAfterSyncForTests } from '@/services/google/gmail.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

const gate = vi.hoisted(() => {
  const g = {
    open: () => {},
    promise: Promise.resolve() as Promise<void>,
    calls: 0,
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
      gate.calls += 1;
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      await gate.promise;
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      if (system.includes('EMAIL_LLM_CLASSIFIER_V1')) {
        const threads = (JSON.parse(user) as { threads: { gmailThreadId: string }[] }).threads;
        return JSON.stringify({
          assignments: threads.map((t) => ({
            gmailThreadId: t.gmailThreadId,
            path: ['Finance', 'Statements'],
            confidence: 0.9,
            action: 'informational',
          })),
        });
      }
      // The read-time / magics prompt offers "advisory"; any other prompt (the trip classifier) gets a neutral answer.
      if (system.includes('"advisory"')) {
        return JSON.stringify({ kind: 'advisory', note: 'This looks like a phishing attempt, be careful.' });
      }
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

/** Resolves with the first broadcast on `channel` named `event`, or rejects after `ms`. */
function nextBroadcast(channel: string, event: string, ms = 8000): Promise<void> {
  const p = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no ${event} on ${channel} within ${ms} ms`));
    }, ms);
    const off = sseHub.onBroadcast((ch, ev) => {
      if (ch === channel && ev === event) {
        clearTimeout(timer);
        off();
        resolve();
      }
    });
  });
  // A test that fails before it awaits this must not leave a rejection nobody handles.
  p.catch(() => {});
  return p;
}

describe('sync and thread-open do not wait on the model', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;
  let userId: string;
  const saved: Record<string, unknown> = {};

  beforeEach(async () => {
    for (const k of [
      'GMAIL_ENABLED',
      'GMAIL_PROVIDER',
      'EMAIL_CLASSIFIER',
      'EMAIL_READ_TIME_WAIT_MS',
      'EMAIL_PREPROCESS_READTIME_ENABLED',
    ])
      saved[k] = mutableEnv[k];
    mutableEnv.GMAIL_ENABLED = true;
    mutableEnv.GMAIL_PROVIDER = 'mock';
    mutableEnv.EMAIL_CLASSIFIER = 'llm';
    mutableEnv.EMAIL_READ_TIME_WAIT_MS = 300;
    // This file is about the on-demand (open/prefetch) check in isolation -
    // the proactive pre-warm added alongside it has its own test file, and
    // left on here it races `settledMailbox`'s open gate and marks every
    // thread before these tests ever get to open or prefetch one.
    mutableEnv.EMAIL_PREPROCESS_READTIME_ENABLED = false;
    __resetGmailMock();
    gate.reset();
    gate.calls = 0;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'sync-user');
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

  const post = (path: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok }, body: '{}' });
  const get = (path: string) => fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: tok } });

  /** Poll until `cond` holds: the passes finish in the background, so there is no request to await. */
  const until = async (cond: () => Promise<boolean>, ms = 8000): Promise<void> => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('condition not met in time');
  };
  /** The request comes back while the model is still shut, or the test fails
   *  (instead of hanging) saying it waited. */
  const beforeTheModel = <T,>(request: Promise<T>): Promise<T> =>
    Promise.race([
      request,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the request waited for the model')), 15_000)),
    ]);
  /** A synced and classified mailbox, with the model open for the duration. */
  const settledMailbox = async (): Promise<void> => {
    gate.open();
    await post(API.meEmailSync);
    await until(async () => (await classified()) > 0);
  };

  const classified = async (): Promise<number> =>
    (await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).where('classified_at', 'is not', null).execute()).length;
  const threadCount = async (): Promise<number> =>
    (await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).execute()).length;

  it('returns once the mail is stored, while the classifier is still waiting on the model', async () => {
    // The model is shut. If the route still awaited the AI passes this would
    // never come back; the race makes that a failure rather than a hang.
    const res = await Promise.race([
      post(API.meEmailSync),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sync waited on the model')), 4000)),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { backfillDone: boolean };
    expect(body.backfillDone).toBe(true);

    // The mail is there; the AI layer has not touched it yet.
    expect(await threadCount()).toBeGreaterThan(0);
    expect(await classified()).toBe(0);

    // Let the model answer: the passes finish, and the client is told to look
    // again (the sync's own event fired before the response; this is the next).
    const told = nextBroadcast(`user:${userId}`, SSE.emailSynced);
    gate.open();
    await told;
    expect(await classified()).toBeGreaterThan(0);
  });

  it('a pull that finds nothing new starts no AI passes', async () => {
    // The Email tab syncs on every visit; over an unchanged mailbox the whole
    // pipeline (classifier, suggestions, people, read-time warm-up) ran again.
    await settledMailbox();
    await __settleAfterSyncForTests();
    let synced = 0;
    const off = sseHub.onBroadcast((ch, ev) => {
      if (ch === `user:${userId}` && ev === SSE.emailSynced) synced += 1;
    });
    try {
      const res = await post(API.meEmailSync);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
      await __settleAfterSyncForTests();
      // The sync's own event only; the AI layer's follow-up never started.
      expect(synced).toBe(1);
    } finally {
      off();
    }
  });

  it('a second pull while the passes are still running joins them rather than queuing another', async () => {
    const first = await post(API.meEmailSync);
    expect(first.status).toBe(200);
    const second = await post(API.meEmailSync);
    expect(second.status).toBe(200);
    // Both returned with the model shut, and the classifier was asked once.
    const told = nextBroadcast(`user:${userId}`, SSE.emailSynced);
    const classifierCalls = gate.calls;
    gate.open();
    await told;
    expect(classifierCalls).toBeLessThanOrEqual(1);
  });

  it('opening a thread shows the email past the wait, and tells the screen when the check finishes', async () => {
    await settledMailbox();
    const thread = await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).executeTakeFirstOrThrow();

    // Now the read-time check is slow.
    gate.reset();
    const t0 = Date.now();
    const updated = nextBroadcast(`user:${userId}`, SSE.emailThreadUpdated);
    const res = await get(API.meEmailThread(thread.id));
    const elapsed = Date.now() - t0;
    expect(res.status).toBe(200);
    const first = (await res.json()) as EmailThreadDetail & { readAdvisory?: { note: string } | null };
    // Waited about the configured 300 ms, not for the model.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3000);
    expect(first.readAdvisory ?? null).toBeNull();

    gate.open();
    await updated;
    const again = (await (await get(API.meEmailThread(thread.id))).json()) as { readAdvisory?: { note: string } | null };
    expect(again.readAdvisory?.note).toMatch(/phishing/i);
  });

  // ADR 0218 — the reader warms the next email before it is opened. That must
  // neither wait on the model nor spend the one-time check on an email nobody
  // has read yet; the real open still runs it.
  // Flipped (ADR 0205 addendum 2026-10-19): a prefetch used to leave the check
  // for the open, so every open of a pre-loaded email still waited for it. The
  // prefetch now STARTS the check, without waiting on it.
  it('a prefetch returns without waiting, but starts the check so the open has nothing to wait for', async () => {
    await settledMailbox();
    const thread = await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).executeTakeFirstOrThrow();

    // A wait far longer than the race below: a request that waited on the
    // shut model fails the race, however slow the machine. No timing bound.
    mutableEnv.EMAIL_READ_TIME_WAIT_MS = 60_000;
    gate.reset();
    const res = await beforeTheModel(get(`${API.meEmailThread(thread.id)}?prefetch=1`));
    expect(res.status).toBe(200);

    // Released, the check the prefetch started finishes and leaves its mark
    // for THIS thread.
    gate.open();
    const gid = (
      await db.selectFrom('email_threads').select('gmail_thread_id').where('id', '=', thread.id).executeTakeFirstOrThrow()
    ).gmail_thread_id;
    await until(async () =>
      (
        await db
          .selectFrom('email_extraction_marks')
          .select('kind')
          .where('user_id', '=', userId)
          .where('kind', '=', 'read')
          .where('gmail_thread_id', '=', gid)
          .execute()
      ).length === 1,
    );

    // The open answers from what the check stored: the caution is there at
    // once. (That the model is not asked twice is pinned in
    // email-thread-prefetch-check, which has no background sweep running.)
    // The model is shut again: an open that asked it a second time would wait
    // the full minute and fail the race.
    gate.reset();
    const opened = (await (await beforeTheModel(get(API.meEmailThread(thread.id)))).json()) as {
      readAdvisory?: { note: string } | null;
    };
    expect(opened.readAdvisory?.note).toMatch(/phishing/i);
  });

  it('a check that answers within the wait is in the first response, as before', async () => {
    await settledMailbox();
    const thread = await db.selectFrom('email_threads').select('id').where('user_id', '=', userId).executeTakeFirstOrThrow();

    const res = await get(API.meEmailThread(thread.id));
    const body = (await res.json()) as { readAdvisory?: { note: string } | null };
    expect(body.readAdvisory?.note).toMatch(/phishing/i);
  });
});
