/**
 * The per-group Telegram mirror switch (settings cleanup, 2026-09).
 * `groups.mirror_inbound` has always existed and `PATCH /groups/:id`
 * always accepted `mirrorInbound`, but nothing sent it until the group
 * settings screen grew a toggle. These pin the endpoint it now drives:
 * a member flips it and it round-trips; a non-member cannot.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;

async function mintToken(uid: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

async function makeGroup(members: string[]): Promise<string> {
  const id = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id,
      name: 'Family',
      kind: 'group',
      invite_code: id.slice(-6).toUpperCase(),
      ingest_email: id + '@chord.app',
      created_by: members[0],
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  for (const m of members) {
    await db
      .insertInto('group_members')
      .values({ group_id: id, user_id: m, role: 'member', tier: 'trusted', joined_at: now })
      .execute();
  }
  return id;
}

function patch(path: string, tok: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    body: JSON.stringify(body),
  });
}

async function getGroup(path: string, tok: string): Promise<{ mirrorInbound: boolean }> {
  const res = await fetch(`${base}${path}`, { headers: { [SESSION_HEADER]: tok } });
  return (await res.json()) as { mirrorInbound: boolean };
}

beforeEach(async () => {
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('per-group Telegram mirror switch', () => {
  it('a member flips mirrorInbound and it round-trips on GET', async () => {
    const uid = await createUser(db, 'member');
    const tok = await mintToken(uid);
    const gid = await makeGroup([uid]);

    expect((await getGroup(API.group(gid), tok)).mirrorInbound).toBe(false);

    const res = await patch(API.group(gid), tok, { mirrorInbound: true });
    expect(res.status).toBe(200);
    expect((await getGroup(API.group(gid), tok)).mirrorInbound).toBe(true);

    await patch(API.group(gid), tok, { mirrorInbound: false });
    expect((await getGroup(API.group(gid), tok)).mirrorInbound).toBe(false);
  });

  it('a non-member cannot flip it', async () => {
    const owner = await createUser(db, 'owner');
    const outsider = await createUser(db, 'outsider');
    const gid = await makeGroup([owner]);

    const res = await patch(API.group(gid), await mintToken(outsider), { mirrorInbound: true });
    expect(res.status).toBe(403);
  });
});
