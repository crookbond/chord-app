/**
 * Native iOS and web use different Google OAuth clients, and Google binds a
 * refresh token to its issuing client. These tests pin that binding:
 *   - clientForRedirect maps the redirect_uri to the right client (web → secret,
 *     iOS reversed-scheme → public/no-secret, iOS unconfigured → throws), and
 *   - getAccessToken refreshes a stored token with the client it was issued to,
 *     sending the web secret only for web-issued tokens.
 * Google is mocked at the fetch seam; the service runs for real.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  clientForRedirect,
  getAccessToken,
  persistRefreshToken,
} from '@/services/google/oauth.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';
const WEB_ID = 'web-client.apps.googleusercontent.com';
const IOS_ID = 'ios-client.apps.googleusercontent.com';
const IOS_REDIRECT = `com.googleusercontent.apps.ios-client:/oauthredirect`;

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Latest refresh-token POST body, parsed back into a map. */
function lastTokenBody(fetchMock: ReturnType<typeof vi.fn>): URLSearchParams {
  const init = fetchMock.mock.calls.at(-1)?.[1] as { body: string };
  return new URLSearchParams(init.body);
}

/** Narrowed view of the three OAuth fields the tests mutate, so we don't cast
 *  the whole `env` (which has non-string members like SERVER_PORT). */
const mutEnv = env as {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID_IOS: string;
};

let db: Kysely<DB>;
const savedKey = process.env.MASTER_KEY;
const saved = {
  id: mutEnv.GOOGLE_CLIENT_ID,
  secret: mutEnv.GOOGLE_CLIENT_SECRET,
  ios: mutEnv.GOOGLE_CLIENT_ID_IOS,
};

beforeEach(async () => {
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
  _resetCryptoCacheForTests();
  mutEnv.GOOGLE_CLIENT_ID = WEB_ID;
  mutEnv.GOOGLE_CLIENT_SECRET = 'web-secret';
  mutEnv.GOOGLE_CLIENT_ID_IOS = IOS_ID;
  db = await openTestDb();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedKey;
  _resetCryptoCacheForTests();
  mutEnv.GOOGLE_CLIENT_ID = saved.id;
  mutEnv.GOOGLE_CLIENT_SECRET = saved.secret;
  mutEnv.GOOGLE_CLIENT_ID_IOS = saved.ios;
  await closeTestDb(db);
});

describe('clientForRedirect', () => {
  it('uses the confidential web client (with secret) for an https redirect', () => {
    expect(clientForRedirect('https://chordapp.ai/oauthredirect')).toEqual({
      clientId: WEB_ID,
      clientSecret: 'web-secret',
    });
  });

  it('uses the public iOS client (no secret) for a reversed-client-id redirect', () => {
    expect(clientForRedirect(IOS_REDIRECT)).toEqual({ clientId: IOS_ID });
  });

  it('throws if a native redirect arrives but no iOS client is configured', () => {
    mutEnv.GOOGLE_CLIENT_ID_IOS = '';
    expect(() => clientForRedirect(IOS_REDIRECT)).toThrow(/GOOGLE_CLIENT_ID_IOS/);
  });
});

describe('getAccessToken refreshes with the issuing client', () => {
  it('omits the secret and uses the iOS client for a native-issued token', async () => {
    const userId = await createUser(db, 'ios-user');
    await persistRefreshToken(db, userId, 'rt-ios', CAL_SCOPE, IOS_ID);

    const fetchMock = vi.fn(async () => jsonRes({ access_token: 'at', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAccessToken(db, userId)).toBe('at');
    const body = lastTokenBody(fetchMock);
    expect(body.get('client_id')).toBe(IOS_ID);
    expect(body.has('client_secret')).toBe(false);
  });

  it('sends the secret with the web client for a web-issued (default) token', async () => {
    const userId = await createUser(db, 'web-user');
    await persistRefreshToken(db, userId, 'rt-web', CAL_SCOPE); // defaults to web client

    const fetchMock = vi.fn(async () => jsonRes({ access_token: 'at', expires_in: 3600 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await getAccessToken(db, userId)).toBe('at');
    const body = lastTokenBody(fetchMock);
    expect(body.get('client_id')).toBe(WEB_ID);
    expect(body.get('client_secret')).toBe('web-secret');
  });
});
