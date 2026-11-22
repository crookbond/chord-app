/**
 * getAccessToken dead-refresh-token handling (#2/#3):
 *   - a Google `invalid_grant` clears the stored refresh token so connection
 *     state stops lying (`hasCalendarScope` → false), and
 *   - surfaces a typed GoogleAuthError(needsReconnect) for callers,
 *   - while a transient 5xx must NOT clear the token.
 * Google is mocked at the fetch seam; getAccessToken itself runs for real.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { hasCalendarScope } from '@/services/google/calendar.service.js';
import {
  GoogleAuthError,
  getAccessToken,
  persistRefreshToken,
} from '@/services/google/oauth.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';

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
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = 'test-client';
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = 'test-secret';
  db = await openTestDb();
  userId = await createUser(db, 'tok');
  await persistRefreshToken(db, userId, 'rt-123', CAL_SCOPE);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedKey;
  _resetCryptoCacheForTests();
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = savedClient;
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = savedSecret;
  await closeTestDb(db);
});

describe('getAccessToken refresh-token lifecycle', () => {
  it('returns an access token on a healthy refresh and stays connected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ access_token: 'at-ok', expires_in: 3600 })),
    );
    expect(await getAccessToken(db, userId)).toBe('at-ok');
    expect(await hasCalendarScope(db, userId)).toBe(true);
  });

  it('clears the token and throws needsReconnect on invalid_grant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          400,
        ),
      ),
    );

    await expect(getAccessToken(db, userId)).rejects.toMatchObject({
      name: 'GoogleAuthError',
      needsReconnect: true,
      oauthError: 'invalid_grant',
    });

    // #3: connection state stops lying — scopes nulled → connected:false.
    expect(await hasCalendarScope(db, userId)).toBe(false);
    const row = await db
      .selectFrom('users')
      .select(['refresh_token_ciphertext', 'refresh_token_scopes'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.refresh_token_ciphertext).toBeNull();
    expect(row.refresh_token_scopes).toBeNull();
  });

  it('does NOT clear the token on a transient 5xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonRes({ error: 'backend_error' }, 503)),
    );

    await expect(getAccessToken(db, userId)).rejects.toBeInstanceOf(GoogleAuthError);
    // A transient failure must not force a reconnect — token survives.
    expect(await hasCalendarScope(db, userId)).toBe(true);
  });

  it('throws needsReconnect when no refresh token is on file', async () => {
    const other = await createUser(db, 'empty');
    await expect(getAccessToken(db, other)).rejects.toMatchObject({
      name: 'GoogleAuthError',
      needsReconnect: true,
    });
  });
});
