/**
 * A session token used to be honoured until the user signed out: nothing on
 * the server ever checked its age, so a phone's header token worked forever.
 * Sessions now end after SESSION_IDLE_DAYS unused or SESSION_MAX_DAYS old.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import express, { Router } from 'express';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { attachDb } from '@/middleware/db.js';
import { loadSession, requireSession } from '@/middleware/auth.js';
import { authRouter } from '@/routes/auth.js';
import { pruneOldRows } from '@/services/retention.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();
const limits = env as { SESSION_IDLE_DAYS: number; SESSION_MAX_DAYS: number };

describe('session expiry', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;
  const before = { idle: limits.SESSION_IDLE_DAYS, max: limits.SESSION_MAX_DAYS };

  async function session(createdDaysAgo: number, lastSeenDaysAgo: number): Promise<string> {
    const token = newId('t');
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: daysAgo(createdDaysAgo), last_seen_at: daysAgo(lastSeenDaysAgo) })
      .execute();
    return token;
  }
  const whoami = (token: string) => fetch(`${base}/whoami`, { headers: { 'x-chord-token': token } });
  const rowExists = async (token: string) =>
    !!(await db.selectFrom('sessions').select('token').where('token', '=', hashSessionToken(token)).executeTakeFirst());

  beforeEach(async () => {
    limits.SESSION_IDLE_DAYS = 30;
    limits.SESSION_MAX_DAYS = 90;
    db = await openTestDb();
    userId = await createUser(db, 'expiry-user');
    const app = express();
    app.use(attachDb(db));
    app.use(authRouter);
    const r = Router();
    r.use(loadSession);
    r.get('/whoami', requireSession, (req, res) => res.json({ userId: req.userId }));
    app.use(r);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    limits.SESSION_IDLE_DAYS = before.idle;
    limits.SESSION_MAX_DAYS = before.max;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('accepts a session inside both limits', async () => {
    const token = await session(60, 1);
    expect((await whoami(token)).status).toBe(200);
  });

  it('refuses and deletes a session unused for longer than the idle limit', async () => {
    const token = await session(40, 31);
    expect((await whoami(token)).status).toBe(401);
    expect(await rowExists(token)).toBe(false);
  });

  it('refuses a session older than the absolute limit even when used yesterday', async () => {
    const token = await session(91, 1);
    expect((await whoami(token)).status).toBe(401);
    expect(await rowExists(token)).toBe(false);
  });

  it('keeps an old session when both limits are switched off', async () => {
    limits.SESSION_IDLE_DAYS = 0;
    limits.SESSION_MAX_DAYS = 0;
    const token = await session(400, 200);
    expect((await whoami(token)).status).toBe(200);
  });

  it('refuses a token after sign-out', async () => {
    const token = await session(1, 0);
    expect((await whoami(token)).status).toBe(200);
    const out = await fetch(`${base}/api/v1/session/logout`, { method: 'POST', headers: { 'x-chord-token': token } });
    expect(out.status).toBe(200);
    expect((await whoami(token)).status).toBe(401);
    expect(await rowExists(token)).toBe(false);
  });

  it('prunes expired sessions nobody presents again, and leaves live ones', async () => {
    const idle = await session(40, 31);
    const old = await session(91, 1);
    const live = await session(10, 1);
    const res = await pruneOldRows(db);
    expect(res.sessions).toBe(2);
    expect(await rowExists(idle)).toBe(false);
    expect(await rowExists(old)).toBe(false);
    expect(await rowExists(live)).toBe(true);
  });
});
