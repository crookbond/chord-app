/**
 * ADR 0057 — HTTP route for the device-calendar read-up.
 *
 * Exercises the wiring the service-level test doesn't: auth gating, zod
 * validation, the JSON response shape, and that mirrored events surface through
 * `GET /me/events` (the read path web/mobile use).
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type GroupEvent } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
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

const CAL = 'device-cal-A';

function sampleBatch(overrides: Record<string, unknown> = {}) {
  return {
    calendars: [{ deviceCalendarId: CAL, title: 'Personal', allowsModifications: true }],
    events: [
      {
        deviceCalendarId: CAL,
        deviceEventId: 'evt-1',
        title: 'Dentist',
        startsAt: '2026-07-01T15:00:00.000Z',
        endsAt: '2026-07-01T16:00:00.000Z',
        updatedAt: '2026-06-20T10:00:00.000Z',
      },
    ],
    windowStart: '2026-06-01T00:00:00.000Z',
    windowEnd: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('POST /me/device-calendar/sync (route)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tok = await mintToken(db, await createUser(db, 'dev-user'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  function post(body: unknown, token = tok): Promise<Response> {
    return fetch(`${base}${API.meDeviceCalendarSync}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: token },
      body: JSON.stringify(body),
    });
  }

  it('401s without a session', async () => {
    const res = await fetch(`${base}${API.meDeviceCalendarSync}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sampleBatch()),
    });
    expect(res.status).toBe(401);
  });

  it('400s on an invalid body', async () => {
    const res = await post({ events: [], calendars: [] }); // missing window bounds
    expect(res.status).toBe(400);
  });

  it('mirrors a device event and surfaces it via /me/events', async () => {
    const res = await post(sampleBatch());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inserted: 1, updated: 0, deduped: 0, deleted: 0 });

    const events = (await (
      await fetch(`${base}${API.meEvents}`, { headers: { [SESSION_HEADER]: tok } })
    ).json()) as GroupEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: 'Dentist',
      externalUid: `device:${CAL}:evt-1`,
    });
  });

  it('reverse-deletes through the route when an event drops from a later batch', async () => {
    await post(sampleBatch());
    const res = await post(sampleBatch({ events: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: 1 });

    const events = (await (
      await fetch(`${base}${API.meEvents}`, { headers: { [SESSION_HEADER]: tok } })
    ).json()) as GroupEvent[];
    expect(events).toHaveLength(0);
  });
});
