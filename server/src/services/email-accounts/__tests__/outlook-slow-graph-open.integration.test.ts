/**
 * Prod, 2026-11-12: one Hotmail thread ("reservation mada", newest mail 11/3,
 * older mail back to September) opened to "You're offline" in the app while
 * every other thread opened. Graph was answering 502/504 after long waits,
 * and opening an Outlook thread fetched each message it had not stored ONE
 * AFTER ANOTHER, with no time limit, before answering - 52 to 283 seconds,
 * past the app's 25s. A long thread is just more calls in a row.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSE } from '@chord/kernel';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { listAccounts } from '@/services/email-accounts/account-utils.js';
import {
  connectOutlookAccount,
  getAccountThread,
  syncAccount,
} from '@/services/email-accounts/accounts.service.js';
import {
  __addOutlookMockMessage,
  __holdOutlookMockGetMessage,
  __outlookMockGetMessageMaxInFlight,
  __resetOutlookMock,
  realOutlookApi,
  type GraphMessage,
} from '@/services/email-accounts/outlook-api.js';
import { realGmailApi } from '@/services/google/gmail-api.js';
import { __setThreadOpenFetchBudgetForTests } from '@/services/google/gmail.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { __setProviderAttemptTimeoutForTests } from '@/utils/fetch-timeout.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

/** The reservation thread: replies from September up to a recent one. */
function reservationThread(): GraphMessage[] {
  return [70, 62, 55, 40, 9].map((days, i) => ({
    id: `ol-mada-${i}`,
    conversationId: 'ol-conv-mada',
    subject: 'Re: reservation mada',
    bodyPreview: `Reservation note ${i}`,
    from: { emailAddress: { name: 'Mada', address: 'reservations@mada.example' } },
    toRecipients: [{ emailAddress: { address: 'me@outlook.example' } }],
    receivedDateTime: ago(days),
    isRead: true,
    internetMessageId: `<ol-mada-${i}@mada.example>`,
    body: { contentType: 'text', content: `Full reservation text ${i}` },
  }));
}

/** A guard far longer than any honest open, so a hang loses the race. */
const GUARD_MS = 10_000;
const hung = Symbol('hung');
const raceGuard = <T>(p: Promise<T>) =>
  Promise.race([p, new Promise<typeof hung>((r) => setTimeout(() => r(hung), GUARD_MS))]);

describe('opening an Outlook thread while Graph is slow', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetOutlookMock();
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'outlook-slow');
  });
  afterEach(async () => {
    __setThreadOpenFetchBudgetForTests(null);
    __setProviderAttemptTimeoutForTests(null);
    (env as { OUTLOOK_PROVIDER: string }).OUTLOOK_PROVIDER = 'real';
    await settleBackgroundWork();
    await closeTestDb(db);
  });

  /** Synced, then the bodies dropped, as a thread whose bodies were never fetched. */
  async function syncedWithoutBodies() {
    await connectOutlookAccount(db, userId, { code: 'mock', codeVerifier: 'mock', redirectUri: 'chord://oauthredirect' });
    const [account] = await listAccounts(db, userId);
    for (const m of reservationThread()) __addOutlookMockMessage(account.id, m);
    await syncAccount(db, account);
    const thread = await db
      .selectFrom('email_threads')
      .select('id')
      .where('account_id', '=', account.id)
      .where('subject', 'like', '%reservation mada%')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('email_messages')
      .set({ body_text: null, body_html: null, attachments_json: null })
      .where('thread_id', '=', thread.id)
      .execute();
    return { account, threadId: thread.id };
  }

  it('answers with what is stored instead of waiting on Graph', async () => {
    const { account, threadId } = await syncedWithoutBodies();
    __setThreadOpenFetchBudgetForTests(50);
    const release = __holdOutlookMockGetMessage(account.id);

    const detail = await raceGuard(getAccountThread(db, userId, account.id, threadId));
    expect(detail).not.toBe(hung);
    const d = detail as Awaited<ReturnType<typeof getAccountThread>>;
    expect(d?.messages).toHaveLength(5);
    expect(d?.bodiesPending).toBe(true);
    expect(d?.messages.every((m) => !m.bodyText && !m.bodyHtml)).toBe(true);

    // When Graph answers, the bodies are stored and the open reader is told.
    const events: string[] = [];
    const off = sseHub.onBroadcast((_ch, ev, data) => {
      if (ev === SSE.emailThreadUpdated && (data as { threadId: string }).threadId === threadId) events.push(ev);
    });
    release();
    await settleBackgroundWork();
    off();
    expect(events).toHaveLength(1);
    const again = await getAccountThread(db, userId, account.id, threadId);
    expect(again?.bodiesPending).toBeUndefined();
    expect(again?.messages.map((m) => m.bodyText)).toEqual([0, 1, 2, 3, 4].map((i) => `Full reservation text ${i}`));
  });

  it('asks Graph for several messages at once, not one after another', async () => {
    const { account, threadId } = await syncedWithoutBodies();
    const release = __holdOutlookMockGetMessage(account.id);
    __setThreadOpenFetchBudgetForTests(50);
    await getAccountThread(db, userId, account.id, threadId);
    release();
    await settleBackgroundWork();
    expect(__outlookMockGetMessageMaxInFlight(account.id)).toBeGreaterThan(1);
  });

  it('tells nobody when Graph still had nothing to give', async () => {
    const { account, threadId } = await syncedWithoutBodies();
    const { __removeOutlookMockMessage } = await import('@/services/email-accounts/outlook-api.js');
    __setThreadOpenFetchBudgetForTests(50);
    const release = __holdOutlookMockGetMessage(account.id);
    await getAccountThread(db, userId, account.id, threadId);
    // Graph comes back with errors for every message (here: not found).
    for (const m of reservationThread()) __removeOutlookMockMessage(account.id, m.id);
    const events: string[] = [];
    const off = sseHub.onBroadcast((_ch, ev) => {
      if (ev === SSE.emailThreadUpdated) events.push(ev);
    });
    release();
    await settleBackgroundWork();
    off();
    expect(events).toEqual([]);
  });
});

describe('a provider request that never answers', () => {
  beforeEach(() => {
    // The provider holding the connection open: the request ends only if aborted.
    vi.stubGlobal(
      'fetch',
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    __setProviderAttemptTimeoutForTests(50);
  });
  afterEach(() => {
    __setProviderAttemptTimeoutForTests(null);
    vi.unstubAllGlobals();
  });

  const outcomeOf = (p: Promise<unknown>) => raceGuard(p.then(() => 'answered', (e: Error) => e.message));

  it('Graph gives up instead of waiting forever', async () => {
    const outcome = await outcomeOf(realOutlookApi('token').getMessage('ol-mada-0'));
    expect(outcome).not.toBe(hung);
    expect(outcome).toMatch(/timed out/);
  });

  it('Gmail gives up instead of waiting forever', async () => {
    const outcome = await outcomeOf(realGmailApi('token').getMessage('m1', 'full'));
    expect(outcome).not.toBe(hung);
    expect(outcome).toMatch(/timed out/);
  });
});
