/**
 * ADR 0157 addendum — the event editor adds guests. Reported: guests could only
 * be added by asking in chat; the editor had no field and no route. The route
 * must go through the same calendar write as the bot (ADR 0295) and refuse
 * anyone but the organizer.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type EventGuestsResponse } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));
vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const realFetch = globalThis.fetch;

describe('event guests route', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let google: FakeGoogleCalendar;
  let owner: string;
  let member: string;
  let groupId: string;
  const tokens: Record<string, string> = {};

  async function addUser(name: string): Promise<string> {
    const id = newId('u');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id,
        username: name,
        display_name: name,
        created_at: now,
        shadow: 0,
        refresh_token_scopes: 'https://www.googleapis.com/auth/calendar',
      })
      .execute();
    const token = newId('t');
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: id, created_at: now, last_seen_at: now })
      .execute();
    tokens[id] = token;
    return id;
  }

  function call(method: string, eventId: string, as: string, body?: unknown): Promise<Response> {
    return realFetch(`${base}${API.eventGuests(eventId)}`, {
      method,
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: tokens[as]! },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function makeEvent(): Promise<string> {
    const d = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: owner,
      provenance: null,
      turnId: 't1',
      tzOffset: '+00:00',
      call: { name: 'create_event', args: { title: 'Dinner', startsAt: `${d}T19:00:00+00:00` } },
    });
    await settleBackgroundWork();
    const row = await db
      .selectFrom('events')
      .select('id')
      .where('group_id', '=', groupId)
      .where('owner_user_id', '=', owner)
      .where('title', '=', 'Dinner')
      .executeTakeFirstOrThrow();
    expect(res.summary).toContain('Dinner');
    return row.id;
  }

  beforeEach(async () => {
    db = await openTestDb();
    owner = await addUser('ro');
    member = await addUser('mo');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Fam',
        kind: 'group',
        invite_code: 'XGST1',
        ingest_email: 'fam-gst@chord.app',
        created_by: owner,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values([
        { group_id: groupId, user_id: owner, role: 'owner', tier: 'verified', joined_at: now },
        { group_id: groupId, user_id: member, role: 'member', tier: 'verified', joined_at: now },
      ])
      .execute();
    google = installFakeGoogleCalendar();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  it('the organizer adds a guest on the calendar and reads the list back', async () => {
    const eventId = await makeEvent();
    const r = await call('POST', eventId, owner, { add: ['Karl@MeDia.example'] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as EventGuestsResponse;
    expect(body).toMatchObject({ added: ['karl@media.example'], guests: ['karl@media.example'] });
    const gcal = await db.selectFrom('events').select('gcal_event_id').where('id', '=', eventId).executeTakeFirstOrThrow();
    expect(google.guests(gcal.gcal_event_id!)).toEqual(['karl@media.example']);

    const read = (await (await call('GET', eventId, owner)).json()) as EventGuestsResponse;
    expect(read.guests).toEqual(['karl@media.example']);

    const removed = (await (await call('POST', eventId, owner, { remove: ['karl@media.example'] })).json()) as EventGuestsResponse;
    expect(removed).toMatchObject({ removed: ['karl@media.example'], guests: [] });
  });

  it("refuses a member's change to someone else's event and says why", async () => {
    const eventId = await makeEvent();
    const r = await call('POST', eventId, member, { add: ['x@y.test'] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as EventGuestsResponse).reason).toBe('not_organizer');
  });

  // ADR 0306 — "Reply all" from the event writes to the organizer as well as
  // the guests, but never to the reader; the GET carries the organizer.
  it('reads the organizer when it is someone else, and never the reader', async () => {
    const eventId = await makeEvent();
    await call('POST', eventId, owner, { add: ['karl@media.example'] });
    const mine = (await (await call('GET', eventId, owner)).json()) as EventGuestsResponse;
    expect(mine.organizer).toBeNull();

    const gcal = await db.selectFrom('events').select('gcal_event_id').where('id', '=', eventId).executeTakeFirstOrThrow();
    google.events.get(gcal.gcal_event_id!)!.organizer = { email: 'Host@Example.com', self: false };
    const theirs = (await (await call('GET', eventId, owner)).json()) as EventGuestsResponse;
    expect(theirs).toMatchObject({ organizer: 'host@example.com', guests: ['karl@media.example'] });
  });

  it('the bot finds everyone on an event and links the composer to them', async () => {
    const eventId = await makeEvent();
    await call('POST', eventId, owner, { add: ['karl@media.example', 'ro@example.com'] });
    await db.updateTable('users').set({ email: 'ro@example.com' }).where('id', '=', owner).execute();
    const personal = newId('g');
    await db
      .insertInto('groups')
      .values({
        id: personal,
        name: 'Personal',
        kind: 'personal',
        invite_code: 'XGSTP',
        ingest_email: 'p-gst@chord.app',
        created_by: owner,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: new Date().toISOString(),
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: personal, user_id: owner, role: 'owner', tier: 'verified', joined_at: new Date().toISOString() })
      .execute();
    const res = await applyToolCall(db, {
      groupId: personal,
      actorUserId: owner,
      provenance: null,
      turnId: 't2',
      tzOffset: '+00:00',
      call: { name: 'email_event_guests', args: { titleContains: 'Dinner' } },
    });
    expect((res.data as { recipients: string[] }).recipients).toEqual(['karl@media.example']);
    expect(res.card?.href).toBe('/email/compose?to=karl%40media.example&subject=Dinner');

    const shared = await applyToolCall(db, {
      groupId,
      actorUserId: owner,
      provenance: null,
      turnId: 't3',
      tzOffset: '+00:00',
      call: { name: 'email_event_guests', args: { eventId } },
    });
    expect((shared.data as { recipients: string[] }).recipients).toEqual([]);
  });

  it('is not reachable by someone outside the group, and takes addresses only', async () => {
    const eventId = await makeEvent();
    const stranger = await addUser('zz');
    expect((await call('GET', eventId, stranger)).status).toBe(404);
    expect((await call('POST', eventId, owner, { add: ['Karl Dale'] })).status).toBe(400);
    expect((await call('POST', eventId, owner, {})).status).toBe(400);
  });
});
