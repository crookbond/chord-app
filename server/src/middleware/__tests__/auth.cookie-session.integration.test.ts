/**
 * The web app keeps no session token where page script can read it: the
 * browser holds the httpOnly `chord.sid` cookie and every request rides on it.
 * A cookie also rides on requests another site starts, so a write signed in
 * by the cookie alone must carry the CSRF header; header-token clients
 * (the phones) need nothing new.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, CSRF_HEADER, SESSION_COOKIE, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env as readonlyEnv } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const env = readonlyEnv as { -readonly [K in keyof typeof readonlyEnv]: (typeof readonlyEnv)[K] };

let db: Kysely<DB>;
let server: http.Server;
let base: string;
const savedAuthMode = env.AUTH_MODE;
const savedNodeEnv = env.NODE_ENV;

beforeEach(async () => {
  db = await openTestDb();
  env.AUTH_MODE = 'demo';
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  env.AUTH_MODE = savedAuthMode;
  env.NODE_ENV = savedNodeEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

/** `chord.sid=<value>` from a Set-Cookie header, as a browser would send it back. */
function cookiePair(setCookie: string | null): string {
  const m = (setCookie ?? '').match(new RegExp(`${SESSION_COOKIE.replace('.', '\\.')}=([^;]*)`));
  return m ? `${SESSION_COOKIE}=${m[1]}` : '';
}

async function signIn(username: string): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${base}${API.session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
    body: JSON.stringify({ username }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  const cookie = cookiePair(res.headers.get('set-cookie'));
  expect(cookie).not.toBe('');
  return { token: body.token, cookie };
}

function createGroup(headers: Record<string, string>): Promise<Response> {
  return fetch(`${base}${API.groups}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'Cookie test' }),
  });
}

describe('cookie-only session', () => {
  it('signs the browser in with no token header at all', async () => {
    const { cookie } = await signIn('cookie-only-me');
    const res = await fetch(`${base}${API.me}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { username: string }).username).toBe('cookie-only-me');
  });

  it('a write by cookie WITHOUT the CSRF header is refused, and nothing is written', async () => {
    const { cookie } = await signIn('cookie-csrf-refused');
    const before = await db.selectFrom('groups').select('id').execute();
    const res = await createGroup({ cookie });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/csrf/i);
    const after = await db.selectFrom('groups').select('id').execute();
    expect(after).toHaveLength(before.length);
  });

  it('a write by cookie WITH the CSRF header goes through', async () => {
    const { cookie } = await signIn('cookie-csrf-ok');
    const res = await createGroup({ cookie, [CSRF_HEADER]: '1' });
    expect(res.status).toBeLessThan(300);
  });

  it('a write by token header needs no CSRF header (the phones)', async () => {
    const { token } = await signIn('header-no-csrf');
    const res = await createGroup({ [SESSION_HEADER]: token });
    expect(res.status).toBeLessThan(300);
  });

  it('a bearer token needs no CSRF header either', async () => {
    const { token } = await signIn('bearer-no-csrf');
    const res = await createGroup({ authorization: `Bearer ${token}` });
    expect(res.status).toBeLessThan(300);
  });
});

describe('sign-out by cookie', () => {
  it('without the CSRF header does not sign anyone out', async () => {
    const { cookie } = await signIn('logout-no-csrf');
    const res = await fetch(`${base}${API.sessionLogout}`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(403);
    expect(await db.selectFrom('sessions').selectAll().execute()).toHaveLength(1);
  });

  it('with the header deletes the session and clears the cookie', async () => {
    const { cookie } = await signIn('logout-csrf');
    const res = await fetch(`${base}${API.sessionLogout}`, {
      method: 'POST',
      headers: { cookie, [CSRF_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE.replace('.', '\\.')}=;`));
    expect(await db.selectFrom('sessions').selectAll().execute()).toHaveLength(0);
    const me = await fetch(`${base}${API.me}`, { headers: { cookie } });
    expect(me.status).toBe(401);
  });
});

describe('account deletion', () => {
  it('clears the session cookie', async () => {
    const { cookie } = await signIn('delete-clears-cookie');
    const res = await fetch(`${base}${API.me}`, {
      method: 'DELETE',
      headers: { cookie, [CSRF_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`${SESSION_COOKIE.replace('.', '\\.')}=;`));
  });
});

describe('public routes with a cookie and no CSRF header', () => {
  it('still answer, as signed out (an OAuth callback must not 403)', async () => {
    const { cookie } = await signIn('public-route');
    // The waitlist is public: a stray cookie must not turn it into a refusal.
    const res = await fetch(`${base}${API.waitlist}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ email: 'someone@example.com' }),
    });
    expect(res.status).not.toBe(403);
  });
});
