/**
 * ADR 0345 - the app-review sign-in. Google Play's reviewer could not get past
 * Google's new-device check on the demo account (rejection, version code 5),
 * so the review account gets an email + password of its own.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type ReviewEnv = { AUTH_MODE: string; REVIEW_SIGN_IN_EMAIL: string; REVIEW_SIGN_IN_PASSWORD: string };
const e = env as unknown as ReviewEnv;
const saved = { ...e };

const EMAIL = 'reviewer.test@gmail.com';
const PASSWORD = 'correct-horse-battery-staple-42';

describe('POST /api/v1/auth/review (ADR 0345)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    e.AUTH_MODE = 'google';
    e.REVIEW_SIGN_IN_EMAIL = EMAIL;
    e.REVIEW_SIGN_IN_PASSWORD = PASSWORD;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    Object.assign(e, saved);
    await new Promise<void>((r) => server.close(() => r()));
    await closeTestDb(db);
  });

  const signIn = (body: unknown) =>
    fetch(`${base}${API.authReview}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('opens the existing account with the review email (the one holding the demo mailbox)', async () => {
    const demoId = await createUser(db, 'demo');
    await db.updateTable('users').set({ email: 'Reviewer.TesT@gmail.com' }).where('id', '=', demoId).execute();

    const res = await signIn({ email: ` ${EMAIL.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: { id: string } };
    expect(body.user.id).toBe(demoId);
    const session = await db
      .selectFrom('sessions')
      .select('user_id')
      .where('token', '=', hashSessionToken(body.token))
      .executeTakeFirst();
    expect(session?.user_id).toBe(demoId);
  });

  it('creates one review account when none exists, and reuses it next time', async () => {
    const first = (await (await signIn({ email: EMAIL, password: PASSWORD })).json()) as { user: { id: string } };
    const second = (await (await signIn({ email: EMAIL, password: PASSWORD })).json()) as { user: { id: string } };
    expect(second.user.id).toBe(first.user.id);
    const rows = await db.selectFrom('users').select('id').where('email', '=', EMAIL).execute();
    expect(rows).toHaveLength(1);
  });

  it('refuses a wrong password or email with one answer and opens nothing', async () => {
    for (const body of [
      { email: EMAIL, password: `${PASSWORD}x` },
      { email: 'someone@gmail.com', password: PASSWORD },
      { email: EMAIL, password: '' },
    ]) {
      const res = await signIn(body);
      expect(res.status).toBe(401);
    }
    expect(await db.selectFrom('sessions').select('token').execute()).toHaveLength(0);
  });

  it('does not exist while unset, or with a short password, and /health says so', async () => {
    e.REVIEW_SIGN_IN_PASSWORD = '';
    expect((await signIn({ email: EMAIL, password: '' })).status).toBe(404);
    e.REVIEW_SIGN_IN_PASSWORD = 'short-password';
    expect((await signIn({ email: EMAIL, password: 'short-password' })).status).toBe(404);
    const health = (await (await fetch(`${base}${API.health}`)).json()) as { reviewSignIn: boolean };
    expect(health.reviewSignIn).toBe(false);

    e.REVIEW_SIGN_IN_PASSWORD = PASSWORD;
    const on = (await (await fetch(`${base}${API.health}`)).json()) as { reviewSignIn: boolean };
    expect(on.reviewSignIn).toBe(true);
  });
});
