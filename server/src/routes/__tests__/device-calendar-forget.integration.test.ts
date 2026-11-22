/**
 * Switching Mirror off for a phone calendar used to leave every copy it had
 * sent on the server until the 30-day sweep (ADR 0226 addendum) noticed the
 * phone had stopped sending it - and switching off the LAST mirrored calendar
 * made the phone stop syncing altogether, so nothing ever told the server.
 * The app now calls DELETE /me/device-calendar/:id when Mirror goes off.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { syncDeviceCalendar } from '@/services/device-calendar.service.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// A real EventKit-shaped calendar id, as the phone sends it.
const SCHOOL = '64EF5A14-4F41-4CFF-952F-9D22439B4AE8';
const KIDS = 'A9C1E0B2-77D3-4C1A-9B5E-3F2D8E6C1A44';
const DAY = 86_400_000;

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

function at(days: number, hourUtc: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

async function mirror(user: string): Promise<void> {
  const ev = (calId: string, id: string, title: string, startsAt: string) => ({
    deviceCalendarId: calId,
    deviceEventId: id,
    title,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
  });
  await syncDeviceCalendar(db, user, {
    calendars: [
      { deviceCalendarId: SCHOOL, title: 'School', allowsModifications: false },
      { deviceCalendarId: KIDS, title: 'Kids', allowsModifications: true },
    ],
    events: [
      ev(SCHOOL, 'S1', 'Picture day', at(3, 13)),
      ev(SCHOOL, 'S2', 'Half day', at(5, 13)),
      ev(SCHOOL, 'S3', 'Parent conferences', at(8, 22)),
      ev(KIDS, 'K1', 'Piano', at(4, 22)),
    ],
    windowStart: at(-30, 0),
    windowEnd: at(60, 0),
  });
}

const uids = async (user: string): Promise<string[]> =>
  (await db.selectFrom('events').select('external_uid').where('owner_user_id', '=', user).execute())
    .map((r) => r.external_uid ?? '')
    .sort();

const sourceIds = async (user: string): Promise<string[]> =>
  (
    await db
      .selectFrom('calendar_sources')
      .select('google_calendar_id')
      .where('user_id', '=', user)
      .where('provider', '=', 'device')
      .execute()
  )
    .map((r) => r.google_calendar_id)
    .sort();

function forget(calId: string, tok: string): Promise<Response> {
  return fetch(`${base}${API.meDeviceCalendar(calId)}`, {
    method: 'DELETE',
    headers: { [SESSION_HEADER]: tok },
  });
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

describe('switching Mirror off forgets that phone calendar now', () => {
  it('removes its copies and its calendar row at once, leaving the other calendar alone', async () => {
    const me = await createUser(db, 'john');
    const tok = await mintToken(me);
    await mirror(me);
    expect((await uids(me)).filter((u) => u.startsWith(`device:${SCHOOL}:`))).toHaveLength(3);

    const res = await forget(SCHOOL, tok);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, events: 3, calendar: true });

    expect(await uids(me)).toEqual([`device:${KIDS}:K1`]);
    expect(await sourceIds(me)).toEqual([KIDS]);
  });

  it('keeps a copy the Google pull has adopted - it is the Google event now', async () => {
    const me = await createUser(db, 'john');
    const tok = await mintToken(me);
    await mirror(me);
    await db
      .updateTable('events')
      .set({ google_calendar_id: 'ownertest@gmail.com', gcal_event_id: 'g-picture-day' })
      .where('external_uid', '=', `device:${SCHOOL}:S1`)
      .execute();

    await forget(SCHOOL, tok);

    expect(await uids(me)).toEqual([`device:${KIDS}:K1`, `device:${SCHOOL}:S1`].sort());
  });

  it("never touches another account's copies of a calendar with the same id", async () => {
    const me = await createUser(db, 'john');
    const other = await createUser(db, 'someone-else');
    await mirror(me);
    await mirror(other);

    await forget(SCHOOL, await mintToken(other));

    expect((await uids(me)).filter((u) => u.startsWith(`device:${SCHOOL}:`))).toHaveLength(3);
    expect(await sourceIds(me)).toEqual([KIDS, SCHOOL].sort());
  });
});
