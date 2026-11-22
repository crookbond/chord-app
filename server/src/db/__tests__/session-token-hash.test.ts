/**
 * Migration 112 (ADR 0269): sessions written before tokens were hashed hold
 * the raw token. Without the rewrite every one of them stops matching once
 * `loadSession` hashes what it is shown, and every user is signed out.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { hashSessionTokens } from '@/db/session-token-hash.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedRaw(token: string): Promise<string> {
  const userId = await createUser(db, `u-${token.slice(-6)}`);
  const now = new Date().toISOString();
  await db.insertInto('sessions').values({ token, user_id: userId, created_at: now, last_seen_at: now }).execute();
  return userId;
}

describe('hashSessionTokens', () => {
  it('rewrites a raw token to the hash Node computes', async () => {
    const raw = 't_Ab3-xY_9qWertyUiopAsdF';
    await seedRaw(raw);
    await hashSessionTokens(db);
    const rows = await db.selectFrom('sessions').select('token').execute();
    expect(rows.map((r) => r.token)).toEqual([hashSessionToken(raw)]);
  });

  it('does not hash a hash on a second run', async () => {
    const raw = 't_secondRunSecondRun0001';
    await seedRaw(raw);
    await hashSessionTokens(db);
    await hashSessionTokens(db);
    const rows = await db.selectFrom('sessions').select('token').execute();
    expect(rows.map((r) => r.token)).toEqual([hashSessionToken(raw)]);
  });

  it('keeps a session signed in across the migration', async () => {
    const raw = 't_keepMeSignedIn00000001';
    await seedRaw(raw);
    const server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // Before the rewrite the new lookup cannot find it — the outage this prevents.
      expect((await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: raw } })).status).toBe(401);
      await hashSessionTokens(db);
      expect((await fetch(`${base}${API.me}`, { headers: { [SESSION_HEADER]: raw } })).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
