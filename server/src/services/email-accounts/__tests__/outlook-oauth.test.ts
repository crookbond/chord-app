import { randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { _resetAccessTokenReuseForTests } from '@/utils/access-token-cache.js';

process.env.MASTER_KEY ||= randomBytes(32).toString('base64');

const { sealAuthBlob } = await import('../account-utils.js');
const { getOutlookAccessToken } = await import('../outlook-oauth.js');
const { refreshAccessTokenWith } = await import('../../google/oauth.service.js');

type AccountRow = Parameters<typeof getOutlookAccessToken>[1];

// The prod account opened three times in a second on 2026-10-23
// (emt_bkD7NntY3fOz, ~290 ms each) was an Outlook mailbox.
function outlookAccount(refreshToken: string, id = 'ema_jkPXgnLuMHPM'): AccountRow {
  return { id, provider: 'outlook', ...sealAuthBlob({ refreshToken }) } as unknown as AccountRow;
}

const resealed: string[] = [];
const fakeDb = {
  updateTable: () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => ({
        execute: async () => {
          resealed.push(String(values.updated_at ?? ''));
        },
      }),
    }),
  }),
} as unknown as Kysely<DB>;

let tokenCalls: URLSearchParams[] = [];
let nextResponse: (body: URLSearchParams) => Record<string, unknown>;

function tokenResponse(json: Record<string, unknown>): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    saved[k] = (env as Record<string, unknown>)[k];
    (env as Record<string, unknown>)[k] = `test-${k}`;
  }
});

beforeEach(() => {
  _resetAccessTokenReuseForTests();
  tokenCalls = [];
  resealed.length = 0;
  let n = 0;
  nextResponse = () => ({ access_token: `at-${++n}`, expires_in: 3600 });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      // Let the event loop turn so concurrent callers really overlap.
      await new Promise((r) => setImmediate(r));
      const body = new URLSearchParams(String(init?.body ?? ''));
      tokenCalls.push(body);
      return tokenResponse(nextResponse(body));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Outlook access token reuse', () => {
  it('reopening the same Outlook email does not ask Microsoft again', async () => {
    const account = outlookAccount('rt-outlook-1');
    const a = await getOutlookAccessToken(fakeDb, account);
    const b = await getOutlookAccessToken(fakeDb, account);
    const c = await getOutlookAccessToken(fakeDb, account);
    expect([a, b, c]).toEqual(['at-1', 'at-1', 'at-1']);
    expect(tokenCalls).toHaveLength(1);
  });

  it('an open and the prefetch beside it share one exchange', async () => {
    const account = outlookAccount('rt-outlook-1');
    const [a, b] = await Promise.all([
      getOutlookAccessToken(fakeDb, account),
      getOutlookAccessToken(fakeDb, account),
    ]);
    expect(a).toBe(b);
    expect(tokenCalls).toHaveLength(1);
  });

  it('a rotated refresh token is resealed and the next call still reuses the token', async () => {
    nextResponse = () => ({ access_token: 'at-rotated', refresh_token: 'rt-outlook-2', expires_in: 3600 });
    await getOutlookAccessToken(fakeDb, outlookAccount('rt-outlook-1'));
    expect(resealed).toHaveLength(1);
    // The row now holds the rotated token, as it would after the reseal.
    const again = await getOutlookAccessToken(fakeDb, outlookAccount('rt-outlook-2'));
    expect(again).toBe('at-rotated');
    expect(tokenCalls).toHaveLength(1);
  });

  it('a reconnect (new refresh token) gets a fresh access token', async () => {
    await getOutlookAccessToken(fakeDb, outlookAccount('rt-outlook-1'));
    const after = await getOutlookAccessToken(fakeDb, outlookAccount('rt-outlook-new-consent'));
    expect(after).toBe('at-2');
    expect(tokenCalls).toHaveLength(2);
  });

  it('two mailboxes never share a token', async () => {
    await getOutlookAccessToken(fakeDb, outlookAccount('rt-same', 'ema_a'));
    await getOutlookAccessToken(fakeDb, outlookAccount('rt-same', 'ema_b'));
    expect(tokenCalls).toHaveLength(2);
  });

  it('a token with no stated lifetime is not reused', async () => {
    let n = 0;
    nextResponse = () => ({ access_token: `at-${++n}` });
    const account = outlookAccount('rt-outlook-1');
    await getOutlookAccessToken(fakeDb, account);
    await getOutlookAccessToken(fakeDb, account);
    expect(tokenCalls).toHaveLength(2);
  });

  it('a failed exchange is not cached', async () => {
    const account = outlookAccount('rt-outlook-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"temporarily_unavailable"}', { status: 503 })),
    );
    await expect(getOutlookAccessToken(fakeDb, account)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ access_token: 'at-ok', expires_in: 3600 })));
    expect(await getOutlookAccessToken(fakeDb, account)).toBe('at-ok');
  });
});

describe('secondary Gmail access token reuse', () => {
  it('reopening an email in a secondary Gmail does not ask Google again', async () => {
    const a = await refreshAccessTokenWith('rt-gmail-2nd', 'test-GOOGLE_CLIENT_ID');
    const b = await refreshAccessTokenWith('rt-gmail-2nd', 'test-GOOGLE_CLIENT_ID');
    expect(a).toBe(b);
    expect(tokenCalls).toHaveLength(1);
  });
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) (env as Record<string, unknown>)[k] = v;
});
