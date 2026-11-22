/**
 * Re-uploading the same itinerary must not duplicate the trip's legs or
 * accommodations (same dates / PNR / passengers) — even when the second
 * upload's timestamps differ in format. Both files are kept; only one entity
 * appears. Covers the tolerant dedup in addTravelLeg / addAccommodation.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addAccommodation,
  addTravelLeg,
  createTrip,
  findExistingAccommodation,
  findExistingLeg,
} from '@/services/trips.service.js';

describe('itinerary re-upload dedup', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let uid: string;
  let tripId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john', 'John');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    groupId = g.id;
    const trip = await createTrip(db, {
      groupId,
      createdBy: uid,
      name: 'NYC',
      destination: 'JFK',
      startDate: '2026-06-12',
      endDate: '2026-06-12',
      participantIds: [],
    });
    tripId = trip.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const legCount = async () =>
    (await db.selectFrom('travel_legs').selectAll().where('trip_id', '=', tripId).execute()).length;
  const accomCount = async () =>
    (await db.selectFrom('accommodations').selectAll().where('trip_id', '=', tripId).execute()).length;

  it('does not duplicate a flight leg on re-upload (date-level + flight#)', async () => {
    const base = {
      tripId,
      personaId: uid,
      mode: 'flight' as const,
      origin: 'SEA',
      destination: 'JFK',
      carrier: 'United',
      flightNo: 'UA482',
      confirmation: 'ABC123',
    };
    await addTravelLeg(db, { ...base, departAt: '2026-06-12T09:05:00-04:00', arriveAt: '2026-06-12T17:20:00-04:00' });
    expect(await legCount()).toBe(1);

    // Re-upload: same flight + passenger + date, slightly different time format.
    const reupload = { ...base, departAt: '2026-06-12T09:05:00.000-04:00', arriveAt: '2026-06-12T17:20:00.000-04:00' };
    expect(await findExistingLeg(db, reupload)).not.toBeNull();
    await addTravelLeg(db, reupload);
    expect(await legCount()).toBe(1);
  });

  it('a burst of concurrent calls for the same leg creates one row, not two (ADR 0165 shape)', async () => {
    // Prod: two duplicate travel_legs rows per flight, ~4s apart, same
    // confirmation — a double-tap on a bundle-confirm card (or two
    // overlapping magics passes) let both calls' findExistingLeg SELECT run
    // before either INSERT committed. The advisory lock in addTravelLeg
    // serialises them the same way ADR 0155 did for list creation.
    const base = {
      tripId,
      mode: 'flight' as const,
      origin: 'LGA',
      destination: 'DEN',
      carrier: 'Southwest Airlines',
      flightNo: 'WN2909',
      confirmation: 'CJCGMG',
      departAt: '2026-06-12T20:55:00-05:00',
      arriveAt: '2026-06-12T23:30:00-07:00',
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => addTravelLeg(db, base)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await legCount()).toBe(1);
  });

  it('keeps a different passenger on the same flight', async () => {
    const other = await createUser(db, 'alice', 'Alice');
    const base = {
      tripId,
      mode: 'flight' as const,
      origin: 'SEA',
      destination: 'JFK',
      flightNo: 'UA482',
      confirmation: 'ABC123',
      departAt: '2026-06-12T09:05:00-04:00',
      arriveAt: '2026-06-12T17:20:00-04:00',
    };
    await addTravelLeg(db, { ...base, personaId: uid });
    await addTravelLeg(db, { ...base, personaId: other });
    expect(await legCount()).toBe(2);
  });

  it('does not duplicate an accommodation on re-upload', async () => {
    const base = {
      tripId,
      propertyName: 'Marriott Downtown',
      checkinDate: '2026-06-12',
      checkoutDate: '2026-06-15',
      confirmation: 'HX99821',
    };
    await addAccommodation(db, base);
    expect(await accomCount()).toBe(1);

    expect(await findExistingAccommodation(db, base)).not.toBeNull();
    // Re-upload with the same PNR but a differently-cased property name.
    await addAccommodation(db, { ...base, propertyName: 'marriott downtown' });
    expect(await accomCount()).toBe(1);
  });

  it('a burst of concurrent calls for the same stay creates one row, not two', async () => {
    const base = {
      tripId,
      propertyName: 'Residence Inn by Marriott Vail',
      checkinDate: '2026-06-12',
      checkoutDate: '2026-06-15',
      confirmation: 'ZO-AX1057-43807',
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => addAccommodation(db, base)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await accomCount()).toBe(1);
  });

  it('adds a genuinely different hotel', async () => {
    await addAccommodation(db, {
      tripId,
      propertyName: 'Marriott Downtown',
      checkinDate: '2026-06-12',
      checkoutDate: '2026-06-15',
      confirmation: 'HX99821',
    });
    await addAccommodation(db, {
      tripId,
      propertyName: 'Hilton Midtown',
      checkinDate: '2026-06-15',
      checkoutDate: '2026-06-18',
      confirmation: 'ZZ55',
    });
    expect(await accomCount()).toBe(2);
  });
});
