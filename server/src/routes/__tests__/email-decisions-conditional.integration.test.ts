/**
 * The Email screen revalidates its decisions and tiles lists with
 * If-None-Match (mobile `conditionalGet`), so a background refetch that finds
 * nothing new downloads nothing. That rests on the server answering 304 for
 * an unchanged list and on a cross-origin web build being allowed to read
 * the ETag; both are pinned here.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { API, SESSION_HEADER } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
const token = 't_conditionalDecisions01';
// Node's fetch honours `cache`, but the server's lib types do not declare it.
const NO_STORE = { cache: 'no-store' } as RequestInit;
const gmailWas = env.GMAIL_ENABLED;

beforeEach(async () => {
  // The whole email surface 404s with the reader off, as it is in CI.
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  db = await openTestDb();
  const userId = await createUser(db, 'cond-user');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = gmailWas;
});

describe('conditional GET of the email lists', () => {
  it.each([
    ['decisions', API.meEmailDecisions],
    ['tiles', `${API.meEmailTiles}?deep=1`],
  ])('answers an unchanged %s list with an empty 304', async (_name, path) => {
    const first = await fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: token } });
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.text();

    // Exactly as the client asks (mobile `conditionalGet`).
    const again = await fetch(`${base}${path}`, {
      ...NO_STORE,
      headers: { [SESSION_HEADER]: token, 'Cache-Control': 'max-age=0', 'If-None-Match': etag! },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  // Fetch appends `Cache-Control: no-cache` to a no-store request that sets
  // none, and Express then never answers 304: the client's explicit header is
  // what makes the whole thing work.
  it('re-sends the full list when fetch is left to add no-cache', async () => {
    const first = await fetch(`${base}${API.meEmailDecisions}`, {
      headers: { [SESSION_HEADER]: token },
    });
    const etag = first.headers.get('etag')!;
    await first.text();
    const again = await fetch(`${base}${API.meEmailDecisions}`, {
      ...NO_STORE,
      headers: { [SESSION_HEADER]: token, 'If-None-Match': etag },
    });
    expect(again.status).toBe(200);
    await again.text();
  });

  it('lets a cross-origin web build read the ETag', async () => {
    const res = await fetch(`${base}${API.meEmailDecisions}`, {
      headers: { [SESSION_HEADER]: token, Origin: 'https://chordapp.ai' },
    });
    expect(res.headers.get('access-control-expose-headers') ?? '').toMatch(/etag/i);
  });
});
