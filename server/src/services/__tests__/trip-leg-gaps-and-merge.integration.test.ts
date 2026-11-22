/**
 * Two new get_trip_status capabilities: flagging a real break between
 * consecutive legs (metro-matched, not exact-string-matched — see
 * airport-metro.test.ts), and mergeTrips, the Trips-tab drag-to-combine
 * action that folds one trip's legs/accommodations/reservations into
 * another.
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
  getTrip,
  getTripStatus,
  mergeTrips,
  moveAccommodation,
  moveTravelLeg,
  undoMergeTrips,
} from '@/services/trips.service.js';

describe('trip leg-gap detection', () => {
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
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail, CO',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    tripId = trip.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('does not flag a round trip that departs and returns via different NYC airports', async () => {
    await addTravelLeg(db, {
      tripId, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });
    await addTravelLeg(db, {
      tripId, mode: 'flight', origin: 'DEN', destination: 'JFK',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });
    const status = await getTripStatus(db, tripId);
    expect(status!.legGaps).toEqual([]);
  });

  it('flags a real break between two different, unconnected airports', async () => {
    const outbound = await addTravelLeg(db, {
      tripId, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });
    await addTravelLeg(db, {
      tripId, mode: 'flight', origin: 'EGE', destination: 'JFK',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });
    const status = await getTripStatus(db, tripId);
    expect(status!.legGaps).toEqual([
      { afterLegId: outbound.id, passengerName: undefined, arrivedAt: 'DEN', departingFrom: 'EGE' },
    ]);
  });

  it('never flags a pair where either endpoint is unrecognized', async () => {
    await addTravelLeg(db, {
      tripId, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });
    await addTravelLeg(db, {
      tripId, mode: 'car', origin: 'Grandma\'s cabin', destination: 'JFK',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });
    const status = await getTripStatus(db, tripId);
    expect(status!.legGaps).toEqual([]);
  });

  it('checks each passenger\'s own sequence, never cross-passenger', async () => {
    const other = await createUser(db, 'alice', 'Alice');
    // John: LGA -> DEN -> LGA (fine). Alice: SEA -> DEN (own sequence,
    // unrelated to John's origin) — a naive single chronological list would
    // wrongly compare John's DEN arrival against Alice's SEA departure.
    await addTravelLeg(db, {
      tripId, personaId: uid, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });
    await addTravelLeg(db, {
      tripId, personaId: uid, mode: 'flight', origin: 'DEN', destination: 'LGA',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });
    await addTravelLeg(db, {
      tripId, personaId: other, mode: 'flight', origin: 'SEA', destination: 'DEN',
      departAt: '2027-02-12T09:00:00-08:00', arriveAt: '2027-02-12T12:00:00-07:00',
    });
    const status = await getTripStatus(db, tripId);
    expect(status!.legGaps).toEqual([]);
  });
});

describe('mergeTrips', () => {
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

  it('folds legs/accommodations into the keeper, unions the date range, and soft-deletes the source', async () => {
    const keep = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-13', participantIds: [],
    });
    const merge = await createTrip(db, {
      groupId, createdBy: uid, name: 'Vail - LGA', destination: 'Vail',
      startDate: '2027-02-13', endDate: '2027-02-15', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: keep.id, propertyName: 'Slope House', checkinDate: '2027-02-11', checkoutDate: '2027-02-13',
    });
    await addTravelLeg(db, {
      tripId: merge.id, mode: 'flight', origin: 'DEN', destination: 'LGA',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });

    const result = await mergeTrips(db, groupId, keep.id, merge.id);

    expect(result).not.toBeNull();
    expect(result!.status.trip.startDate).toBe('2027-02-11');
    expect(result!.status.trip.endDate).toBe('2027-02-15');
    expect(result!.status.accommodations).toHaveLength(1);
    expect(result!.status.legs).toHaveLength(1);
    expect(result!.status.legs[0]!.tripId).toBe(keep.id);
    // The source trip is soft-deleted, not gone.
    expect(result!.mergedTripId).toBe(merge.id);

    // A night not covered by the (now-single) accommodation shows up as a gap.
    expect(result!.status.gaps).toEqual([{ start: '2027-02-13', end: '2027-02-15' }]);
  });

  it('rejects merging a trip into itself', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    await expect(mergeTrips(db, groupId, trip.id, trip.id)).rejects.toThrow();
  });

  it('returns null for a trip outside the given group', async () => {
    const otherGroup = await createGroup(db, { name: 'Other', kind: 'group', createdBy: uid });
    const keep = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const elsewhere = await createTrip(db, {
      groupId: otherGroup.id, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-05', participantIds: [],
    });
    const result = await mergeTrips(db, groupId, keep.id, elsewhere.id);
    expect(result).toBeNull();
  });
});

describe('undoMergeTrips', () => {
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

  it('reverses a mis-drop: moves the rows back, restores the source, and resets the keeper\'s date range', async () => {
    const keep = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-13', participantIds: [],
    });
    const merge = await createTrip(db, {
      groupId, createdBy: uid, name: 'Vail - LGA', destination: 'Vail',
      startDate: '2027-02-13', endDate: '2027-02-15', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: keep.id, propertyName: 'Slope House', checkinDate: '2027-02-11', checkoutDate: '2027-02-13',
    });
    const leg = await addTravelLeg(db, {
      tripId: merge.id, mode: 'flight', origin: 'DEN', destination: 'LGA',
      departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
    });

    // Capture exactly what the mobile "Undo" toast would capture before merging.
    const undoPayload = {
      keepTripId: keep.id,
      mergeTripId: merge.id,
      legIds: [leg.id],
      accommodationIds: [] as string[],
      reservationIds: [] as string[],
      keepStartDate: keep.startDate,
      keepEndDate: keep.endDate,
    };
    const merged = await mergeTrips(db, groupId, keep.id, merge.id);
    expect(merged).not.toBeNull();
    expect(merged!.status.legs).toHaveLength(1);

    const undone = await undoMergeTrips(db, groupId, undoPayload);

    expect(undone).not.toBeNull();
    // The keeper is back to its own accommodation and its original dates.
    expect(undone!.keep.legs).toHaveLength(0);
    expect(undone!.keep.accommodations).toHaveLength(1);
    expect(undone!.keep.trip.startDate).toBe('2027-02-11');
    expect(undone!.keep.trip.endDate).toBe('2027-02-13');
    // The source trip is restored with its leg back on it.
    expect(undone!.restored.trip.deletedAt).toBeUndefined();
    expect(undone!.restored.legs).toHaveLength(1);
    expect(undone!.restored.legs[0]!.id).toBe(leg.id);
  });

  it('returns null when either trip is outside the given group', async () => {
    const otherGroup = await createGroup(db, { name: 'Other', kind: 'group', createdBy: uid });
    const keep = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const elsewhere = await createTrip(db, {
      groupId: otherGroup.id, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-05', participantIds: [],
    });
    const result = await undoMergeTrips(db, groupId, {
      keepTripId: keep.id, mergeTripId: elsewhere.id,
      legIds: [], accommodationIds: [], reservationIds: [],
      keepStartDate: keep.startDate, keepEndDate: keep.endDate,
    });
    expect(result).toBeNull();
  });

  it('skips an id that does not actually belong to the keeper, rather than moving it from wherever it now lives', async () => {
    const keep = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const merge = await createTrip(db, {
      groupId, createdBy: uid, name: 'Vail - LGA', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    // A leg on a THIRD trip, unrelated to either side of this undo — a stale
    // or mistaken payload naming it must not yank it off wherever it really is.
    const somewhereElse = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-05', participantIds: [],
    });
    const unrelated = await addTravelLeg(db, {
      tripId: somewhereElse.id, mode: 'flight', origin: 'JFK', destination: 'NRT',
      departAt: '2027-03-01T00:30:00-05:00', arriveAt: '2027-03-02T04:30:00+09:00',
    });

    const undone = await undoMergeTrips(db, groupId, {
      keepTripId: keep.id, mergeTripId: merge.id,
      legIds: [unrelated.id], accommodationIds: [], reservationIds: [],
      keepStartDate: keep.startDate, keepEndDate: keep.endDate,
    });

    expect(undone).not.toBeNull();
    expect(undone!.keep.legs).toHaveLength(0);
    const stillThere = await getTripStatus(db, somewhereElse.id);
    expect(stillThere!.legs.map((l) => l.id)).toEqual([unrelated.id]);
  });
});

describe('moveTravelLeg', () => {
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

  it('re-parents a single leg onto a different trip and widens the target date range', async () => {
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-05-01', endDate: '2027-05-10', participantIds: [],
    });
    const target = await createTrip(db, {
      groupId, createdBy: uid, name: 'Onward to London', destination: 'London',
      startDate: '2027-05-06', endDate: '2027-05-09', participantIds: [],
    });
    // Source keeps an accommodation so it stays alive after the leg moves
    // out — isolates the date-widening behavior from the empty-trip fold
    // covered by the dedicated tests below.
    await addAccommodation(db, {
      tripId: source.id, propertyName: 'Delhi hotel', checkinDate: '2027-05-01', checkoutDate: '2027-05-06',
    });
    // A return leg that lands OUTSIDE the target's current window on both
    // ends, so the widening logic has to move both start and end.
    const leg = await addTravelLeg(db, {
      tripId: source.id, mode: 'flight', origin: 'LHR', destination: 'JFK',
      departAt: '2027-05-10T11:00:00+01:00', arriveAt: '2027-05-10T14:00:00-04:00',
    });

    const result = await moveTravelLeg(db, groupId, leg.id, target.id);

    expect(result).not.toBeNull();
    expect(result!.sourceTripDeleted).toBe(false);
    expect(result!.leg.tripId).toBe(target.id);

    const sourceStatus = await getTripStatus(db, source.id);
    expect(sourceStatus!.legs).toHaveLength(0);
    const targetStatus = await getTripStatus(db, target.id);
    expect(targetStatus!.legs).toHaveLength(1);
    expect(targetStatus!.legs[0]!.id).toBe(leg.id);
    // Widened to cover the moved leg's departure date, same as addTravelLeg.
    expect(targetStatus!.trip.endDate).toBe('2027-05-10');
    expect(targetStatus!.trip.startDate).toBe('2027-05-06');
  });

  it('folds the source trip away once its last leg moves out', async () => {
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const target = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Tahoe', destination: 'Tahoe',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: source.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });

    const result = await moveTravelLeg(db, groupId, leg.id, target.id);

    expect(result!.sourceTripDeleted).toBe(true);
    const sourceTrip = await getTrip(db, source.id);
    expect(sourceTrip!.deletedAt).toBeTruthy();
  });

  it('leaves the source trip alone when it still has other items', async () => {
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-05-01', endDate: '2027-05-10', participantIds: [],
    });
    const target = await createTrip(db, {
      groupId, createdBy: uid, name: 'Onward to London', destination: 'London',
      startDate: '2027-05-06', endDate: '2027-05-09', participantIds: [],
    });
    const stay = await addAccommodation(db, {
      tripId: source.id, propertyName: 'Delhi hotel', checkinDate: '2027-05-01', checkoutDate: '2027-05-06',
    });
    const leg = await addTravelLeg(db, {
      tripId: source.id, mode: 'flight', origin: 'DEL', destination: 'LHR',
      departAt: '2027-05-06T09:00:00+05:30', arriveAt: '2027-05-06T13:00:00+01:00',
    });

    const result = await moveTravelLeg(db, groupId, leg.id, target.id);

    expect(result!.sourceTripDeleted).toBe(false);
    const sourceTrip = await getTrip(db, source.id);
    expect(sourceTrip!.deletedAt).toBeFalsy();
    const sourceStatus = await getTripStatus(db, source.id);
    expect(sourceStatus!.accommodations.map((a) => a.id)).toEqual([stay.id]);
  });

  it('returns null when the leg or the target trip is outside the given group', async () => {
    const otherGroup = await createGroup(db, { name: 'Other', kind: 'group', createdBy: uid });
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const elsewhere = await createTrip(db, {
      groupId: otherGroup.id, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-05', participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: source.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
    });

    // Target trip belongs to a different group than `groupId`.
    expect(await moveTravelLeg(db, groupId, leg.id, elsewhere.id)).toBeNull();
    // Leg's own trip belongs to a different group than the one passed in.
    expect(await moveTravelLeg(db, otherGroup.id, leg.id, elsewhere.id)).toBeNull();
  });
});

describe('moveAccommodation', () => {
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

  it('re-parents a single stay onto a different trip and widens the target date range', async () => {
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-05-01', endDate: '2027-05-10', participantIds: [],
    });
    const target = await createTrip(db, {
      groupId, createdBy: uid, name: 'Onward to London', destination: 'London',
      startDate: '2027-05-06', endDate: '2027-05-09', participantIds: [],
    });
    // Source keeps a leg so it stays alive after the stay moves out —
    // isolates the date-widening behavior from the empty-trip fold covered
    // by the dedicated test below.
    await addTravelLeg(db, {
      tripId: source.id, mode: 'flight', origin: 'JFK', destination: 'DEL',
      departAt: '2027-05-01T20:00:00-04:00', arriveAt: '2027-05-02T22:00:00+05:30',
    });
    const stay = await addAccommodation(db, {
      tripId: source.id, propertyName: 'The Savoy', checkinDate: '2027-05-06', checkoutDate: '2027-05-10',
    });

    const result = await moveAccommodation(db, groupId, stay.id, target.id);

    expect(result).not.toBeNull();
    expect(result!.sourceTripDeleted).toBe(false);
    expect(result!.accommodation.tripId).toBe(target.id);
    const targetStatus = await getTripStatus(db, target.id);
    expect(targetStatus!.accommodations.map((a) => a.id)).toEqual([stay.id]);
    // Widened past its old end date to cover the moved stay's checkout.
    expect(targetStatus!.trip.endDate).toBe('2027-05-10');
  });

  it('folds the source trip away once its last item moves out', async () => {
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Hotel-only trip', destination: 'London',
      startDate: '2027-05-06', endDate: '2027-05-10', participantIds: [],
    });
    const target = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-05-01', endDate: '2027-05-06', participantIds: [],
    });
    const stay = await addAccommodation(db, {
      tripId: source.id, propertyName: 'The Savoy', checkinDate: '2027-05-06', checkoutDate: '2027-05-10',
    });

    const result = await moveAccommodation(db, groupId, stay.id, target.id);

    expect(result!.sourceTripDeleted).toBe(true);
    const sourceTrip = await getTrip(db, source.id);
    expect(sourceTrip!.deletedAt).toBeTruthy();
  });

  it('returns null when the stay or the target trip is outside the given group', async () => {
    const otherGroup = await createGroup(db, { name: 'Other', kind: 'group', createdBy: uid });
    const source = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const elsewhere = await createTrip(db, {
      groupId: otherGroup.id, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-05', participantIds: [],
    });
    const stay = await addAccommodation(db, {
      tripId: source.id, propertyName: 'Slope House', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });

    expect(await moveAccommodation(db, groupId, stay.id, elsewhere.id)).toBeNull();
    expect(await moveAccommodation(db, otherGroup.id, stay.id, elsewhere.id)).toBeNull();
  });
});

describe('real-shaped itineraries: multi-leg trips, partial hotels, and merging a separately-booked stay', () => {
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

  it('NYC-Tokyo round trip: a hotel covering only part of the stay surfaces the missing nights', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Tokyo', destination: 'Tokyo',
      startDate: '2027-03-01', endDate: '2027-03-06', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'NRT',
      departAt: '2027-03-01T00:30:00-05:00', arriveAt: '2027-03-02T04:30:00+09:00',
    });
    // Returns via HND, not NRT — same Tokyo metro, so this must never read as
    // a broken connection (the whole reason airport-metro.ts exists).
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'HND', destination: 'JFK',
      departAt: '2027-03-06T17:00:00+09:00', arriveAt: '2027-03-06T16:00:00-05:00',
    });
    // Hotel only covers the middle two nights of a five-night trip.
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Park Hyatt Tokyo', checkinDate: '2027-03-02', checkoutDate: '2027-03-04',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.gaps).toEqual([
      { start: '2027-03-01', end: '2027-03-02' },
      { start: '2027-03-04', end: '2027-03-06' },
    ]);
    expect(status!.legGaps).toEqual([]);
  });

  it('NYC-DEL-LHR multi-city trip: merging a separately-booked London hotel fills part of the gap and reports what still needs one', async () => {
    const multiCity = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-04-10', endDate: '2027-04-18', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: multiCity.id, mode: 'flight', origin: 'JFK', destination: 'DEL',
      departAt: '2027-04-10T20:00:00-04:00', arriveAt: '2027-04-11T22:00:00+05:30',
    });
    await addTravelLeg(db, {
      tripId: multiCity.id, mode: 'flight', origin: 'DEL', destination: 'LHR',
      departAt: '2027-04-14T09:00:00+05:30', arriveAt: '2027-04-14T13:00:00+01:00',
    });
    await addTravelLeg(db, {
      tripId: multiCity.id, mode: 'flight', origin: 'LHR', destination: 'JFK',
      departAt: '2027-04-18T11:00:00+01:00', arriveAt: '2027-04-18T14:00:00-04:00',
    });

    // The London hotel was booked separately and auto-filed under its own
    // trip — the exact shape ADR 0173 names as the ordinary case for
    // independently-arriving flight and hotel confirmations.
    const hotelOnly = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to London', destination: 'London',
      startDate: '2027-04-14', endDate: '2027-04-18', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: hotelOnly.id, propertyName: 'The Savoy', checkinDate: '2027-04-14', checkoutDate: '2027-04-18',
    });

    // Before merging: getTripStatus already pulls in an overlapping
    // accommodation from another trip in the same group (the cross-trip
    // fallback getTripStatus has always had, for exactly this "hotel landed
    // in its own trip shell" case) — so the London nights already read as
    // covered even before the merge. What the merge actually buys is the
    // Savoy stay showing up as ONE trip's own accommodation (and the two
    // trips collapsing into one card) rather than a display quirk.
    const before = await getTripStatus(db, multiCity.id);
    expect(before!.gaps).toEqual([{ start: '2027-04-10', end: '2027-04-14' }]);

    // This is the exact check the Trips-tab drag-to-combine gesture runs
    // right after the merge completes.
    const result = await mergeTrips(db, groupId, multiCity.id, hotelOnly.id);
    expect(result).not.toBeNull();
    expect(result!.status.accommodations).toHaveLength(1);
    expect(result!.status.accommodations[0]!.propertyName).toBe('The Savoy');
    expect(result!.status.legs).toHaveLength(3);
    // Delhi nights (10th-14th) still need a hotel; the merged-in Savoy stay
    // covers the London leg (14th-18th).
    expect(result!.status.gaps).toEqual([{ start: '2027-04-10', end: '2027-04-14' }]);
    // DEL -> LHR connects cleanly; merging in a hotel-only trip doesn't
    // invent a leg gap that wasn't there.
    expect(result!.status.legGaps).toEqual([]);
  });

  it('merging in a mismatched onward flight surfaces a leg gap alongside the remaining accommodation gaps', async () => {
    const main = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Delhi', destination: 'Delhi',
      startDate: '2027-05-01', endDate: '2027-05-10', participantIds: [],
    });
    const firstLeg = await addTravelLeg(db, {
      tripId: main.id, mode: 'flight', origin: 'JFK', destination: 'DEL',
      departAt: '2027-05-01T20:00:00-04:00', arriveAt: '2027-05-02T22:00:00+05:30',
    });

    const onward = await createTrip(db, {
      groupId, createdBy: uid, name: 'Onward to London', destination: 'London',
      startDate: '2027-05-06', endDate: '2027-05-10', participantIds: [],
    });
    // Booked from Mumbai, not Delhi — a real, unbridged gap once combined.
    await addTravelLeg(db, {
      tripId: onward.id, mode: 'flight', origin: 'BOM', destination: 'LHR',
      departAt: '2027-05-06T02:00:00+05:30', arriveAt: '2027-05-06T07:00:00+01:00',
    });
    await addAccommodation(db, {
      tripId: onward.id, propertyName: 'The Savoy', checkinDate: '2027-05-06', checkoutDate: '2027-05-09',
    });

    const result = await mergeTrips(db, groupId, main.id, onward.id);
    expect(result).not.toBeNull();
    expect(result!.status.legGaps).toEqual([
      { afterLegId: firstLeg.id, passengerName: undefined, arrivedAt: 'DEL', departingFrom: 'BOM' },
    ]);
    // Nights before the Savoy check-in (2nd-6th) and after checkout (9th-10th)
    // are still uncovered.
    expect(result!.status.gaps).toEqual([
      { start: '2027-05-01', end: '2027-05-06' },
      { start: '2027-05-09', end: '2027-05-10' },
    ]);
  });

  it('NY-Addis Ababa-Cairo-Alexandria: an unrecorded Cairo-to-Alexandria connection surfaces as a leg gap, and the two open nights (the overnight flight out, the last night before an unrecorded flight home) surface as accommodation gaps', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Addis Ababa', destination: 'Addis Ababa',
      startDate: '2027-08-01', endDate: '2027-08-11', participantIds: [],
    });
    const outbound = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'ADD',
      departAt: '2027-08-01T20:00:00-04:00', arriveAt: '2027-08-02T16:30:00+03:00',
    });
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Addis Ababa hotel', checkinDate: '2027-08-02', checkoutDate: '2027-08-04',
    });
    const toCairo = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'ADD', destination: 'CAI',
      departAt: '2027-08-04T09:00:00+03:00', arriveAt: '2027-08-04T11:00:00+02:00',
    });
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Cairo hotel', checkinDate: '2027-08-04', checkoutDate: '2027-08-08',
    });
    // No recorded leg from Cairo to Alexandria — the traveller's own itinerary
    // never named one (train/car, most likely), which is exactly the gap
    // this test exists to surface.
    await addAccommodation(db, {
      tripId: trip.id, propertyName: 'Alexandria hotel', checkinDate: '2027-08-08', checkoutDate: '2027-08-10',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'HBE', destination: 'ADD',
      departAt: '2027-08-10T14:00:00+02:00', arriveAt: '2027-08-10T19:00:00+03:00',
    });

    const status = await getTripStatus(db, trip.id);

    // The night of the overnight flight out (1st-2nd) and the last night back
    // in Addis Ababa with no recorded flight home (10th-11th) are uncovered.
    expect(status!.gaps).toEqual([
      { start: '2027-08-01', end: '2027-08-02' },
      { start: '2027-08-10', end: '2027-08-11' },
    ]);
    // Cairo (CAI) and Alexandria (HBE) are different metros — arriving CAI
    // then departing HBE with nothing recorded in between is a real break.
    expect(status!.legGaps).toEqual([
      { afterLegId: toCairo.id, passengerName: undefined, arrivedAt: 'CAI', departingFrom: 'HBE' },
    ]);
    // The outbound leg and the Addis-to-Cairo leg connect cleanly (JFK->ADD
    // then ADD->CAI): confirms the outbound leg itself isn't miscounted.
    expect(outbound.destination).toBe('ADD');
  });
});
