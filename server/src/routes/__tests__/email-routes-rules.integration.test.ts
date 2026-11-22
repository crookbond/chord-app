/**
 * The mail-rules editor (ADR 0123). The rule the tests are really about: the
 * group id now comes from a client, so membership has to be checked on the way
 * in - the ADR 0077 bot path never handed over an id the user could pick.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type EmailRoutingRuleDto } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

let db: Kysely<DB>;
let server: http.Server;
let base: string;
let tok: string;
let userId: string;

async function mintToken(uid: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: uid, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

async function makeGroup(name: string, members: string[]): Promise<string> {
  const id = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id,
      name,
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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
  db = await openTestDb();
  server = http.createServer(buildApp(db));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  userId = await createUser(db, 'rules-user');
  tok = await mintToken(userId);
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('mail rules', () => {
  it('starts empty', async () => {
    const res = await fetch(`${base}${API.meEmailRoutes}`, { headers: { [SESSION_HEADER]: tok } });

    expect(await res.json()).toEqual([]);
  });

  it('adds a rule and infers its kind from the pattern', async () => {
    const gid = await makeGroup('Family', [userId]);

    const res = await post(API.meEmailRoutes, { pattern: 'lcps.org', targetGroupId: gid });
    const rules = (await res.json()) as EmailRoutingRuleDto[];

    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      pattern: 'lcps.org',
      kind: 'sender_domain',
      targetGroupName: 'Family',
    });
  });

  it('reads a keyword as a category rule', async () => {
    const gid = await makeGroup('Family', [userId]);

    const res = await post(API.meEmailRoutes, { pattern: 'school', targetGroupId: gid });

    expect(((await res.json()) as EmailRoutingRuleDto[])[0].kind).toBe('category');
  });

  it('refuses a group the user is not in', async () => {
    // The whole reason the write-side check exists: this id came from a client.
    const stranger = await createUser(db, 'stranger');
    const theirs = await makeGroup('Not mine', [stranger]);

    const res = await post(API.meEmailRoutes, { pattern: 'lcps.org', targetGroupId: theirs });

    expect(res.status).toBe(403);
    expect(
      await db.selectFrom('email_routing_rules').selectAll().execute(),
    ).toHaveLength(0);
  });

  it('rejects a pattern too short to mean anything', async () => {
    const gid = await makeGroup('Family', [userId]);

    expect((await post(API.meEmailRoutes, { pattern: 'a', targetGroupId: gid })).status).toBe(400);
  });

  it('removes a rule and returns what is left', async () => {
    const gid = await makeGroup('Family', [userId]);
    await post(API.meEmailRoutes, { pattern: 'lcps.org', targetGroupId: gid });
    const rules = (await (
      await post(API.meEmailRoutes, { pattern: 'school', targetGroupId: gid })
    ).json()) as EmailRoutingRuleDto[];

    const res = await fetch(`${base}${API.meEmailRoute(rules[0].id)}`, {
      method: 'DELETE',
      headers: { [SESSION_HEADER]: tok },
    });
    const left = (await res.json()) as EmailRoutingRuleDto[];

    expect(left.map((r) => r.pattern)).toEqual([rules[1].pattern]);
  });

  it('treats deleting an absent rule as the state the caller asked for', async () => {
    const res = await fetch(`${base}${API.meEmailRoute('err_nope')}`, {
      method: 'DELETE',
      headers: { [SESSION_HEADER]: tok },
    });

    expect(res.status).toBe(200);
  });

  it('never shows another user their rules', async () => {
    const gid = await makeGroup('Family', [userId]);
    await post(API.meEmailRoutes, { pattern: 'lcps.org', targetGroupId: gid });
    const otherTok = await mintToken(await createUser(db, 'other'));

    const res = await fetch(`${base}${API.meEmailRoutes}`, {
      headers: { [SESSION_HEADER]: otherTok },
    });

    expect(await res.json()).toEqual([]);
  });
});
