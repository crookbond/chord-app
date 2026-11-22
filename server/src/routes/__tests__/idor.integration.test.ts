/**
 * Insecure direct object references found by the CASA AL1 review (case
 * 3.1.4). Each test is the attack: user B, signed in but not entitled,
 * acts on user A's record by its id. Every one of these succeeded before
 * the fix.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { generatePairingCode } from '@/services/connectors/pairing.service.js';
import { createEvent, getEvent, listEventCopies } from '@/services/events.service.js';
import { createMedia } from '@/services/personal.service.js';
import { createTrip, listReservationsForTrip } from '@/services/trips.service.js';
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

function send(method: string, path: string, tok: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: tok },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
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

describe('IDOR: PATCH /media-items/:itemId', () => {
  it('a non-member cannot toggle or read another group\'s media item', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const groupA = await makeGroup([a]);
    await makeGroup([b]);
    const item = await createMedia(db, { groupId: groupA, kind: 'movie', title: 'Secret film', createdBy: a });

    const res = await send('PATCH', API.mediaItem(item.id), await mintToken(b), { done: true });
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('Secret film');
    const row = await db.selectFrom('media_items').select('done').where('id', '=', item.id).executeTakeFirstOrThrow();
    expect(row.done).toBe(0);
  });

  it('a member still can', async () => {
    const a = await createUser(db, 'alice');
    const groupA = await makeGroup([a]);
    const item = await createMedia(db, { groupId: groupA, kind: 'movie', title: 'Film', createdBy: a });

    const res = await send('PATCH', API.mediaItem(item.id), await mintToken(a), { done: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { done: boolean }).done).toBe(true);
  });
});

describe('IDOR: POST /ingest/ics', () => {
  function icsForm(groupId: string): FormData {
    const start = new Date(Date.now() + 10 * 86_400_000);
    const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const end = new Date(start.getTime() + 3_600_000);
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:idor-ics-1@test',
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(end)}`,
      'SUMMARY:Planted event',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const form = new FormData();
    form.append('groupId', groupId);
    form.append('file', new Blob([ics], { type: 'text/calendar' }), 'cal.ics');
    return form;
  }

  it('a non-member cannot import events into another group', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const groupA = await makeGroup([a]);
    await makeGroup([b]);

    const res = await fetch(`${base}${API.ingestIcs}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: await mintToken(b) },
      body: icsForm(groupA),
    });
    expect(res.status).toBe(403);
    const planted = await db.selectFrom('events').select('id').where('group_id', '=', groupA).execute();
    expect(planted).toHaveLength(0);
  });

  it('a member still can', async () => {
    const a = await createUser(db, 'alice');
    const groupA = await makeGroup([a]);

    const res = await fetch(`${base}${API.ingestIcs}`, {
      method: 'POST',
      headers: { [SESSION_HEADER]: await mintToken(a) },
      body: icsForm(groupA),
    });
    expect(res.status).toBe(201);
  });
});

describe('IDOR: POST /trips/:tripId/reservations', () => {
  it('a body tripId cannot redirect the reservation onto another group\'s trip', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const groupA = await makeGroup([a]);
    const groupB = await makeGroup([b]);
    const tripA = await createTrip(db, {
      groupId: groupA, createdBy: a, name: 'Paris', destination: 'Paris',
      startDate: '2027-03-01', endDate: '2027-03-08', participantIds: [],
    });
    const tripB = await createTrip(db, {
      groupId: groupB, createdBy: b, name: 'Rome', destination: 'Rome',
      startDate: '2027-04-01', endDate: '2027-04-08', participantIds: [],
    });

    const res = await send('POST', `/api/v1/trips/${tripB.id}/reservations`, await mintToken(b), {
      tripId: tripA.id,
      kind: 'restaurant',
      name: 'Planted dinner',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { tripId: string }).tripId).toBe(tripB.id);
    expect(await listReservationsForTrip(db, tripA.id)).toHaveLength(0);
    expect(await listReservationsForTrip(db, tripB.id)).toHaveLength(1);
  });
});

describe('IDOR: PATCH/DELETE /events/:eventId', () => {
  async function sharedEvent() {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const group = await makeGroup([a, b]);
    const created = await createEvent(db, { groupId: group, title: 'Dentist', startsAt: inDays(5), createdBy: a });
    const copies = await listEventCopies(db, created.id);
    const ev = copies.find((c) => c.ownerUserId === a);
    const bCopy = copies.find((c) => c.ownerUserId === b);
    expect(ev).toBeDefined();
    expect(bCopy).toBeDefined();
    const roles = await db.selectFrom('events').select(['id', 'role']).where('id', 'in', [ev!.id, bCopy!.id]).execute();
    expect(roles.find((r) => r.id === ev!.id)?.role).toBe('organizer');
    expect(roles.find((r) => r.id === bCopy!.id)?.role).toBe('attendee');
    return { a, b, group, ev: ev!, bCopy: bCopy! };
  }

  it('another member cannot edit the organizer\'s copy (and through it everyone\'s)', async () => {
    const { b, ev } = await sharedEvent();
    const res = await send('PATCH', API.event(ev.id), await mintToken(b), { title: 'Hijacked' });
    expect(res.status).toBe(404);
    expect((await getEvent(db, ev.id))!.title).toBe('Dentist');
  });

  it('another member cannot delete the organizer\'s copy', async () => {
    const { b, ev } = await sharedEvent();
    const res = await send('DELETE', API.event(ev.id), await mintToken(b));
    expect(res.status).toBe(404);
    expect(await getEvent(db, ev.id)).not.toBeNull();
  });

  it('each member still edits and deletes their own copy', async () => {
    const { a, b, ev, bCopy } = await sharedEvent();
    const edit = await send('PATCH', API.event(ev.id), await mintToken(a), { title: 'Dentist 2pm' });
    expect(edit.status).toBe(200);
    expect((await getEvent(db, ev.id))!.title).toBe('Dentist 2pm');

    const del = await send('DELETE', API.event(bCopy.id), await mintToken(b));
    expect(del.status).toBe(204);
    expect(await getEvent(db, bCopy.id)).toBeNull();
    expect(await getEvent(db, ev.id)).not.toBeNull();
  });

  it('a legacy row with no owner stays editable by any member', async () => {
    const { b, ev } = await sharedEvent();
    await db.updateTable('events').set({ owner_user_id: null }).where('id', '=', ev.id).execute();
    const res = await send('PATCH', API.event(ev.id), await mintToken(b), { title: 'Legacy edit' });
    expect(res.status).toBe(200);
  });
});

describe('IDOR: POST /events/:eventId/rsvps userId', () => {
  it('cannot attach an RSVP to a user outside the event\'s group', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const outsider = await createUser(db, 'carol');
    const group = await makeGroup([a, b]);
    await makeGroup([outsider]);
    const ev = await createEvent(db, { groupId: group, title: 'Party', startsAt: inDays(5), createdBy: a });

    const res = await send('POST', API.eventRsvps(ev.id), await mintToken(b), {
      userId: outsider,
      displayName: 'Carol',
      status: 'yes',
    });
    expect(res.status).toBe(403);
    const rows = await db.selectFrom('rsvps').select('user_id').where('event_id', '=', ev.id).execute();
    expect(rows.some((r) => r.user_id === outsider)).toBe(false);
  });

  it('still records an RSVP for yourself, a fellow member, or a named guest', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const group = await makeGroup([a, b]);
    const ev = await createEvent(db, { groupId: group, title: 'Party', startsAt: inDays(5), createdBy: a });
    const tok = await mintToken(b);

    expect((await send('POST', API.eventRsvps(ev.id), tok, { userId: b, displayName: 'Bob', status: 'yes' })).status).toBe(201);
    expect((await send('POST', API.eventRsvps(ev.id), tok, { userId: a, displayName: 'Alice', status: 'maybe' })).status).toBe(201);
    expect((await send('POST', API.eventRsvps(ev.id), tok, { displayName: 'Grandma', status: 'yes' })).status).toBe(201);
  });
});

describe('IDOR: GET /groups/:id/connectors/pair/:code', () => {
  it('a member of one group cannot read another group\'s pairing code status', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');
    const groupA = await makeGroup([a]);
    const groupB = await makeGroup([b]);
    const { code } = await generatePairingCode(db, { platform: 'telegram', groupId: groupA, userId: a });

    const res = await send('GET', API.groupConnectorPairStatus(groupB, code), await mintToken(b));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('unknown');

    const own = await send('GET', API.groupConnectorPairStatus(groupA, code), await mintToken(a));
    expect(((await own.json()) as { status: string }).status).toBe('pending');
  });
});
