/**
 * Nearly every router does `router.use(loadSession)`. A router-level `use` runs
 * for every request reaching that router whether or not one of its routes
 * matches, so a request served by the Nth router used to run the session
 * lookup N times before its handler. Prod's shape: 19 mounts.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import express, { Router } from 'express';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { attachDb } from '@/middleware/db.js';
import { loadSession, requireSession } from '@/middleware/auth.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';

describe('loadSession across many routers', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let token: string;
  let lookups = 0;

  beforeEach(async () => {
    db = await openTestDb();
    const userId = await createUser(db, 'sess-user');
    token = newId('t');
    const now = new Date().toISOString();
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
      .execute();

    // Count session lookups by wrapping selectFrom on the handle the app uses.
    lookups = 0;
    const counted = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'selectFrom') {
          return (table: string) => {
            if (table === 'sessions') lookups += 1;
            return (target.selectFrom as (t: string) => unknown).call(target, table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as Kysely<DB>;

    const app = express();
    app.use(attachDb(counted));
    // 19 routers ahead of the one that answers, each mounting loadSession the
    // way src/routes/* does.
    for (let i = 0; i < 19; i++) {
      const r = Router();
      r.use(loadSession);
      r.get(`/never-${i}`, (_req, res) => res.end());
      app.use(r);
    }
    const last = Router();
    last.use(loadSession);
    last.get('/whoami', requireSession, (req, res) => res.json({ userId: req.userId }));
    app.use(last);

    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  it('looks the session up once per request, not once per router', async () => {
    const res = await fetch(`${base}/whoami`, { headers: { 'x-chord-token': token } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { userId?: string }).userId).toBeTruthy();
    expect(lookups).toBe(1);
  });

  it('still rejects an unknown token, with one lookup', async () => {
    const res = await fetch(`${base}/whoami`, { headers: { 'x-chord-token': 'nope' } });
    expect(res.status).toBe(401);
    expect(lookups).toBe(1);
  });

  it('does not look anything up when there is no token', async () => {
    const res = await fetch(`${base}/whoami`);
    expect(res.status).toBe(401);
    expect(lookups).toBe(0);
  });
});
