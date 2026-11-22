/**
 * ADR 0156 addendum — Sign in with Apple from a browser. Apple's endpoints are
 * faked at the fetch boundary and record what they were asked, because the
 * whole point of the web flow is that every call names the Services ID (not
 * the app's bundle id) and the registered return address.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  API,
  APPLE_NATIVE_STATE_PREFIX,
  appleStateOrigin,
  appleWebAuthorizeUrl,
  appleWebState,
  appleWebStateMatches,
  parseAppleWebReturn,
} from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { deleteAccount } from '@/services/account.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

type AppleEnv = {
  AUTH_MODE: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  APPLE_BUNDLE_ID: string;
  APPLE_SERVICES_ID: string;
  WEB_ORIGIN: string;
};
const e = env as unknown as AppleEnv;
const savedEnv = { ...e };
const savedMasterKey = process.env.MASTER_KEY;

const PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const SERVICES_ID = 'ai.chordapp.web';
const ORIGIN = 'https://chordapp.ai';
const CALLBACK = `${ORIGIN}/api/v1/auth/apple/callback`;

function idToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
}
const jwtClaims = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;

describe('Sign in with Apple on the web (ADR 0156 addendum)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let aud: string;
  let tokenCalls: URLSearchParams[];
  let revokeCalls: URLSearchParams[];

  beforeEach(async () => {
    process.env.MASTER_KEY = randomBytes(32).toString('base64');
    _resetCryptoCacheForTests();
    e.AUTH_MODE = 'google';
    e.APPLE_TEAM_ID = 'TEAM123456';
    e.APPLE_KEY_ID = 'KEY1234567';
    e.APPLE_PRIVATE_KEY = PEM;
    e.APPLE_BUNDLE_ID = 'app.chord.demo';
    e.APPLE_SERVICES_ID = SERVICES_ID;
    e.WEB_ORIGIN = ORIGIN;
    aud = SERVICES_ID;
    tokenCalls = [];
    revokeCalls = [];

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://appleid.apple.com/auth/token') {
        tokenCalls.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          id_token: idToken({
            iss: 'https://appleid.apple.com',
            aud,
            exp: Math.floor(Date.now() / 1000) + 600,
            sub: 'apple-sub-1',
            email: 'ann@example.com',
            email_verified: 'true',
          }),
          refresh_token: 'apple-rt-web',
        });
      }
      if (url === 'https://appleid.apple.com/auth/revoke') {
        const q = new URLSearchParams(String(init?.body));
        revokeCalls.push(q);
        // Apple only honours the client the token was issued to.
        return new Response('', { status: q.get('client_id') === SERVICES_ID ? 200 : 400 });
      }
      return realFetch(input, init);
    });

    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    Object.assign(e, savedEnv);
    if (savedMasterKey === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = savedMasterKey;
    _resetCryptoCacheForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const health = async () =>
    (await (await fetch(`${base}${API.health}`)).json()) as {
      appleSignIn: boolean;
      appleWeb: { clientId: string; redirectUri: string } | null;
    };
  const callback = (form: Record<string, string>) =>
    fetch(`${base}${API.authAppleCallback}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      redirect: 'manual',
    });
  const signIn = (body: Record<string, unknown>) =>
    fetch(`${base}${API.authApple}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authorizationCode: 'code-1', ...body }),
    });

  it('is offered to browsers only once a Services ID and an https address exist', async () => {
    expect((await health()).appleWeb).toEqual({ clientId: SERVICES_ID, redirectUri: CALLBACK });

    e.APPLE_SERVICES_ID = '';
    const off = await health();
    expect(off.appleWeb).toBeNull();
    // The iOS flow does not depend on it.
    expect(off.appleSignIn).toBe(true);
    expect((await signIn({ client: 'web' })).status).toBe(503);
    expect((await callback({ code: 'c', state: 's' })).status).toBe(503);

    e.APPLE_SERVICES_ID = SERVICES_ID;
    e.WEB_ORIGIN = 'http://localhost:8081';
    expect((await health()).appleWeb).toBeNull();
  });

  it('sends the browser to Apple asking for a form post with name and email', () => {
    const url = new URL(appleWebAuthorizeUrl({ clientId: SERVICES_ID, redirectUri: CALLBACK }, 'abc'));
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: SERVICES_ID,
      redirect_uri: CALLBACK,
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
      state: 'abc',
    });
  });

  it("relays Apple's form post to the web app in the URL fragment", async () => {
    const res = await callback({
      code: 'the code/with+odd=chars',
      state: 'a'.repeat(32),
      user: JSON.stringify({ name: { firstName: 'Ann', lastName: "O'Neil" }, email: 'ann@example.com' }),
    });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/');
    // Nothing in the query: a query string reaches the server and its logs.
    expect(location.search).toBe('');
    expect(parseAppleWebReturn(location.hash)).toEqual({
      code: 'the code/with+odd=chars',
      error: null,
      state: 'a'.repeat(32),
      givenName: 'Ann',
      familyName: "O'Neil",
    });
  });

  it('returns the Android app to the App Link it already catches, and only it', async () => {
    const state = `${APPLE_NATIVE_STATE_PREFIX}${'a'.repeat(32)}`;
    const res = await callback({ code: 'c-android', state });
    const location = new URL(res.headers.get('location')!);
    // Same origin as the web return - never somewhere the request names.
    expect(location.origin).toBe(ORIGIN);
    expect(location.pathname).toBe('/nativeauth');
    expect(location.search).toBe('');
    expect(parseAppleWebReturn(location.hash)).toMatchObject({ code: 'c-android', state });

    // A browser's state carries no marker, so the web app still gets its return.
    const web = await callback({ code: 'c-web', state: 'a'.repeat(32) });
    expect(new URL(web.headers.get('location')!).pathname).toBe('/');
  });

  it('returns a browser to the origin it started on, so its saved state is there', async () => {
    // Prod: chordapp.ai and www.chordapp.ai both serve the app, and the state
    // lives in the starting origin's sessionStorage. Sent back to the other
    // one, the check found nothing and said "could not be verified".
    const started = 'https://www.chordapp.ai';
    const state = appleWebState(started, 'a'.repeat(32));
    const res = await callback({ code: 'c-www', state });
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(started);
    expect(location.pathname).toBe('/');
    const back = parseAppleWebReturn(location.hash)!;
    expect(appleWebStateMatches(back.state, state)).toBe(true);

    // The bare domain still goes home.
    const bare = await callback({ code: 'c', state: appleWebState(ORIGIN, 'a'.repeat(32)) });
    expect(new URL(bare.headers.get('location')!).origin).toBe(ORIGIN);
  });

  it('never returns the code to an origin that is not Chord', async () => {
    for (const other of ['https://evil.example', 'http://www.chordapp.ai', 'https://chordapp.ai.evil.example']) {
      const res = await callback({ code: 'c', state: appleWebState(other, 'a'.repeat(32)) });
      expect(new URL(res.headers.get('location')!).origin).toBe(ORIGIN);
    }
    expect(appleStateOrigin('o.zz.abc')).toBeNull();
    expect(appleStateOrigin(appleWebState('https://chordapp.ai/path', 'x'))).toBeNull();
  });

  it('relays a cancelled sign-in as an error, with no code', async () => {
    const res = await callback({ error: 'user_cancelled_authorize', state: 'a'.repeat(32) });
    const back = parseAppleWebReturn(new URL(res.headers.get('location')!).hash);
    expect(back).toMatchObject({ code: null, error: 'user_cancelled_authorize' });
  });

  it('only accepts a return to the browser that started it', () => {
    expect(parseAppleWebReturn('#section-2')).toBeNull();
    expect(appleWebStateMatches('a'.repeat(32), 'a'.repeat(32))).toBe(true);
    expect(appleWebStateMatches('a'.repeat(32), 'b'.repeat(32))).toBe(false);
    expect(appleWebStateMatches('a'.repeat(32), null)).toBe(false);
    expect(appleWebStateMatches('', '')).toBe(false);
  });

  it('redeems a web code as the Services ID, with the registered return address', async () => {
    const res = await signIn({ client: 'web', givenName: 'Ann' });
    expect(res.status).toBe(200);
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].get('client_id')).toBe(SERVICES_ID);
    expect(tokenCalls[0].get('redirect_uri')).toBe(CALLBACK);
    expect(jwtClaims(tokenCalls[0].get('client_secret')!).sub).toBe(SERVICES_ID);
  });

  it('still redeems an iOS code as the app, with no return address', async () => {
    aud = 'app.chord.demo';
    expect((await signIn({})).status).toBe(200);
    expect(tokenCalls[0].get('client_id')).toBe('app.chord.demo');
    expect(tokenCalls[0].has('redirect_uri')).toBe(false);
    expect(jwtClaims(tokenCalls[0].get('client_secret')!).sub).toBe('app.chord.demo');
  });

  it('refuses a token issued to the other client', async () => {
    aud = 'app.chord.demo';
    expect((await signIn({ client: 'web' })).status).toBe(401);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(0);
  });

  it('lands in the account the same Apple ID made on the phone', async () => {
    aud = 'app.chord.demo';
    const phone = (await (await signIn({})).json()) as { user: { id: string } };
    aud = SERVICES_ID;
    const web = (await (await signIn({ client: 'web' })).json()) as { user: { id: string } };
    expect(web.user.id).toBe(phone.user.id);
    expect(await db.selectFrom('users').select('id').execute()).toHaveLength(1);
  });

  it('revokes a web-issued token on account deletion', async () => {
    const body = (await (await signIn({ client: 'web' })).json()) as { user: { id: string } };
    const result = await deleteAccount(db, body.user.id);
    expect(result.appleRevoked).toBe(true);
    expect(revokeCalls.map((q) => q.get('client_id'))).toEqual(['app.chord.demo', SERVICES_ID]);
    expect(revokeCalls.every((q) => q.get('token') === 'apple-rt-web')).toBe(true);
  });
});
