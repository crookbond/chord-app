/**
 * Strict per-group scope at the HTTP route layer (ADR 0004 / 0032).
 *
 * Entity-id routes (`/api/v1/<entity>/:id`) carry no group in the path, so they
 * must load the entity and verify the caller is a member of THAT entity's group
 * before reading or mutating it. A member of group A must never be able to touch
 * group B's task / list / save / event / trip by id. Membership is checked by
 * user id, never a name.
 *
 * These assert the IDOR holes are closed: a signed-in non-member gets 404 (we
 * don't reveal cross-group existence), while a legitimate member still succeeds.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent, listRsvps } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createList, addItem } from '@/services/lists.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { createTask } from '@/services/tasks.service.js';
import { createTrip } from '@/services/trips.service.js';
import { newId } from '@/utils/ids.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

describe('cross-group route scope (IDOR)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  // Group A data, owned by alice (a member of A only). bob is a member of B only.
  let aliceTok: string;
  let bobTok: string;
  let groupA: string;
  let groupB: string;
  let taskA: string;
  let listA: string;
  let itemA: string;
  let saveA: string;
  let eventA: string;
  let tripA: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    aliceTok = await mintToken(db, alice);
    bobTok = await mintToken(db, bob);

    const a = await createGroup(db, { name: 'A', kind: 'group', createdBy: alice });
    const b = await createGroup(db, { name: 'B', kind: 'group', createdBy: bob });
    groupA = a.id;
    groupB = b.id;

    taskA = (await createTask(db, { groupId: groupA, createdBy: alice, title: 'A task' })).id;
    listA = (await createList(db, { groupId: groupA, name: 'A list', createdBy: alice })).id;
    itemA = (await addItem(db, listA, 'A item')).item.id;
    saveA = (
      await createSaveWithDedup(db, {
        groupId: groupA,
        createdBy: alice,
        kind: 'link',
        title: 'A save',
        url: 'https://example.com/a',
        tags: [],
      })
    ).save.id;
    eventA = (
      await createEvent(db, {
        groupId: groupA,
        createdBy: alice,
        title: 'A event',
        startsAt: '2026-06-01T18:00:00Z',
      })
    ).id;
    tripA = (
      await createTrip(db, {
        groupId: groupA,
        createdBy: alice,
        name: 'A trip',
        destination: 'Nowhere',
        startDate: '2026-06-10',
        endDate: '2026-06-12',
        participantIds: [],
      })
    ).id;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  function call(
    path: string,
    opts: { token?: string; method?: string; body?: unknown } = {},
  ): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { [SESSION_HEADER]: opts.token } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  it('blocks a non-member from mutating another group’s entities (404)', async () => {
    const t = bobTok; // bob is not a member of group A
    const cases: Array<[string, { method: string; body?: unknown }]> = [
      [`/api/v1/tasks/${taskA}`, { method: 'PATCH', body: { title: 'hacked' } }],
      [`/api/v1/tasks/${taskA}`, { method: 'DELETE' }],
      [`/api/v1/lists/${listA}/items`, { method: 'POST', body: { text: 'hacked' } }],
      [`/api/v1/lists/${listA}`, { method: 'PATCH', body: { name: 'hacked' } }],
      [`/api/v1/lists/${listA}`, { method: 'DELETE' }],
      [`/api/v1/list-items/${itemA}`, { method: 'PATCH', body: { text: 'hacked' } }],
      [`/api/v1/list-items/${itemA}`, { method: 'DELETE' }],
      [`/api/v1/saves/${saveA}`, { method: 'PATCH', body: { title: 'hacked' } }],
      [`/api/v1/saves/${saveA}`, { method: 'DELETE' }],
      [`/api/v1/events/${eventA}/rsvps`, { method: 'GET' }],
      [`/api/v1/events/${eventA}`, { method: 'PATCH', body: { title: 'hacked' } }],
      [`/api/v1/events/${eventA}`, { method: 'DELETE' }],
      [
        `/api/v1/events/${eventA}/rsvps`,
        { method: 'POST', body: { displayName: 'bob', status: 'yes' } },
      ],
      [`/api/v1/trips/${tripA}/reservations`, { method: 'POST', body: { title: 'hacked' } }],
    ];
    for (const [path, opt] of cases) {
      const res = await call(path, { token: t, ...opt });
      expect(res.status, `${opt.method} ${path}`).toBe(404);
    }
  });

  it('blocks deleting another group’s trip via a group you DO belong to (404)', async () => {
    // bob is a member of group B; tripA belongs to group A. The group route is
    // gated on :id (B), but the trip must also belong to that group.
    const res = await call(`/api/v1/groups/${groupB}/trips/${tripA}`, {
      token: bobTok,
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('still lets a legitimate member mutate their own group’s entity', async () => {
    const res = await call(`/api/v1/saves/${saveA}`, {
      token: aliceTok,
      method: 'PATCH',
      body: { title: 'renamed by member' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe('renamed by member');
  });

  it('rejects an unauthenticated request (401)', async () => {
    const res = await call(`/api/v1/saves/${saveA}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('record_rsvp scopes attendees to the event’s group members', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('records a member by id and refuses a non-member name', async () => {
    const alice = await createUser(db, 'alice', 'Alice');
    const carol = await createUser(db, 'carol', 'Carol');
    const outsider = await createUser(db, 'zoe', 'Zoe Outsider');
    const g = await createGroup(db, { name: 'Picnic', kind: 'group', createdBy: alice });
    await addMember(db, g.id, carol);
    // `outsider` exists and is in some other group, but NOT this one.
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: outsider });
    expect(other.id).toBeTruthy();

    const event = await createEvent(db, {
      groupId: g.id,
      createdBy: alice,
      title: 'Backyard lunch',
      startsAt: '2026-06-20T12:00:00Z',
    });

    const ok = await applyToolCall(db, {
      groupId: g.id,
      actorUserId: alice,
      provenance: null,
      call: { name: 'record_rsvp', args: { eventId: event.id, displayName: 'Carol', status: 'yes' } },
    });
    expect(ok.summary).toContain('Carol');

    const refused = await applyToolCall(db, {
      groupId: g.id,
      actorUserId: alice,
      provenance: null,
      call: {
        name: 'record_rsvp',
        args: { eventId: event.id, displayName: 'Zoe Outsider', status: 'yes' },
      },
    });
    expect(refused.summary).toMatch(/isn.t a member/i);

    const rsvps = await listRsvps(db, event.id);
    const names = rsvps.map((r) => r.displayName);
    expect(names).toContain('Carol');
    expect(names).not.toContain('Zoe Outsider');
    // The recorded RSVP is keyed to the member's id, not just a free-text name.
    const carolRsvp = rsvps.find((r) => r.displayName === 'Carol');
    expect(carolRsvp?.userId).toBe(carol);
  });
});
