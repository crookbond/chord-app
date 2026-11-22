/**
 * A trip is soft-deleted (recoverable), never hard-removed by the user's own
 * "x". Removing a single leg/accommodation is a real delete, but empties the
 * trip into the same recoverable soft-delete once nothing is left on it.
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
  createTrip,
  deleteTrip,
  findTripByDateRange,
  getTrip,
  maybeDeleteEmptyTrip,
  removeAccommodation,
  removeTravelLeg,
  restoreTrip,
} from '@/services/trips.service.js';

describe('trip soft-delete + recovery', () => {
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

  it('deleteTrip soft-deletes: the row stays, deletedAt is set, and it is restorable', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });

    const deleted = await deleteTrip(db, trip.id);
    expect(deleted).toBe(true);

    const afterDelete = await getTrip(db, trip.id);
    expect(afterDelete).not.toBeNull();
    expect(afterDelete!.deletedAt).toBeTruthy();

    const restored = await restoreTrip(db, trip.id);
    expect(restored).toBe(true);

    const afterRestore = await getTrip(db, trip.id);
    expect(afterRestore!.deletedAt).toBeUndefined();
  });

  it('a deleted trip does not swallow a fresh rebooking for the same dates', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    await deleteTrip(db, trip.id);

    const match = await findTripByDateRange(db, uid, '2027-02-11', '2027-02-15', groupId);
    expect(match).toBeNull();
  });

  it('removing a cancelled leg is a real delete, and does not touch the trip while an accommodation remains', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00',
    });
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Residence Inn', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });

    const removed = await removeTravelLeg(db, leg.id);
    expect(removed).toBe(true);

    const tripDeleted = await maybeDeleteEmptyTrip(db, trip.id);
    expect(tripDeleted).toBe(false);
    expect((await getTrip(db, trip.id))!.deletedAt).toBeUndefined();
  });

  it('removing the last leg/accommodation soft-deletes the trip', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00',
    });
    const stay = await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Residence Inn', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });

    await removeTravelLeg(db, leg.id);
    expect(await maybeDeleteEmptyTrip(db, trip.id)).toBe(false); // accommodation still there

    await removeAccommodation(db, stay.id);
    expect(await maybeDeleteEmptyTrip(db, trip.id)).toBe(true); // now empty

    expect((await getTrip(db, trip.id))!.deletedAt).toBeTruthy();
  });

  it('a trip with only a reservation left does not auto-delete', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00',
    });
    await addReservation(db, {
      tripId: trip.id, kind: 'restaurant', name: 'Sweet Basil', dateTime: '2027-02-12T19:00:00-07:00',
    });

    await removeTravelLeg(db, leg.id);
    expect(await maybeDeleteEmptyTrip(db, trip.id)).toBe(false);
    expect((await getTrip(db, trip.id))!.deletedAt).toBeUndefined();
  });
});
