/**
 * A browser signed in on a build that kept the token in web storage moves it
 * into the httpOnly cookie once, then forgets the stored copy. It must keep
 * that person signed in, and must never mint a cookie from a cookie.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, SESSION_COOKIE, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env as readonlyEnv } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken, newSessionToken } from '@/utils/session-token.js';

const env = readonlyEnv as { -readonly [K in keyof typeof readonlyEnv]: (typeof readonlyEnv)[K] };

let db: Kysely<DB>;
let server: http.Server;
let base: string;
const savedNodeEnv = env.NODE_ENV;

beforeEach(async () => {
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  env.NODE_ENV = savedNodeEnv;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

/** A session as an older web build left it: the raw token in the page's storage. */
async function legacySession(username: string, at = new Date()): Promise<string> {
  const userId = await createUser(db, username);
  const token = newSessionToken();
  const iso = at.toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: iso, last_seen_at: iso })
    .execute();
  return token;
}

function cookieFrom(res: Response): string {
  const m = (res.headers.get('set-cookie') ?? '').match(/chord\.sid=([^;]*)/);
  return m ? `${SESSION_COOKIE}=${m[1]}` : '';
}

describe('POST /session/adopt', () => {
  it('turns the stored token into the cookie, which then signs the browser in by itself', async () => {
    const token = await legacySession('adopt-me');
    const res = await fetch(`${base}${API.sessionAdopt}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i);
    const cookie = cookieFrom(res);
    expect(cookie).not.toBe('');
    const me = await fetch(`${base}${API.me}`, { headers: { cookie } });
    expect(me.status).toBe(200);
  });

  it('keeps the same session: nobody is signed out and no second session is made', async () => {
    const token = await legacySession('adopt-same');
    await fetch(`${base}${API.sessionAdopt}`, { method: 'POST', headers: { [SESSION_HEADER]: token } });
    const rows = await db.selectFrom('sessions').select('token').execute();
    expect(rows).toEqual([{ token: hashSessionToken(token) }]);
    const me = await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: token } });
    expect(me.status).toBe(200);
  });

  it('is Secure in production like every other session cookie', async () => {
    env.NODE_ENV = 'production';
    const token = await legacySession('adopt-prod');
    const res = await fetch(`${base}${API.sessionAdopt}`, { method: 'POST', headers: { [SESSION_HEADER]: token } });
    expect(res.headers.get('set-cookie')).toMatch(/;\s*Secure/i);
  });

  it('an unknown or expired token gets no cookie', async () => {
    const res = await fetch(`${base}${API.sessionAdopt}`, { method: 'POST', headers: { [SESSION_HEADER]: 'nope' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();

    const old = await legacySession('adopt-expired', new Date('2000-01-01T00:00:00Z'));
    const res2 = await fetch(`${base}${API.sessionAdopt}`, { method: 'POST', headers: { [SESSION_HEADER]: old } });
    expect(res2.status).toBe(401);
    expect(res2.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a cookie in place of the header token', async () => {
    const token = await legacySession('adopt-cookie');
    const res = await fetch(`${base}${API.sessionAdopt}`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
