/**
 * ADR 0057 — device calendar read-up ingest.
 *
 * Covers the four behaviors that are verifiable server-side without a device:
 * insert, LWW update, the two dedup layers (exact-UID + fuzzy), and
 * reverse-delete.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DeviceCalendarSyncRequest } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { syncDeviceCalendar } from '@/services/device-calendar.service.js';
import { listEventsForUser } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

const CAL = 'dev-cal-1';
const WINDOW_START = '2026-06-01T00:00:00.000Z';
const WINDOW_END = '2026-09-01T00:00:00.000Z';

function batch(
  events: DeviceCalendarSyncRequest['events'],
  calendars: DeviceCalendarSyncRequest['calendars'] = [{ deviceCalendarId: CAL, title: 'Personal' }],
): DeviceCalendarSyncRequest {
  return { calendars, events, windowStart: WINDOW_START, windowEnd: WINDOW_END };
}

function ev(over: Partial<DeviceCalendarSyncRequest['events'][number]> = {}) {
  return {
    deviceCalendarId: CAL,
    deviceEventId: 'd1',
    title: 'Dentist',
    startsAt: '2026-07-01T15:00:00.000Z',
    endsAt: '2026-07-01T16:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
    ...over,
  };
}

describe('syncDeviceCalendar', () => {
  it('inserts a device event as a personal mirror row and a device calendar source', async () => {
    const userId = await createUser(db, 'dev-user');
    const res = await syncDeviceCalendar(db, userId, batch([ev()]));
    expect(res).toMatchObject({ inserted: 1, updated: 0, deduped: 0, deleted: 0 });

    const visible = await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 });
    expect(visible).toHaveLength(1);
    expect(visible[0]!.title).toBe('Dentist');
    expect(visible[0]!.externalUid).toBe(`device:${CAL}:d1`);

    const row = await db
      .selectFrom('events')
      .select(['group_ids', 'owner_user_id', 'gcal_sync_status', 'local_dirty'])
      .where('owner_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.group_ids).toEqual([]); // personal mirror — not in any chat
    expect(row.gcal_sync_status).toBe('skipped'); // never pushed to Google
    expect(Number(row.local_dirty)).toBe(0);

    const src = await db
      .selectFrom('calendar_sources')
      .select(['provider', 'google_calendar_id'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(src.provider).toBe('device');
    expect(src.google_calendar_id).toBe(CAL);
  });

  it('updates an existing row only when the device copy is newer (LWW)', async () => {
    const userId = await createUser(db, 'dev-user');
    await syncDeviceCalendar(db, userId, batch([ev()]));

    // Older edit — ignored.
    let res = await syncDeviceCalendar(
      db,
      userId,
      batch([ev({ title: 'Stale', updatedAt: '2026-06-19T10:00:00.000Z' })]),
    );
    expect(res.updated).toBe(0);
    expect((await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 }))[0]!.title).toBe('Dentist');

    // Newer edit — applied.
    res = await syncDeviceCalendar(
      db,
      userId,
      batch([ev({ title: 'Dentist (moved)', updatedAt: '2026-06-21T10:00:00.000Z' })]),
    );
    expect(res.updated).toBe(1);
    expect((await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 }))[0]!.title).toBe('Dentist (moved)');
  });

  it('Layer 0: dedups a device event against a Google row sharing its ical_uid', async () => {
    const userId = await createUser(db, 'dev-user');
    const personalGroup = await ensurePersonalGroup(db, userId);
    const now = new Date().toISOString();
    // A Google-pulled copy already in the DB (server pulled it via Google API).
    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: personalGroup.id,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'attendee',
        title: 'Quarterly review',
        starts_at: '2026-07-10T09:00:00.000Z',
        created_at: now,
        updated_at: now,
        created_by: userId,
        external_uid: 'gcal:primary:abc123',
        ical_uid: 'shared-uid-xyz',
        gcal_sync_status: 'synced',
      })
      .execute();

    // Same event mirrored onto the device — different title/time, same UID.
    const res = await syncDeviceCalendar(
      db,
      userId,
      batch([
        ev({
          deviceEventId: 'mirror',
          title: 'Q review (device label)',
          startsAt: '2026-07-10T09:30:00.000Z',
          externalId: 'shared-uid-xyz',
        }),
      ]),
    );
    expect(res).toMatchObject({ inserted: 0, deduped: 1 });
    expect(await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 })).toHaveLength(1); // no duplicate
  });

  it('Layer 2: dedups a device event with no UID against a same title/start row', async () => {
    const userId = await createUser(db, 'dev-user');
    const personalGroup = await ensurePersonalGroup(db, userId);
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: personalGroup.id,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Soccer practice',
        starts_at: '2026-07-05T17:00:00.000Z',
        created_at: now,
        updated_at: now,
        created_by: userId,
        external_uid: 'gcal:primary:soccer',
        ical_uid: 'gcal-soccer',
        gcal_sync_status: 'synced',
      })
      .execute();

    const res = await syncDeviceCalendar(
      db,
      userId,
      batch([
        ev({ deviceEventId: 's', title: '  Soccer Practice ', startsAt: '2026-07-05T17:00:00.000Z' }),
      ]),
    );
    expect(res).toMatchObject({ inserted: 0, deduped: 1 });
    expect(await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 })).toHaveLength(1);
  });

  it('Layer 2: matches a Google copy stored as "…00Z" against the phone\'s "…00.000Z" (prod, school feed)', async () => {
    // The school's calendar is subscribed both in Google (pulled server-side)
    // and on the phone. The two start strings differ only in milliseconds,
    // and a string compare made every phone copy a new row.
    const userId = await createUser(db, 'dev-user');
    const personalGroup = await ensurePersonalGroup(db, userId);
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: personalGroup.id,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'attendee',
        title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night',
        starts_at: '2026-07-23T20:00:00Z',
        ends_at: '2026-07-23T22:00:00Z',
        created_at: now,
        updated_at: now,
        created_by: userId,
        google_calendar_id: '85hdsmattb1vjvo8et17gspnkhr30ujk@import.calendar.google.com',
        ical_uid: 'b5f0f01c-ef4c-44ba-854b-9672acf95421',
        gcal_sync_status: 'synced',
      })
      .execute();

    const res = await syncDeviceCalendar(
      db,
      userId,
      batch([
        ev({
          deviceEventId: 'F0A9F5C8-C7F3-454D-89BC-D3E7388C0007',
          externalId: 'b335af48-9031-4932-bd8b-282ab510a43a',
          title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night',
          startsAt: '2026-07-23T20:00:00.000Z',
          endsAt: '2026-07-23T22:00:00.000Z',
        }),
      ]),
    );
    expect(res).toMatchObject({ inserted: 0, deduped: 1 });
    expect(await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 })).toHaveLength(1);
  });

  it('keeps one row when a subscribed calendar hands the same event a new id on every sync (prod churn)', async () => {
    // iOS re-issued both the event id and the external id of every event in
    // a subscribed feed on each refresh: 71,525 tombstones for one user.
    const userId = await createUser(db, 'dev-user');
    const feed = (id: string, ext: string) =>
      ev({ deviceEventId: id, externalId: ext, title: '9th Grade Activities Fair', startsAt: '2026-07-09T20:30:00.000Z' });

    await syncDeviceCalendar(db, userId, batch([feed('id-1', 'ext-1')]));
    const second = await syncDeviceCalendar(db, userId, batch([feed('id-2', 'ext-2')]));
    const third = await syncDeviceCalendar(db, userId, batch([feed('id-3', 'ext-3')]));
    expect(second).toMatchObject({ inserted: 0, updated: 1, deleted: 0 });
    expect(third).toMatchObject({ inserted: 0, updated: 1, deleted: 0 });

    const rows = await db
      .selectFrom('events')
      .select(['external_uid', 'deleted_at'])
      .where('owner_user_id', '=', userId)
      .execute();
    expect(rows).toEqual([{ external_uid: `device:${CAL}:id-3`, deleted_at: null }]);
  });

  it('two same-titled events at one time on one calendar stay two rows across a re-id', async () => {
    const userId = await createUser(db, 'dev-user');
    const twin = (id: string) => ev({ deviceEventId: id, title: 'Carpool', startsAt: '2026-07-02T12:00:00.000Z' });
    await syncDeviceCalendar(db, userId, batch([twin('a1'), twin('b1')]));
    await syncDeviceCalendar(db, userId, batch([twin('a2'), twin('b2')]));
    const live = await db
      .selectFrom('events')
      .select('external_uid')
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('external_uid')
      .execute();
    expect(live.map((r) => r.external_uid)).toEqual([`device:${CAL}:a2`, `device:${CAL}:b2`]);
    const all = await db.selectFrom('events').select('id').where('owner_user_id', '=', userId).execute();
    expect(all).toHaveLength(2);
  });

  describe('all-day events (phone sends an instant, Google stores a floating date)', () => {
    // Google's all-day "Independence Day" on 4 July, pulled server-side and
    // stored floating (ADR 0040); the same calendar is also on the phone.
    async function seedGoogleAllDay(userId: string, tz: string | null) {
      if (tz) await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
      const personalGroup = await ensurePersonalGroup(db, userId);
      const now = new Date().toISOString();
      await db
        .insertInto('events')
        .values({
          id: newId('e'),
          group_id: personalGroup.id,
          group_ids: '[]',
          owner_user_id: userId,
          organizer_user_id: userId,
          role: 'attendee',
          title: 'Independence Day',
          starts_at: '2026-07-04T00:00:00',
          ends_at: '2026-07-05T00:00:00',
          all_day: 1,
          created_at: now,
          updated_at: now,
          created_by: userId,
          google_calendar_id: 'en.usa#holiday@group.v.calendar.google.com',
          gcal_event_id: '20260704_holiday',
          ical_uid: '20260704_holiday@google.com',
          gcal_sync_status: 'synced',
        })
        .execute();
    }
    const allDay = (startsAt: string, endsAt: string) =>
      ev({ deviceEventId: 'h1', title: 'Independence Day', startsAt, endsAt, allDay: true });
    const liveRows = async (userId: string) =>
      db
        .selectFrom('events')
        .select(['external_uid', 'starts_at', 'ends_at'])
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .execute();

    it('iPhone in New York: local midnight (04:00Z) is the same day', async () => {
      const userId = await createUser(db, 'dev-user');
      await seedGoogleAllDay(userId, 'America/New_York');
      const res = await syncDeviceCalendar(
        db,
        userId,
        batch([allDay('2026-07-04T04:00:00.000Z', '2026-07-05T03:59:59.000Z')]),
      );
      expect(res).toMatchObject({ inserted: 0, deduped: 1 });
      expect(await liveRows(userId)).toHaveLength(1);
    });

    it('iPhone in Kolkata: local midnight falls on the previous UTC day', async () => {
      const userId = await createUser(db, 'dev-user');
      await seedGoogleAllDay(userId, 'Asia/Kolkata');
      const res = await syncDeviceCalendar(
        db,
        userId,
        batch([allDay('2026-07-03T18:30:00.000Z', '2026-07-04T18:29:59.000Z')]),
      );
      expect(res).toMatchObject({ inserted: 0, deduped: 1 });
      expect(await liveRows(userId)).toHaveLength(1);
    });

    it('a zone sent with the batch wins over a stale last_tz', async () => {
      const userId = await createUser(db, 'dev-user');
      await seedGoogleAllDay(userId, 'America/Los_Angeles');
      const res = await syncDeviceCalendar(db, userId, {
        ...batch([allDay('2026-07-03T15:00:00.000Z', '2026-07-04T14:59:59.000Z')]),
        timeZone: 'Asia/Tokyo',
      });
      expect(res).toMatchObject({ inserted: 0, deduped: 1 });
    });

    it('Android in New York: UTC midnight is the date itself, not 8pm the night before', async () => {
      const userId = await createUser(db, 'dev-user');
      await seedGoogleAllDay(userId, 'America/New_York');
      const res = await syncDeviceCalendar(
        db,
        userId,
        batch([allDay('2026-07-04T00:00:00.000Z', '2026-07-05T00:00:00.000Z')]),
      );
      expect(res).toMatchObject({ inserted: 0, deduped: 1 });
    });

    it('a phone copy already mirrored twice goes on the next sync', async () => {
      // What prod holds today: the phone row went in (as an instant) beside
      // the Google row, because the two never matched.
      const userId = await createUser(db, 'dev-user');
      await db.updateTable('users').set({ last_tz: 'Asia/Kolkata' }).where('id', '=', userId).execute();
      const phoneCopy = allDay('2026-07-03T18:30:00.000Z', '2026-07-04T18:29:59.000Z');
      await syncDeviceCalendar(db, userId, batch([phoneCopy]));
      await seedGoogleAllDay(userId, null);
      expect(await liveRows(userId)).toHaveLength(2);

      const res = await syncDeviceCalendar(db, userId, batch([phoneCopy]));
      expect(res).toMatchObject({ inserted: 0, updated: 0, deduped: 1, deleted: 0 });
      expect((await liveRows(userId)).map((r) => r.external_uid)).toEqual([null]);
    });

    it('a different day is a different event', async () => {
      const userId = await createUser(db, 'dev-user');
      await seedGoogleAllDay(userId, 'America/New_York');
      const res = await syncDeviceCalendar(
        db,
        userId,
        batch([allDay('2026-07-05T04:00:00.000Z', '2026-07-06T03:59:59.000Z')]),
      );
      expect(res).toMatchObject({ inserted: 1, deduped: 0 });
    });

    it('a phone-only all-day event is stored as a floating date, the way Google ones are', async () => {
      for (const [tz, start, end] of [
        ['America/New_York', '2026-07-10T04:00:00.000Z', '2026-07-11T03:59:59.000Z'],
        ['Asia/Kolkata', '2026-07-09T18:30:00.000Z', '2026-07-10T18:29:59.000Z'],
        ['America/New_York', '2026-07-10T00:00:00.000Z', '2026-07-11T00:00:00.000Z'],
      ] as const) {
        const userId = await createUser(db);
        await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
        await syncDeviceCalendar(db, userId, batch([ev({ deviceEventId: 'b1', title: 'Birthday', startsAt: start, endsAt: end, allDay: true })]));
        expect(await liveRows(userId)).toEqual([
          { external_uid: `device:${CAL}:b1`, starts_at: '2026-07-10T00:00:00', ends_at: '2026-07-11T00:00:00' },
        ]);
      }
    });
  });

  it('reverse-deletes an in-window device event dropped from a later batch', async () => {
    const userId = await createUser(db, 'dev-user');
    await syncDeviceCalendar(
      db,
      userId,
      batch([ev({ deviceEventId: 'a', title: 'A' }), ev({ deviceEventId: 'b', title: 'B' })]),
    );
    expect(await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 })).toHaveLength(2);

    // Second sync omits 'a' (deleted on device); 'b' remains.
    const res = await syncDeviceCalendar(db, userId, batch([ev({ deviceEventId: 'b', title: 'B' })]));
    expect(res.deleted).toBe(1);
    const visible = await listEventsForUser(db, userId, { pastDays: 3650, futureDays: 3650 });
    expect(visible.map((e) => e.title)).toEqual(['B']);
  });
});
