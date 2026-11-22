/**
 * A time at a place is on that place's clock (ADR 0245, closing ADR 0240's
 * open item), and the text-fence tool path gets the same clock fix native
 * tool calls got in ADR 0244.
 *
 * Shapes are from the demo account: a reader in New York (-04:00 on the day
 * of the recording, 12 October 2026) with a Denver trip 20-24 November, the
 * Hyatt Regency Denver at 650 15th St.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { placeTimeZone } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { anchorModelTimes } from '@/services/bot/bot.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { placeDatetime } from '@/services/bot/trip_classifier.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { addAccommodation, createTrip } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const RECORDED = new Date('2026-10-12T22:52:00Z');
const NY = 'America/New_York';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(RECORDED);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('placeTimeZone', () => {
  it('reads a city, an airport, and a street address', () => {
    expect(placeTimeZone('Denver')).toBe('America/Denver');
    expect(placeTimeZone('DEN')).toBe('America/Denver');
    expect(placeTimeZone('650 15th St, Denver, CO')).toBe('America/Denver');
  });
  it('is null for a place it does not know: never a guess', () => {
    expect(placeTimeZone('12 Main St, Springfield')).toBeNull();
    expect(placeTimeZone('Zoom')).toBeNull();
    expect(placeTimeZone(null)).toBeNull();
  });
});

describe('placeDatetime', () => {
  it('a 7 PM dinner in Denver on 21 November is 7 PM Denver, however the model stamped it', () => {
    // Bare, stamped with the reader's offset today, stamped with the reader's on that date.
    for (const raw of ['2026-11-21T19:00:00', '2026-11-21T19:00:00-04:00', '2026-11-21T19:00:00-05:00']) {
      expect(placeDatetime(raw, '650 15th St, Denver, CO', -240, NY)).toEqual({
        at: '2026-11-21T19:00:00-07:00',
        zone: 'America/Denver',
      });
    }
  });
  it('keeps an offset that is neither the reader\'s nor the place\'s: it was chosen', () => {
    expect(placeDatetime('2026-11-21T19:00:00-08:00', 'Denver', -240, NY).at).toBe('2026-11-21T19:00:00-08:00');
  });
  it('with an unknown place, uses the reader\'s clock for that date and says the zone is unknown', () => {
    expect(placeDatetime('2026-11-21T19:00:00', '12 Main St, Springfield', -240, NY)).toEqual({
      at: '2026-11-21T19:00:00-05:00',
      zone: null,
    });
  });
});

describe('anchorModelTimes, the step both tool paths share', () => {
  const run = (name: string, args: Record<string, unknown>, zoneNamed = false) =>
    anchorModelTimes(name, args, '-04:00', NY, zoneNamed) as Record<string, unknown>;

  it('the fence path: an event after the clocks change is not left on today\'s offset', () => {
    expect(run('create_event', { title: 'Dentist', startsAt: '2026-12-05T13:00:00-04:00' }).startsAt).toBe(
      '2026-12-05T13:00:00-05:00',
    );
  });
  it('an event with a location in another city is on that city\'s clock', () => {
    expect(
      run('create_event', { title: 'Dinner', location: 'Denver, CO', startsAt: '2026-11-21T19:00:00-04:00' })
        .startsAt,
    ).toBe('2026-11-21T19:00:00-07:00');
  });
  it('message_user\'s event is a create_event: its times get the same clock', () => {
    // The event nested under `message_user` was never looked at, so "coffee
    // with Adrian in Denver at 7" stayed on the reader's clock.
    const a = run('message_user', {
      recipientName: 'Adrian',
      body: 'Coffee at 7?',
      event: { title: 'Coffee', location: 'Denver, CO', startsAt: '2026-11-21T19:00:00-04:00' },
    });
    expect((a.event as Record<string, unknown>).startsAt).toBe('2026-11-21T19:00:00-07:00');
    const b = run('message_user', {
      recipientName: 'Adrian',
      body: 'Dentist?',
      event: { title: 'Dentist', startsAt: '2026-12-05T13:00:00-04:00' },
    });
    expect((b.event as Record<string, unknown>).startsAt).toBe('2026-12-05T13:00:00-05:00');
  });
  it('a reservation with an address is on the address\'s clock', () => {
    expect(
      run('add_reservation', {
        name: 'Guard and Grace',
        kind: 'restaurant',
        address: '1801 California St, Denver, CO',
        dateTime: '2026-11-21T19:00:00-04:00',
      }).dateTime,
    ).toBe('2026-11-21T19:00:00-07:00');
  });
  it('ADR 0297: an edit that names a time zone puts its times on that zone\'s clock', () => {
    const a = run('update_event', { eventId: 'e1', startsAt: '2026-11-21T15:00:00', timeZone: 'Europe/Paris' });
    expect(a.startsAt).toBe('2026-11-21T15:00:00+01:00');
    // Even when the user named the zone in words, the stated zone still wins.
    const b = run('update_event', { eventId: 'e1', startsAt: '2026-07-01T09:30:00', timeZone: 'Asia/Kolkata' }, true);
    expect(b.startsAt).toBe('2026-07-01T09:30:00+05:30');
  });
  it('is left as written when the user named a time zone, and for tools with no new time', () => {
    expect(
      run('create_event', { title: 'Dinner', location: 'Denver', startsAt: '2026-11-21T19:00:00-04:00' }, true)
        .startsAt,
    ).toBe('2026-11-21T19:00:00-04:00');
    expect(run('find_events', { startDate: '2026-11-21T19:00:00-04:00' }).startDate).toBe(
      '2026-11-21T19:00:00-04:00',
    );
  });
});

describe('add_reservation on a trip', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let tripId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'place-clock');
    await db.updateTable('users').set({ last_tz: NY }).where('id', '=', userId).execute();
    groupId = (await ensurePersonalGroup(db, userId)).id;
    const trip = await createTrip(db, {
      groupId,
      name: 'Trip to DEN',
      destination: 'DEN',
      startDate: '2026-11-20',
      endDate: '2026-11-24',
      createdBy: userId,
      participantIds: [],
    });
    tripId = trip.id;
    await addAccommodation(db, {
      tripId,
      propertyName: 'Hyatt Regency Denver',
      address: '650 15th St, Denver, CO',
      checkinDate: '2026-11-20',
      checkoutDate: '2026-11-24',
    });
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const reserve = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-res',
      tzOffset: '-04:00',
      tz: NY,
      call: { name: 'add_reservation', args: { tripId, kind: 'restaurant', ...args } as never },
    });
  const stored = async (name: string): Promise<string | null> =>
    (
      await db
        .selectFrom('trip_reservations')
        .select('date_time')
        .where('name', '=', name)
        .executeTakeFirstOrThrow()
    ).date_time;

  it('with no address, takes the clock of the stay it falls within: Denver, not New York', async () => {
    const res = await reserve({ name: 'Guard and Grace', dateTime: '2026-11-21T19:00:00-04:00' });
    expect(await stored('Guard and Grace')).toBe('2026-11-21T19:00:00-07:00');
    expect(res.data).toMatchObject({ timeZone: 'America/Denver', when: expect.stringContaining('19:00') });
  });

  it('with a place it cannot put a zone to, uses the user\'s clock and tells the bot so', async () => {
    await db.updateTable('accommodations').set({ address: 'The Lodge' }).where('trip_id', '=', tripId).execute();
    await db.updateTable('trips').set({ destination: 'Mountain cabin' }).where('id', '=', tripId).execute();
    const res = await reserve({ name: 'Camp dinner', dateTime: '2026-11-21T19:00:00-05:00' });
    expect(await stored('Camp dinner')).toBe('2026-11-21T19:00:00-05:00');
    const data = res.data as { timeZone: string | null; instruction?: string };
    expect(data.timeZone).toBeNull();
    expect(data.instruction).toContain('not known');
  });
});
