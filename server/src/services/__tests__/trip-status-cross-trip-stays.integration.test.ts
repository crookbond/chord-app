/**
 * A trip's status borrows stays from OTHER trips in its group that overlap its
 * nights (a hotel uploaded separately that made its own trip shell). A stay
 * nobody is keeping — on a soft-deleted trip (ADR 0171), a cancelled trip, or
 * itself cancelled (ADR 0168) — must not be borrowed: it would appear on the
 * live trip's card and cover nights that are in fact uncovered.
 *
 * Also pins that the batched Trips-tab path (listTripStatusesForUser/ForGroup)
 * returns exactly what the per-trip getTripStatus returns.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addAccommodation,
  addReservation,
  addTravelLeg,
  cancelAccommodation,
  createTrip,
  deleteTrip,
  getTripStatus,
  listTripStatusesForGroup,
  listTripStatusesForUser,
  maybeCancelTrip,
} from '@/services/trips.service.js';

describe('trip status: stays borrowed from other trips', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let uid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john', 'John');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    groupId = g.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function liveTripWithFlight() {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00',
    });
    return trip;
  }

  async function shellWithStay() {
    const shell = await createTrip(db, {
      groupId, createdBy: uid, name: 'Residence Inn Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const stay = await addAccommodation(db, {
      tripId: shell.id, propertyName: 'Residence Inn', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });
    return { shell, stay };
  }

  it('a stay on a live shell trip is borrowed and covers the nights (unchanged behaviour)', async () => {
    const trip = await liveTripWithFlight();
    await shellWithStay();
    const status = await getTripStatus(db, trip.id);
    expect(status!.accommodations.map((a) => a.propertyName)).toEqual(['Residence Inn']);
    expect(status!.gaps).toEqual([]);
  });

  it('a stay on a soft-deleted trip is not borrowed', async () => {
    const trip = await liveTripWithFlight();
    const { shell } = await shellWithStay();
    await deleteTrip(db, shell.id);

    const status = await getTripStatus(db, trip.id);
    expect(status!.accommodations).toEqual([]);
    expect(status!.gaps).toEqual([{ start: '2027-02-11', end: '2027-02-15' }]);

    const [fromList] = (await listTripStatusesForUser(db, uid)).filter((s) => s.trip.id === trip.id);
    expect(fromList!.accommodations).toEqual([]);
    expect(fromList!.gaps).toEqual([{ start: '2027-02-11', end: '2027-02-15' }]);
  });

  it('a cancelled stay (and so its cancelled shell trip) is not borrowed', async () => {
    const trip = await liveTripWithFlight();
    const { shell, stay } = await shellWithStay();
    await cancelAccommodation(db, stay.id);
    await maybeCancelTrip(db, shell.id);

    const status = await getTripStatus(db, trip.id);
    expect(status!.accommodations).toEqual([]);
    expect(status!.gaps).toEqual([{ start: '2027-02-11', end: '2027-02-15' }]);
  });

  it('a trip\'s own cancelled stay is still shown but does not cover its nights', async () => {
    const trip = await liveTripWithFlight();
    const own = await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Antlers', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });
    await cancelAccommodation(db, own.id);

    const status = await getTripStatus(db, trip.id);
    expect(status!.accommodations.map((a) => a.propertyName)).toEqual(['Antlers']);
    expect(status!.accommodations[0]!.cancelledAt).toBeTruthy();
    expect(status!.gaps).toEqual([{ start: '2027-02-11', end: '2027-02-15' }]);
  });

  it('the batched list returns the same statuses as per-trip getTripStatus, deleted trips included', async () => {
    const other = await createUser(db, 'alice', 'Alice');
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [uid, other],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00', personaId: uid,
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00', personaId: other,
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'DEN', destination: 'LGA',
      departAt: '2027-02-15T09:00:00-07:00', arriveAt: '2027-02-15T15:00:00-05:00', passengerName: 'Ben',
    });
    await addReservation(db, {
      tripId: trip.id, kind: 'restaurant', name: 'Sweet Basil', dateTime: '2027-02-12T19:00:00-07:00',
    });
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Antlers', checkinDate: '2027-02-11', checkoutDate: '2027-02-13',
    });
    const { shell } = await shellWithStay();
    const gone = await createTrip(db, {
      groupId, createdBy: uid, name: 'Old trip', destination: 'Paris',
      startDate: '2026-05-01', endDate: '2026-05-03', participantIds: [],
    });
    await deleteTrip(db, gone.id);

    const perTrip = await Promise.all([trip.id, shell.id, gone.id].map((id) => getTripStatus(db, id)));
    const byId = new Map(perTrip.map((s) => [s!.trip.id, s]));

    for (const list of [await listTripStatusesForUser(db, uid), await listTripStatusesForGroup(db, groupId)]) {
      expect(list.map((s) => s.trip.id).sort()).toEqual([trip.id, shell.id, gone.id].sort());
      for (const s of list) expect(s).toEqual(byId.get(s.trip.id));
    }
    const vail = byId.get(trip.id)!;
    expect(vail.participantNames.sort()).toEqual(['Alice', 'John']);
    expect(vail.reservations.map((r) => r.name)).toEqual(['Sweet Basil']);
    expect(vail.accommodations.map((a) => a.propertyName)).toEqual(['Antlers', 'Residence Inn']);
  });
});
