/**
 * ADR 0057 addendum — when the phone's mirror put an event in Chord first and
 * the Google pull brings the same event second, the phone's copy goes.
 *
 * ADR 0228 only did this for Outlook calendars, and compared starts as
 * instants, so an all-day event (phone: the instant of local midnight; Google:
 * a floating date) never matched on either provider.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { syncDeviceCalendar } from '@/services/device-calendar.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const FAMILY = 'family123@group.calendar.google.com';

const gEvent = (id: string, summary: string, start: object, end: object) => ({
  kind: 'calendar#event',
  id,
  status: 'confirmed',
  summary,
  iCalUID: `${id}@google.com`,
  start,
  end,
  updated: '2026-06-02T16:00:00.000Z',
  sequence: 0,
});

describe('a Google event the phone mirrored first', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'phone-and-google');
    await upsertCalendarSource(db, userId, {
      googleCalendarId: FAMILY,
      summary: 'Family',
      accessRole: 'writer',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? gjson({ items, nextSyncToken: 'tok' }) : gjson({}),
      ),
    );
  const phone = (tz: string | null, ev: Parameters<typeof syncDeviceCalendar>[2]['events'][number]) =>
    syncDeviceCalendar(db, userId, {
      calendars: [{ deviceCalendarId: 'PHONECAL', title: 'Family' }],
      events: [ev],
      windowStart: '2026-06-01T00:00:00.000Z',
      windowEnd: '2026-09-01T00:00:00.000Z',
      ...(tz ? { timeZone: tz } : {}),
    });
  const titles = async () =>
    (
      await db
        .selectFrom('events')
        .select(['title', 'external_uid'])
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .execute()
    ).map((r) => `${r.title}:${r.external_uid?.startsWith('device:') ? 'phone' : 'server'}`);

  it.each([
    ['iPhone, New York', 'America/New_York', '2026-07-11T04:00:00.000Z', '2026-07-12T03:59:59.000Z'],
    ['iPhone, Kolkata', 'Asia/Kolkata', '2026-07-10T18:30:00.000Z', '2026-07-11T18:29:59.000Z'],
    ['Android, New York', 'America/New_York', '2026-07-11T00:00:00.000Z', '2026-07-12T00:00:00.000Z'],
  ])('all-day (%s): one copy remains', async (_label, tz, startsAt, endsAt) => {
    await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
    await phone(null, {
      deviceCalendarId: 'PHONECAL',
      deviceEventId: 'camp-1',
      title: 'Camp drop-off day',
      startsAt,
      endsAt,
      allDay: true,
    });
    expect(await titles()).toEqual(['Camp drop-off day:phone']);

    stubPull([gEvent('camp', 'Camp drop-off day', { date: '2026-07-11' }, { date: '2026-07-12' })]);
    const res = await pullCalendarChanges(db, userId, FAMILY, 'fake-token');
    expect(res.inserted).toBe(1);
    expect(await titles()).toEqual(['Camp drop-off day:server']);

    // The phone's next sync skips the event instead of mirroring it again.
    const again = await phone(null, {
      deviceCalendarId: 'PHONECAL',
      deviceEventId: 'camp-1',
      title: 'Camp drop-off day',
      startsAt,
      endsAt,
      allDay: true,
    });
    expect(again).toMatchObject({ inserted: 0, deduped: 1 });
    expect(await titles()).toEqual(['Camp drop-off day:server']);
  });

  it('timed: the phone copy goes on a Google calendar too, not only Outlook', async () => {
    await phone('America/New_York', {
      deviceCalendarId: 'PHONECAL',
      deviceEventId: 'dent-1',
      title: 'Dentist',
      startsAt: '2026-07-14T19:30:00.000Z',
      endsAt: '2026-07-14T20:30:00.000Z',
    });
    stubPull([
      gEvent(
        'dent',
        'Dentist',
        { dateTime: '2026-07-14T15:30:00-04:00', timeZone: 'America/New_York' },
        { dateTime: '2026-07-14T16:30:00-04:00', timeZone: 'America/New_York' },
      ),
    ]);
    await pullCalendarChanges(db, userId, FAMILY, 'fake-token');
    expect(await titles()).toEqual(['Dentist:server']);
  });

  it('a phone event on another day stays', async () => {
    await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', userId).execute();
    await phone(null, {
      deviceCalendarId: 'PHONECAL',
      deviceEventId: 'camp-2',
      title: 'Camp drop-off day',
      startsAt: '2026-07-12T04:00:00.000Z',
      endsAt: '2026-07-13T03:59:59.000Z',
      allDay: true,
    });
    stubPull([gEvent('camp', 'Camp drop-off day', { date: '2026-07-11' }, { date: '2026-07-12' })]);
    await pullCalendarChanges(db, userId, FAMILY, 'fake-token');
    expect((await titles()).sort()).toEqual(['Camp drop-off day:phone', 'Camp drop-off day:server']);
  });
});
