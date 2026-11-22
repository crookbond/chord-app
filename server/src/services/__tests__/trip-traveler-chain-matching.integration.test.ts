/**
 * ADR 0190 — a trip is grouped by who is traveling, chained by city through
 * their own other legs, never by shared date-range overlap. Built from a
 * real prod audit of ownertest@gmail.com's trips: a 5-hop Kenya safari that
 * split into 5 separate trips (no date overlap between single-day hops),
 * and a spouse's unrelated 3-day Amtrak trip that silently absorbed into an
 * in-law's 6-week visit (the Amtrak dates fell inside the visit's window).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  addTravelLeg,
  createTrip,
  findTripForStay,
  findTripForTraveler,
  getTripStatus,
} from '@/services/trips.service.js';

describe('findTripForTraveler', () => {
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

  it('a booking reference is a unique join: same reference, any traveler, any route, same trip', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to SFO', destination: 'SFO',
      startDate: '2027-03-01', endDate: '2027-03-01', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, passengerName: 'John Doe', mode: 'flight', origin: 'JFK', destination: 'SFO',
      departAt: '2027-03-01T08:00:00-05:00', arriveAt: '2027-03-01T11:00:00-08:00', confirmation: 'KX8QP2',
    });
    // Another traveler's leg, a route that connects to nothing, weeks later —
    // only the reference says it is the same booking.
    const match = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Alice Stone',
      legs: [{ origin: 'BOS', destination: 'LAX', departAt: '2027-03-20T09:00:00-05:00', arriveAt: '2027-03-20T12:00:00-08:00' }],
      confirmation: 'kx8qp2',
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
    // A placeholder reference joins nothing.
    const none = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Alice Stone',
      legs: [{ origin: 'BOS', destination: 'LAX', departAt: '2027-03-20T09:00:00-05:00', arriveAt: '2027-03-20T12:00:00-08:00' }],
      confirmation: 'N/A',
      preferGroupId: groupId,
    });
    expect(none).toBeNull();
  });

  it('chains a multi-hop safari for the same traveler across non-overlapping single-day legs', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Doha', destination: 'DOH',
      startDate: '2026-08-01', endDate: '2026-08-02', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'JFK', destination: 'DOH',
      departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'DOH', destination: 'NBO',
      departAt: '2026-08-02T18:45:00+03:00', arriveAt: '2026-08-02T23:50:00+03:00',
    });

    // Next hop of the same safari, days later, arrives as its own document —
    // no date overlap with the existing trip's window at all.
    const match = await findTripForTraveler(db, {
      userId: uid,
      personaId: uid,
      legs: [{
        origin: 'Nairobi-Wilson', destination: 'Mara-Keekorok',
        departAt: '2026-08-03T10:30:00+03:00', arriveAt: '2026-08-03T11:10:00+03:00',
      }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('chains across airports in the same metro (Chicago Midway vs O\'Hare)', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Ben to Chicago', destination: 'MDW',
      startDate: '2026-09-24', endDate: '2026-09-24', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, passengerName: 'Ben Doe', mode: 'flight', origin: 'LGA', destination: 'MDW',
      departAt: '2026-09-24T15:25:00-04:00', arriveAt: '2026-09-24T16:55:00-05:00',
    });

    const match = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Ben Doe',
      legs: [{
        origin: 'ORD', destination: 'LGA',
        departAt: '2026-11-20T20:20:00-06:00', arriveAt: '2026-11-20T23:40:00-05:00',
      }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('chains on an exact place name even when neither side is in the airport-metro table', async () => {
    // Real safari airstrips (Mara-Keekorok, Amboseli) have no metro table
    // entry at all — the literal printed name is the only signal available,
    // and it's the same name on both sides of the seam.
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Mara-Keekorok', destination: 'Mara-Keekorok',
      startDate: '2026-08-03', endDate: '2026-08-03', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'Nairobi-Wilson', destination: 'Mara-Keekorok',
      departAt: '2026-08-03T10:30:00+03:00', arriveAt: '2026-08-03T11:10:00+03:00',
    });

    const match = await findTripForTraveler(db, {
      userId: uid,
      personaId: uid,
      legs: [{
        origin: 'Mara-Keekorok', destination: 'Amboseli',
        departAt: '2026-08-06T11:30:00+03:00', arriveAt: '2026-08-06T12:30:00+03:00',
      }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('never merges a different traveler\'s trip just because the dates overlap', async () => {
    // A 6-week in-law visit — the trip a long window swallows things into.
    const visit = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Washington, DC', destination: 'EWR',
      startDate: '2026-10-12', endDate: '2026-11-26', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: visit.id, passengerName: 'Simon Stone', mode: 'flight', origin: 'DEL', destination: 'EWR',
      departAt: '2026-10-12T01:50:00+05:30', arriveAt: '2026-10-12T09:00:00-04:00',
    });

    // The spouse's unrelated Amtrak weekend, dates fully inside the visit's
    // window, but a different traveler with nothing connecting her to it.
    const match = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Alice Stone',
      legs: [{
        origin: 'New York, NY', destination: 'Washington, DC',
        departAt: '2026-10-21T08:05:00-04:00', arriveAt: '2026-10-21T11:33:00-04:00',
      }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });

  it('never merges when the city genuinely does not connect', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Denver', destination: 'DEN',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2026-02-11T20:55:00-05:00', arriveAt: '2026-02-11T23:30:00-07:00',
    });

    const match = await findTripForTraveler(db, {
      userId: uid,
      personaId: uid,
      legs: [{
        origin: 'MIA', destination: 'LAX',
        departAt: '2026-02-16T09:00:00-05:00', arriveAt: '2026-02-16T12:00:00-08:00',
      }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });

  it('a companion on the very same flight joins that trip — no name match needed', async () => {
    // The real family flight: John's JFK→DOH already filed; Ben (a raw
    // name with no account) is on the same flight, uploaded separately.
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to DOH', destination: 'DOH',
      startDate: '2026-08-01', endDate: '2026-08-02', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'JFK', destination: 'DOH',
      departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
    });

    const match = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Ben',
      legs: [{
        origin: 'JFK', destination: 'DOH',
        departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
      }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('a ticket that names nobody still joins the trip its flight is already on', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to DOH', destination: 'DOH',
      startDate: '2026-08-01', endDate: '2026-08-02', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'JFK', destination: 'DOH',
      departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
    });
    const match = await findTripForTraveler(db, {
      userId: uid,
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: '2026-08-01T22:00:00-04:00' }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('a different day on the same route is a different flight, not a companion', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to DOH', destination: 'DOH',
      startDate: '2026-08-01', endDate: '2026-08-02', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'JFK', destination: 'DOH',
      departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
    });
    const match = await findTripForTraveler(db, {
      userId: uid,
      passengerName: 'Someone Else',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: '2026-11-01T22:00:00-04:00' }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });

  it('never reopens a finished round trip for the next one out of the same city', async () => {
    // LGA→DEN, DEN→LGA is a closed loop; a fresh LGA→LAX is a new trip even
    // though it leaves from where the last one ended.
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Denver', destination: 'DEN',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid, mode: 'flight', origin: 'DEN', destination: 'LGA',
      departAt: '2027-02-15T17:50:00-07:00', arriveAt: '2027-02-15T23:25:00-05:00',
    });
    const match = await findTripForTraveler(db, {
      userId: uid,
      personaId: uid,
      legs: [{ origin: 'LGA', destination: 'LAX', departAt: '2027-02-20T09:00:00-05:00' }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });

  it('returns null when no traveler identity is given and no empty trip is waiting', async () => {
    const match = await findTripForTraveler(db, {
      userId: uid,
      legs: [{ origin: 'LGA', destination: 'DEN', departAt: '2026-02-11T09:00:00-05:00' }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });

  it('matches a legless trip shell by date+group when no traveler is named', async () => {
    // "create a trip to Austin" then a bare "flying ORD→AUS" with no name —
    // nobody's travel is on this trip yet, so there's nothing to misattribute.
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Austin SXSW', destination: 'Austin',
      startDate: '2027-03-07', endDate: '2027-03-15', participantIds: [],
    });
    const match = await findTripForTraveler(db, {
      userId: uid,
      legs: [{
        origin: 'ORD', destination: 'AUS',
        departAt: '2027-03-07T10:00:00+00:00', arriveAt: '2027-03-07T12:30:00+00:00',
      }],
      preferGroupId: groupId,
    });
    expect(match?.id).toBe(trip.id);
  });

  it('never uses the empty-trip fallback once someone else has legs on it', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Washington, DC', destination: 'EWR',
      startDate: '2026-10-12', endDate: '2026-11-26', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, passengerName: 'Simon Stone', mode: 'flight', origin: 'DEL', destination: 'EWR',
      departAt: '2026-10-12T01:50:00+05:30', arriveAt: '2026-10-12T09:00:00-04:00',
    });

    const match = await findTripForTraveler(db, {
      userId: uid,
      legs: [{
        origin: 'New York, NY', destination: 'Washington, DC',
        departAt: '2026-10-21T08:05:00-04:00', arriveAt: '2026-10-21T11:33:00-04:00',
      }],
      preferGroupId: groupId,
    });
    expect(match).toBeNull();
  });
});

describe('findTripForStay', () => {
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

  it('matches an existing trip by the city its legs fly into, not its own free-text destination', async () => {
    // Mirrors the real "Trip to LIS" shape: trip.destination is stale text
    // (here the ORIGIN airport, exactly like the prod row), but its legs
    // land in the right place.
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Denver', destination: 'EWR',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'EWR', destination: 'DEN',
      departAt: '2026-02-11T09:00:00-05:00', arriveAt: '2026-02-11T12:00:00-07:00',
    });

    const match = await findTripForStay(db, { userId: uid, groupId, city: 'Denver', checkinDate: '2026-02-11', checkoutDate: '2026-02-15' });
    expect(match?.id).toBe(trip.id);
  });

  it('never matches a trip in a different city', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Denver', destination: 'Denver, CO',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });
    const match = await findTripForStay(db, { userId: uid, groupId, city: 'Chicago', checkinDate: '2026-02-11', checkoutDate: '2026-02-15' });
    expect(match).not.toBe(trip.id);
    expect(match).toBeNull();
  });

  it('same city a year apart is two trips: a 2027 Vail stay never attaches to the 2026 Vail trip', async () => {
    // Real prod shape (ownertest): "Ever Green Lodge at Vail, Feb 11-15 2026"
    // typed in chat, then a Booking.com rebooking for Feb 11-15 2027 — same
    // group, same city, same days of the year.
    const t2026 = await createTrip(db, {
      groupId, createdBy: uid, name: 'Trip to Vail', destination: 'Vail, CO',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });
    const same = await findTripForStay(db, { userId: uid, groupId, city: 'Vail', checkinDate: '2026-02-12', checkoutDate: '2026-02-14' });
    expect(same?.id).toBe(t2026.id);
    const later = await findTripForStay(db, { userId: uid, groupId, city: 'Vail', checkinDate: '2027-02-11', checkoutDate: '2027-02-15' });
    expect(later).toBeNull();
  });

  it('among same-city trips, the one the stay actually overlaps wins, not the earliest', async () => {
    await createTrip(db, {
      groupId, createdBy: uid, name: 'Vail 2026', destination: 'Vail, CO',
      startDate: '2026-02-11', endDate: '2026-02-15', participantIds: [],
    });
    const t2027 = await createTrip(db, {
      groupId, createdBy: uid, name: 'Vail 2027', destination: 'Vail, CO',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const m = await findTripForStay(db, { userId: uid, groupId, city: 'Vail', checkinDate: '2027-02-11', checkoutDate: '2027-02-15' });
    expect(m?.id).toBe(t2027.id);
  });
});

describe('add_travel_leg tool — traveler-driven grouping', () => {
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

  it('refuses and asks rather than guessing a trip when no traveler is named', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          mode: 'flight', origin: 'LGA', destination: 'DEN',
          departAt: '2026-02-11T09:00:00-05:00', arriveAt: '2026-02-11T12:00:00-07:00',
        },
      },
    });
    expect(result.data).toMatchObject({ created: false, reason: 'needs_passenger' });
    const legs = await db.selectFrom('travel_legs').selectAll().execute();
    expect(legs.length, 'hint: no leg should be written without a traveler').toBe(0);
  });

  it('chains a same-traveler continuation onto the existing trip instead of minting a new one', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          personaName: 'John', mode: 'flight', origin: 'JFK', destination: 'DOH',
          departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00',
        },
      },
    });
    await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          personaName: 'John', mode: 'flight', origin: 'DOH', destination: 'NBO',
          departAt: '2026-08-02T18:45:00+03:00', arriveAt: '2026-08-02T23:50:00+03:00',
        },
      },
    });
    const trips = await db.selectFrom('trips').selectAll().where('group_id', '=', groupId).execute();
    expect(trips.length, 'hint: the second leg should continue the first trip, not start a new one').toBe(1);
  });

  it('surfaces an uncovered night as a nudge, not an error, right when a leg makes one visible', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          personaName: 'John', mode: 'flight', origin: 'LGA', destination: 'DEN',
          departAt: '2027-02-11T09:00:00-05:00', arriveAt: '2027-02-11T12:00:00-07:00',
        },
      },
    });
    // The return leg, days later — nothing on file for the nights between.
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          personaName: 'John', mode: 'flight', origin: 'DEN', destination: 'LGA',
          departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
        },
      },
    });
    expect(result.summary).toMatch(/no stay on file/);

    const trip = await db.selectFrom('trips').selectAll().where('group_id', '=', groupId).executeTakeFirstOrThrow();
    const status = await getTripStatus(db, trip.id);
    expect(status!.gaps.length).toBeGreaterThan(0);
  });
});
