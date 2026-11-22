/**
 * getAccessToken used to exchange the refresh token on EVERY call, and the
 * calendar sync calls it for each push, pull and foreground refresh: 4,554
 * exchanges in 75 s of load, each a round trip to Google. A token is now reused
 * for a few minutes. What must NOT be reused: a token minted before an
 * incremental consent (wrong scopes) or after Google killed the refresh token.
 * Google is mocked at the fetch seam; getAccessToken itself runs for real.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  GoogleAuthError,
  _resetAccessTokenCacheForTests,
  getAccessToken,
  persistRefreshToken,
} from '@/services/google/oauth.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CAL = 'https://www.googleapis.com/auth/calendar';
const MAIL = 'https://www.googleapis.com/auth/gmail.modify';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let db: Kysely<DB>;
let userId: string;
const savedKey = process.env.MASTER_KEY;
const savedClient = env.GOOGLE_CLIENT_ID;
const savedSecret = env.GOOGLE_CLIENT_SECRET;

beforeEach(async () => {
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
  _resetCryptoCacheForTests();
  _resetAccessTokenCacheForTests();
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = 'test-client';
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = 'test-secret';
  db = await openTestDb();
  userId = await createUser(db, 'tok');
  await persistRefreshToken(db, userId, 'rt-1', CAL);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedKey;
  _resetCryptoCacheForTests();
  _resetAccessTokenCacheForTests();
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = savedClient;
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = savedSecret;
  await closeTestDb(db);
});

describe('getAccessToken reuse', () => {
  it('exchanges once for many calls', async () => {
    const f = vi.fn(async () => jsonRes({ access_token: 'at-1', expires_in: 3600 }));
    vi.stubGlobal('fetch', f);
    for (let i = 0; i < 10; i++) expect(await getAccessToken(db, userId)).toBe('at-1');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps users apart', async () => {
    const other = await createUser(db, 'tok2');
    await persistRefreshToken(db, other, 'rt-2', CAL);
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ access_token: `at-${++n}`, expires_in: 3600 })));
    expect(await getAccessToken(db, userId)).toBe('at-1');
    expect(await getAccessToken(db, other)).toBe('at-2');
    expect(await getAccessToken(db, userId)).toBe('at-1');
  });

  it('exchanges again after the reuse window', async () => {
    let n = 0;
    const f = vi.fn(async () => jsonRes({ access_token: `at-${++n}`, expires_in: 3600 }));
    vi.stubGlobal('fetch', f);
    const t0 = Date.now();
    expect(await getAccessToken(db, userId)).toBe('at-1');
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 11 * 60_000);
    expect(await getAccessToken(db, userId)).toBe('at-2');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never reuses a token that is about to expire', async () => {
    let n = 0;
    const f = vi.fn(async () => jsonRes({ access_token: `at-${++n}`, expires_in: 30 }));
    vi.stubGlobal('fetch', f);
    await getAccessToken(db, userId);
    await getAccessToken(db, userId);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a new grant (incremental consent) drops the token minted under the old scopes', async () => {
    let n = 0;
    const f = vi.fn(async () => jsonRes({ access_token: `at-${++n}`, expires_in: 3600 }));
    vi.stubGlobal('fetch', f);
    expect(await getAccessToken(db, userId)).toBe('at-1');
    await persistRefreshToken(db, userId, 'rt-1b', `${CAL} ${MAIL}`);
    expect(await getAccessToken(db, userId)).toBe('at-2');
  });

  it('a dead refresh token is not masked by a cached access token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ access_token: 'at-1', expires_in: 3600 })));
    await getAccessToken(db, userId);
    // A reconnect stores a fresh refresh token; then Google rejects it.
    await persistRefreshToken(db, userId, 'rt-dead', CAL);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: 'invalid_grant' }, 400)),
    );
    await expect(getAccessToken(db, userId)).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it('does not cache a failed exchange', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? jsonRes({ error: 'backend_error' }, 503) : jsonRes({ access_token: 'at-ok', expires_in: 3600 });
      }),
    );
    await expect(getAccessToken(db, userId)).rejects.toThrow();
    expect(await getAccessToken(db, userId)).toBe('at-ok');
  });
});
