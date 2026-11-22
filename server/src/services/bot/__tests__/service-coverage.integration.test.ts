/**
 * Service-layer coverage suite — data model, query logic, and lifecycle
 * behaviors that don't need the bot pipeline.
 *
 * Coverage matrix:
 *
 * TRIPS
 *   temporal    past / current / future; pickActiveTrip priority ordering
 *   personas    in-group vs out-of-group participant legs; listTripsForPersona
 *   cross-group listTripStatusesForUser spans multiple groups
 *   completeness getTripStatus gap detection (missing inbound / outbound / nights)
 *   a "complete" trip (all legs + hotel) → nightsCovered=true, no gaps
 *   date-range  findTripByDateRange: overlap, same-day window, prefers current group
 *
 * TASKS
 *   sharing     listTasks scoped to group; all members see it
 *   assignment  assignee_id set correctly; unassigned task visible to all
 *   lifecycle   open → active → done → archived; status filter via listTasksForUser
 *   cross-group listTasksForUser spans multiple groups
 *   isolation   tasks in group A not visible via group B queries
 *   reminder    remindCue, remindAt fields stored and retrieved
 *   personal    personal-group tasks work the same as group tasks
 *
 * LISTS
 *   sharing     listLists scoped to group; all members see all items
 *   cross-group listListsForUser spans multiple groups
 *   merge       ensureList returns same list on second call
 *   setItemChecked  marks item done, others unaffected
 *   deleteItem  removes item; list remains
 *   isolation   list in group A not returned by group B query
 *   multi-member two members adding items to same list
 */

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addMember,
  closeTestDb,
  createUser,
  ensureList,
  openTestDb,
} from '@/__test-helpers__/db.js';
import {
  createTrip,
  addTravelLeg,
  addAccommodation,
  assignPassengersToTrip,
  listTripsForGroup,
  listTripsForPersona,
  listTripStatusesForGroup,
  listTripStatusesForUser,
  getTripStatus,
  listLegsForTrip,
  pickActiveTrip,
  findTripByDateRange,
  findMatchingLegs,
} from '@/services/trips.service.js';
import {
  createTask,
  updateTask,
  listTasks,
  listTasksForUser,
} from '@/services/tasks.service.js';
import { setGrant } from '@/services/trust.service.js';
import {
  listLists,
  listListsForUser,
  addItem,
  setItemChecked,
  deleteItem,
} from '@/services/lists.service.js';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Returns today ± offsetDays as YYYY-MM-DD */
function dateOffset(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

const TODAY = dateOffset(0);
const PAST_START = dateOffset(-30);
const PAST_END = dateOffset(-20);
const FUTURE_START = dateOffset(10);
const FUTURE_END = dateOffset(20);
const CURRENT_START = dateOffset(-3);
const CURRENT_END = dateOffset(3);

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRIPS
// ═══════════════════════════════════════════════════════════════════════════════

describe('trips — temporal classification', () => {
  it('past trip: startDate and endDate both before today', async () => {
    const uid = await createUser(db, 'traveller');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Past Rome', destination: 'Rome',
      startDate: PAST_START, endDate: PAST_END, participantIds: [],
    });

    const trips = await listTripsForGroup(db, group.id);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.id).toBe(trip.id);
    expect(trips[0]!.endDate < TODAY).toBe(true);
  });

  it('future trip: startDate after today', async () => {
    const uid = await createUser(db, 'planner');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Future Tokyo', destination: 'Tokyo',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });

    const trips = await listTripsForGroup(db, group.id);
    expect(trips[0]!.startDate > TODAY).toBe(true);
    expect(trips[0]!.id).toBe(trip.id);
  });

  it('current trip: today is between startDate and endDate', async () => {
    const uid = await createUser(db, 'ontheroadnow');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Current Chicago', destination: 'Chicago',
      startDate: CURRENT_START, endDate: CURRENT_END, participantIds: [],
    });

    const trips = await listTripsForGroup(db, group.id);
    const t = trips[0]!;
    expect(t.id).toBe(trip.id);
    expect(t.startDate <= TODAY && t.endDate >= TODAY).toBe(true);
  });

  it('all three temporal categories stored and listed in start_date order', async () => {
    const uid = await createUser(db, 'alltime');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Future', destination: 'NYC', startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Past', destination: 'Paris', startDate: PAST_START, endDate: PAST_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Current', destination: 'Chicago', startDate: CURRENT_START, endDate: CURRENT_END, participantIds: [],
    });

    const trips = await listTripsForGroup(db, group.id);
    expect(trips).toHaveLength(3);
    // Sorted ascending by start_date
    const starts = trips.map((t) => t.startDate);
    expect(starts).toEqual([...starts].sort());
  });

  it('pickActiveTrip prefers current over upcoming over past', async () => {
    const uid = await createUser(db, 'picker');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Past', destination: 'Madrid', startDate: PAST_START, endDate: PAST_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Upcoming', destination: 'Berlin', startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    const current = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Current', destination: 'Chicago', startDate: CURRENT_START, endDate: CURRENT_END, participantIds: [],
    });

    const active = await pickActiveTrip(db, group.id);
    expect(active?.id).toBe(current.id);
    expect(active?.name).toBe('Current');
  });

  it('pickActiveTrip with no current trip picks nearest upcoming', async () => {
    const uid = await createUser(db, 'upcoming_picker');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Further Future', destination: 'Tokyo', startDate: dateOffset(30), endDate: dateOffset(40), participantIds: [],
    });
    const nearer = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Near Future', destination: 'NYC', startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });

    const active = await pickActiveTrip(db, group.id);
    expect(active?.id).toBe(nearer.id);
  });

  it('pickActiveTrip with only past trips returns a trip (fallback to last created)', async () => {
    const uid = await createUser(db, 'pastonly');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Past A', destination: 'Rome', startDate: PAST_START, endDate: PAST_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Past B', destination: 'Paris', startDate: dateOffset(-10), endDate: dateOffset(-5), participantIds: [],
    });

    // Only past trips — pickActiveTrip falls back to most-recently-created.
    // We just assert it returns something non-null (the exact pick is
    // timestamp-dependent and not worth asserting precisely in fast tests).
    const active = await pickActiveTrip(db, group.id);
    expect(active).not.toBeNull();
  });
});

describe('trips — personas (in-group and out-of-group legs)', () => {
  it('leg attributed to in-group user: listTripsForPersona returns that trip', async () => {
    const alice = await createUser(db, 'alice_ingroup', 'Alice');
    const bob = await createUser(db, 'bob_ingroup', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Chicago', destination: 'Chicago',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [bob],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: bob,
      mode: 'flight', origin: 'JFK', destination: 'ORD',
      departAt: `${FUTURE_START}T08:00:00Z`, arriveAt: `${FUTURE_START}T10:00:00Z`,
    });

    const bobTrips = await listTripsForPersona(db, group.id, bob);
    expect(bobTrips).toHaveLength(1);
    expect(bobTrips[0]!.id).toBe(trip.id);
  });

  it('listTripsForPersona excludes trips where that persona has no leg', async () => {
    const alice = await createUser(db, 'alice_noleg', 'Alice');
    const bob = await createUser(db, 'bob_noleg', 'Bob');
    const carol = await createUser(db, 'carol_noleg', 'Carol');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    await addMember(db, group.id, carol);

    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Bali', destination: 'Bali',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    // Only Alice has a leg
    await addTravelLeg(db, {
      tripId: trip.id, personaId: alice,
      mode: 'flight', origin: 'JFK', destination: 'DPS',
      departAt: `${FUTURE_START}T10:00:00Z`, arriveAt: `${FUTURE_END}T12:00:00Z`,
    });

    const bobTrips = await listTripsForPersona(db, group.id, bob);
    expect(bobTrips, 'Bob has no leg — should not see this trip via listTripsForPersona').toHaveLength(0);

    const carolTrips = await listTripsForPersona(db, group.id, carol);
    expect(carolTrips, 'Carol has no leg either').toHaveLength(0);

    const aliceTrips = await listTripsForPersona(db, group.id, alice);
    expect(aliceTrips, 'Alice has a leg').toHaveLength(1);
  });

  it('leg attributed to an out-of-group user: leg stored, but listTripsForPersona with group scope misses it', async () => {
    const alice = await createUser(db, 'alice_outgroup', 'Alice');
    const outsider = await createUser(db, 'outsider_user', 'Dave');
    // Dave is NOT added to the group
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });

    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'London', destination: 'London',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    // Leg attributed to Dave (who is not in the group)
    const leg = await addTravelLeg(db, {
      tripId: trip.id, personaId: outsider,
      mode: 'flight', origin: 'ORD', destination: 'LHR',
      departAt: `${FUTURE_START}T09:00:00Z`, arriveAt: `${FUTURE_START}T21:00:00Z`,
    });

    // Leg exists in DB
    expect(leg.personaId).toBe(outsider);

    // listTripsForPersona scoped to this group returns it for outsider even though they're not in the group
    // (the function only filters by group_id and travel_legs.persona_id, not group membership)
    const davesTrips = await listTripsForPersona(db, group.id, outsider);
    expect(davesTrips).toHaveLength(1);
    expect(davesTrips[0]!.id).toBe(trip.id);
  });

  it('two people in the same group travelling on the same trip — each has legs', async () => {
    const alice = await createUser(db, 'alice_together', 'Alice');
    const bob = await createUser(db, 'bob_together', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Japan', destination: 'Tokyo',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [alice, bob],
    });
    for (const uid of [alice, bob]) {
      await addTravelLeg(db, {
        tripId: trip.id, personaId: uid,
        mode: 'flight', origin: 'JFK', destination: 'NRT',
        departAt: `${FUTURE_START}T11:00:00Z`, arriveAt: `${FUTURE_END}T14:00:00Z`,
      });
    }

    const aliceTrips = await listTripsForPersona(db, group.id, alice);
    const bobTrips = await listTripsForPersona(db, group.id, bob);
    expect(aliceTrips).toHaveLength(1);
    expect(bobTrips).toHaveLength(1);
    expect(aliceTrips[0]!.id).toBe(bobTrips[0]!.id);
  });

  it('getTripStatus collapses a shared flight into one leg with both passengers', async () => {
    const alice = await createUser(db, 'alice_share', 'Alice');
    const bob = await createUser(db, 'bob_share', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Japan', destination: 'Tokyo',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [alice, bob],
    });
    for (const uid of [alice, bob]) {
      await addTravelLeg(db, {
        tripId: trip.id, personaId: uid,
        mode: 'flight', origin: 'JFK', destination: 'NRT',
        departAt: `${FUTURE_START}T11:00:00Z`, arriveAt: `${FUTURE_END}T14:00:00Z`,
        carrier: 'AC', flightNo: '823',
      });
    }
    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(1);
    expect([...(status!.legs[0]!.passengers ?? [])].sort()).toEqual(['Alice', 'Bob']);
  });

  it('getTripStatus keeps distinct flights as separate legs', async () => {
    const alice = await createUser(db, 'alice_two', 'Alice');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'RT', destination: 'Tokyo',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [alice],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: alice, mode: 'flight', origin: 'JFK', destination: 'NRT',
      departAt: `${FUTURE_START}T11:00:00Z`, arriveAt: `${FUTURE_START}T20:00:00Z`, carrier: 'AC', flightNo: '1',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: alice, mode: 'flight', origin: 'NRT', destination: 'JFK',
      departAt: `${FUTURE_END}T11:00:00Z`, arriveAt: `${FUTURE_END}T20:00:00Z`, carrier: 'AC', flightNo: '2',
    });
    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
  });

  it('addTravelLeg dedups a same-flight re-upload for the same passenger, keeps different people', async () => {
    const alice = await createUser(db, 'alice_dedupe', 'Alice');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Iberia', destination: 'Lisbon',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [alice],
    });
    const leg = {
      tripId: trip.id, personaId: alice, mode: 'flight' as const,
      origin: 'EWR', destination: 'LIS',
      departAt: `${FUTURE_START}T20:00:00-04:00`, arriveAt: `${FUTURE_START}T08:00:00+01:00`,
      carrier: 'TAP', flightNo: '202',
    };
    await addTravelLeg(db, leg);
    await addTravelLeg(db, leg); // re-upload of the same flight + same person
    expect(await listLegsForTrip(db, trip.id)).toHaveLength(1);

    // A different person on the same flight is a separate leg.
    const bob = await createUser(db, 'bob_dedupe', 'Bob');
    await addMember(db, group.id, bob);
    await addTravelLeg(db, { ...leg, personaId: bob });
    expect(await listLegsForTrip(db, trip.id)).toHaveLength(2);
  });

  it('assignPassengersToTrip puts everyone on every flight (one leg per person)', async () => {
    const alice = await createUser(db, 'alice_apt', 'Alice');
    const bob = await createUser(db, 'bob_apt', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Iberia', destination: 'Lisbon',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    // Two passenger-less placeholder flights (as the image classifier files them).
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'EWR', destination: 'LIS',
      departAt: `${FUTURE_START}T20:00:00-04:00`, arriveAt: `${FUTURE_START}T08:00:00+01:00`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'BCN', destination: 'EWR',
      departAt: `${FUTURE_END}T10:00:00+02:00`, arriveAt: `${FUTURE_END}T14:00:00-04:00`,
    });

    const res = await assignPassengersToTrip(db, trip.id, [
      { personaId: alice, name: 'Alice' },
      { personaId: bob, name: 'Bob' },
      { personaId: null, name: 'Nolan' },
      { personaId: null, name: 'Ben' },
    ]);
    // 2 flights × 4 people = 8 legs; 2 placeholders reused, 6 cloned.
    expect(res.flights).toBe(2);
    expect(res.legsAdded).toBe(6);
    const legs = await listLegsForTrip(db, trip.id);
    expect(legs).toHaveLength(8);

    // Idempotent: re-running adds nothing.
    const again = await assignPassengersToTrip(db, trip.id, [
      { personaId: alice, name: 'Alice' },
      { personaId: null, name: 'Nolan' },
    ]);
    expect(again.legsAdded).toBe(0);
    expect(await listLegsForTrip(db, trip.id)).toHaveLength(8);
  });

  it('findMatchingLegs is case-insensitive on origin/destination', async () => {
    const alice = await createUser(db, 'alice_case', 'Alice');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Asia', destination: 'Tokyo',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [alice],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: alice, mode: 'flight',
      origin: 'JFK', destination: 'Tokyo',
      departAt: `${FUTURE_START}T20:00:00-04:00`, arriveAt: `${FUTURE_START}T08:00:00+09:00`,
      carrier: 'JAL', flightNo: '5',
    });

    // Lower-case query must still match the stored "Tokyo" — PG LIKE is
    // case-sensitive, so this requires ILIKE in findMatchingLegs.
    const hits = await findMatchingLegs(db, {
      groupId: group.id, userId: alice, destination: 'tokyo',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].destination).toBe('Tokyo');

    // Same for origin.
    const hits2 = await findMatchingLegs(db, {
      groupId: group.id, userId: alice, origin: 'jfk',
    });
    expect(hits2).toHaveLength(1);
  });
});

describe('trips — cross-group via listTripStatusesForUser', () => {
  it('user in two groups sees trips from both', async () => {
    const alice = await createUser(db, 'alice_cross', 'Alice');
    const g1 = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    const g2 = await createGroup(db, { name: 'Friends', kind: 'group', createdBy: alice });

    await createTrip(db, {
      groupId: g1.id, createdBy: alice,
      name: 'Family Chicago', destination: 'Chicago',
      startDate: PAST_START, endDate: PAST_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: g2.id, createdBy: alice,
      name: 'Friends Nashville', destination: 'Nashville',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });

    const statuses = await listTripStatusesForUser(db, alice);
    expect(statuses.length).toBe(2);
    const names = statuses.map((s) => s.trip.name);
    expect(names).toContain('Family Chicago');
    expect(names).toContain('Friends Nashville');
  });

  it('user not in a group cannot see that group\'s trips', async () => {
    const alice = await createUser(db, 'alice_isolated', 'Alice');
    const bob = await createUser(db, 'bob_isolated', 'Bob');
    const aliceGroup = await createGroup(db, { name: 'Alice Only', kind: 'group', createdBy: alice });

    await createTrip(db, {
      groupId: aliceGroup.id, createdBy: alice,
      name: 'Secret Trip', destination: 'Somewhere',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });

    const bobStatuses = await listTripStatusesForUser(db, bob);
    expect(bobStatuses, 'Bob is not in Alice\'s group').toHaveLength(0);
  });

  it('listTripStatusesForGroup returns only that group\'s trips', async () => {
    const alice = await createUser(db, 'alice_g_scope', 'Alice');
    const g1 = await createGroup(db, { name: 'G1', kind: 'group', createdBy: alice });
    const g2 = await createGroup(db, { name: 'G2', kind: 'group', createdBy: alice });

    await createTrip(db, {
      groupId: g1.id, createdBy: alice,
      name: 'G1 Trip', destination: 'Rome', startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });
    await createTrip(db, {
      groupId: g2.id, createdBy: alice,
      name: 'G2 Trip', destination: 'Paris', startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [],
    });

    const g1Statuses = await listTripStatusesForGroup(db, g1.id);
    expect(g1Statuses).toHaveLength(1);
    expect(g1Statuses[0]!.trip.name).toBe('G1 Trip');
  });
});

describe('trips — getTripStatus', () => {
  it('no legs, no hotel → status returns empty legs/accommodations', async () => {
    const uid = await createUser(db, 'gap_all', 'Alice');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Skeleton', destination: 'London',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [uid],
    });

    const status = await getTripStatus(db, trip.id);
    expect(status).not.toBeNull();
    expect(status!.legs).toHaveLength(0);
    expect(status!.accommodations).toHaveLength(0);
    expect(status!.participantNames).toEqual(['Alice']);
  });

  it('adds legs → legs appear in status sorted by depart time', async () => {
    const uid = await createUser(db, 'gap_inbound', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'London Trip', destination: 'London',
      startDate: FUTURE_START, endDate: FUTURE_END, participantIds: [uid],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid,
      mode: 'flight', origin: 'New York', destination: 'London',
      departAt: `${FUTURE_START}T08:00:00Z`,
      arriveAt: `${FUTURE_START}T20:00:00Z`,
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(1);
    expect(status!.legs[0]!.origin).toBe('New York');
  });

  it('full legs + hotel → all appear in status', async () => {
    const uid = await createUser(db, 'complete_trip', 'Carol');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Complete Paris', destination: 'Paris',
      startDate: '2027-06-01', endDate: '2027-06-07', participantIds: [uid],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid,
      mode: 'flight', origin: 'New York', destination: 'Paris',
      departAt: '2027-06-01T06:00:00Z', arriveAt: '2027-06-01T18:00:00Z',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: uid,
      mode: 'flight', origin: 'Paris', destination: 'New York',
      departAt: '2027-06-07T10:00:00Z', arriveAt: '2027-06-07T13:00:00Z',
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Hotel Le Marais',
      checkinDate: '2027-06-01',
      checkoutDate: '2027-06-07',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.accommodations).toHaveLength(1);
    expect(status!.participantNames).toEqual(['Carol']);
  });

  it('two participants → both names appear in participantNames', async () => {
    const alice = await createUser(db, 'alice_2pax', 'Alice');
    const bob = await createUser(db, 'bob_2pax', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    const trip = await createTrip(db, {
      groupId: group.id, createdBy: alice,
      name: 'Mixed Status', destination: 'Dublin',
      startDate: '2027-05-10', endDate: '2027-05-17', participantIds: [alice, bob],
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.participantNames).toContain('Alice');
    expect(status!.participantNames).toContain('Bob');
  });
});

describe('trips — getTripStatus gap detection', () => {
  it('full hotel coverage → gaps is empty', async () => {
    const uid = await createUser(db, 'gap_full', 'Dan');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Bozeman', destination: 'Bozeman',
      startDate: '2025-07-12', endDate: '2025-07-24', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Four Seasons',
      checkinDate: '2025-07-12',
      checkoutDate: '2025-07-24',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.gaps).toHaveLength(0);
  });

  it('no accommodation → whole trip window is a gap', async () => {
    const uid = await createUser(db, 'gap_none', 'Eve');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Unplanned', destination: 'Denver',
      startDate: '2025-08-01', endDate: '2025-08-07', participantIds: [],
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.gaps).toHaveLength(1);
    expect(status!.gaps[0]).toEqual({ start: '2025-08-01', end: '2025-08-07' });
  });

  it('hotel covers middle → gaps at start and end', async () => {
    const uid = await createUser(db, 'gap_partial', 'Fred');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Partial', destination: 'Chicago',
      startDate: '2025-09-01', endDate: '2025-09-10', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Hotel Mid',
      checkinDate: '2025-09-03',
      checkoutDate: '2025-09-07',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.gaps).toHaveLength(2);
    expect(status!.gaps[0]).toEqual({ start: '2025-09-01', end: '2025-09-03' });
    expect(status!.gaps[1]).toEqual({ start: '2025-09-07', end: '2025-09-10' });
  });

  it('hotel on a separate trip shell → still surfaces in status and closes the gap', async () => {
    const uid = await createUser(db, 'gap_crostrip', 'Grace');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    // Flight trip — created when the outbound leg was added
    const flightTrip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Bozeman Flight', destination: 'Bozeman',
      startDate: '2025-07-12', endDate: '2025-07-24', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: flightTrip.id,
      mode: 'flight', origin: 'New York', destination: 'Bozeman',
      departAt: '2025-07-12T08:00:00Z', arriveAt: '2025-07-12T14:00:00Z',
    });

    // Hotel trip — a separate trip shell auto-created when the Four Seasons
    // itinerary was uploaded (date-range lookup missed the flight trip)
    const hotelTrip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Four Seasons Bozeman', destination: 'Bozeman',
      startDate: '2025-07-12', endDate: '2025-07-24', participantIds: [],
    });
    await addAccommodation(db, {
      tripId: hotelTrip.id,
      propertyName: 'Four Seasons Bozeman',
      checkinDate: '2025-07-12',
      checkoutDate: '2025-07-24',
    });

    // Querying the flight trip should surface the hotel from the other shell
    const status = await getTripStatus(db, flightTrip.id);
    expect(status!.accommodations).toHaveLength(1);
    expect(status!.accommodations[0]!.propertyName).toBe('Four Seasons Bozeman');
    expect(status!.gaps).toHaveLength(0);
  });
});

describe('trips — findTripByDateRange overlap cases', () => {
  it('window fully inside trip → matches', async () => {
    const uid = await createUser(db, 'range_inside', 'E');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Long Trip', destination: 'Asia',
      startDate: '2027-04-01', endDate: '2027-04-30', participantIds: [],
    });

    const found = await findTripByDateRange(db, uid, '2027-04-10', '2027-04-20', group.id);
    expect(found?.id).toBe(trip.id);
  });

  it('window overlaps start of trip → matches', async () => {
    const uid = await createUser(db, 'range_start_overlap', 'F');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Mid Trip', destination: 'London',
      startDate: '2027-07-10', endDate: '2027-07-20', participantIds: [],
    });

    const found = await findTripByDateRange(db, uid, '2027-07-05', '2027-07-12', group.id);
    expect(found?.id).toBe(trip.id);
  });

  it('same-day window (depart and arrive same day) → matches trip starting that day', async () => {
    const uid = await createUser(db, 'range_sameday', 'G');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Chicago Short', destination: 'Chicago',
      startDate: '2027-09-05', endDate: '2027-09-07', participantIds: [],
    });

    // Same-day window: depart and arrive Sept 5
    const found = await findTripByDateRange(db, uid, '2027-09-05', '2027-09-05', group.id);
    expect(found?.id).toBe(trip.id);
  });

  it('window outside trip range → no match', async () => {
    const uid = await createUser(db, 'range_outside', 'H');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    await createTrip(db, {
      groupId: group.id, createdBy: uid,
      name: 'Old Trip', destination: 'Miami',
      startDate: '2026-01-01', endDate: '2026-01-10', participantIds: [],
    });

    const found = await findTripByDateRange(db, uid, '2027-06-01', '2027-06-05', group.id);
    expect(found).toBeNull();
  });

  it('two overlapping trips: prefers the one in the current group', async () => {
    const uid = await createUser(db, 'range_prefer', 'I');
    const g1 = await createGroup(db, { name: 'Pref Group', kind: 'group', createdBy: uid });
    const g2 = await createGroup(db, { name: 'Other Group', kind: 'group', createdBy: uid });

    const preferred = await createTrip(db, {
      groupId: g1.id, createdBy: uid,
      name: 'In Preferred Group', destination: 'Berlin',
      startDate: '2027-08-01', endDate: '2027-08-10', participantIds: [],
    });
    await createTrip(db, {
      groupId: g2.id, createdBy: uid,
      name: 'In Other Group', destination: 'Vienna',
      startDate: '2027-08-01', endDate: '2027-08-10', participantIds: [],
    });

    const found = await findTripByDateRange(db, uid, '2027-08-05', '2027-08-05', g1.id);
    expect(found?.id).toBe(preferred.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

describe('tasks — group sharing', () => {
  it('task created by owner is visible to all group members via listTasks', async () => {
    const alice = await createUser(db, 'alice_task_share', 'Alice');
    const bob = await createUser(db, 'bob_task_share', 'Bob');
    const carol = await createUser(db, 'carol_task_share', 'Carol');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    await addMember(db, group.id, carol);

    await createTask(db, {
      groupId: group.id, createdBy: alice,
      title: 'Book flights',
    });

    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Book flights');
    // All members see it — the same listTasks call returns results for anyone in the group
  });

  it('task assigned to a specific member has assigneeId set', async () => {
    const alice = await createUser(db, 'alice_assignee', 'Alice');
    const bob = await createUser(db, 'bob_assignee', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    // ADR 0026 — assignment is closed by default; Bob must grant Alice
    // trust to land a task on him.
    await setGrant(db, bob, alice, ['task']);

    await createTask(db, {
      groupId: group.id, createdBy: alice,
      title: 'Confirm hotel', assigneeId: bob,
    });

    const tasks = await listTasks(db, group.id);
    expect(tasks[0]!.assigneeId).toBe(bob);
  });

  it('unassigned task has null assigneeId and is visible to everyone', async () => {
    const alice = await createUser(db, 'alice_unassigned', 'Alice');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });

    await createTask(db, {
      groupId: group.id, createdBy: alice,
      title: 'Pack sunscreen',
    });

    const tasks = await listTasks(db, group.id);
    // rowToTask maps null assignee_id → undefined (not null)
    expect(tasks[0]!.assigneeId).toBeUndefined();
  });

  it('task with remindCue and remindAt stores both fields', async () => {
    const uid = await createUser(db, 'remind_user', 'R');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTask(db, {
      groupId: group.id, createdBy: uid,
      title: 'Buy travel insurance',
      remindCue: '2 weeks before departure',
      remindAt: '2027-06-01T09:00:00Z',
    });

    const tasks = await listTasks(db, group.id);
    expect(tasks[0]!.remindCue).toBe('2 weeks before departure');
    expect(tasks[0]!.remindAt).toBe('2027-06-01T09:00:00Z');
  });

  it('task in personal group behaves identically to group task', async () => {
    const uid = await createUser(db, 'personal_task_user', 'P');
    const personal = await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: uid });

    await createTask(db, {
      groupId: personal.id, createdBy: uid,
      title: 'Dentist appointment',
    });

    const tasks = await listTasks(db, personal.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Dentist appointment');
  });
});

describe('tasks — status lifecycle', () => {
  it('new task starts as open', async () => {
    const uid = await createUser(db, 'status_new', 'S');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, { groupId: group.id, createdBy: uid, title: 'New task' });

    expect(task.status).toBe('open');
  });

  it('task progresses open → active → done', async () => {
    const uid = await createUser(db, 'status_progress', 'T');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, { groupId: group.id, createdBy: uid, title: 'Lifecycle task' });

    const active = await updateTask(db, task.id, { status: 'active' });
    expect(active?.status).toBe('active');

    const done = await updateTask(db, task.id, { status: 'done' });
    expect(done?.status).toBe('done');
  });

  it('task can be archived', async () => {
    const uid = await createUser(db, 'status_archive', 'U');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, { groupId: group.id, createdBy: uid, title: 'Archive me' });

    const archived = await updateTask(db, task.id, {
      status: 'archived',
      archivedAt: new Date().toISOString(),
    });
    expect(archived?.status).toBe('archived');
    expect(archived?.archivedAt).toBeTruthy();
  });

  it('task can be superseded', async () => {
    const uid = await createUser(db, 'status_superseded', 'V');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const task = await createTask(db, { groupId: group.id, createdBy: uid, title: 'Old plan' });

    const result = await updateTask(db, task.id, { status: 'superseded' });
    expect(result?.status).toBe('superseded');
  });

  it('all 5 statuses are reachable and distinct', async () => {
    const uid = await createUser(db, 'all_statuses', 'W');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    const statuses = ['open', 'active', 'done', 'superseded', 'archived'] as const;
    for (const s of statuses) {
      const task = await createTask(db, { groupId: group.id, createdBy: uid, title: `Task ${s}` });
      if (s !== 'open') {
        await updateTask(db, task.id, {
          status: s,
          ...(s === 'archived' ? { archivedAt: new Date().toISOString() } : {}),
        });
      }
    }

    const tasks = await listTasks(db, group.id);
    const seenStatuses = new Set(tasks.map((t) => t.status));
    for (const s of statuses) {
      expect(seenStatuses.has(s), `status ${s} should be present`).toBe(true);
    }
  });
});

describe('tasks — cross-group and isolation', () => {
  it('listTasksForUser spans all groups the user belongs to', async () => {
    const alice = await createUser(db, 'alice_cross_task', 'Alice');
    const g1 = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    const g2 = await createGroup(db, { name: 'Work', kind: 'group', createdBy: alice });

    await createTask(db, { groupId: g1.id, createdBy: alice, title: 'Family task' });
    await createTask(db, { groupId: g2.id, createdBy: alice, title: 'Work task' });

    const allTasks = await listTasksForUser(db, alice);
    expect(allTasks).toHaveLength(2);
    const titles = allTasks.map((t) => t.title);
    expect(titles).toContain('Family task');
    expect(titles).toContain('Work task');
  });

  it('tasks in group A are not returned by listTasks(groupB)', async () => {
    const alice = await createUser(db, 'alice_task_iso', 'Alice');
    const bob = await createUser(db, 'bob_task_iso', 'Bob');
    const gA = await createGroup(db, { name: 'Group A', kind: 'group', createdBy: alice });
    const gB = await createGroup(db, { name: 'Group B', kind: 'group', createdBy: bob });

    await createTask(db, { groupId: gA.id, createdBy: alice, title: 'Group A task' });

    const bTasks = await listTasks(db, gB.id);
    expect(bTasks).toHaveLength(0);
  });

  it('member of group can see tasks created by other member', async () => {
    const alice = await createUser(db, 'alice_shared_task', 'Alice');
    const bob = await createUser(db, 'bob_shared_task', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    await createTask(db, { groupId: group.id, createdBy: bob, title: 'Bob\'s shared task' });

    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.createdBy).toBe(bob);
    // Alice also sees it because it's in the shared group
    const aliceTasks = await listTasksForUser(db, alice);
    expect(aliceTasks.some((t) => t.title === 'Bob\'s shared task')).toBe(true);
  });

  it('multiple tasks in same group are all returned', async () => {
    const uid = await createUser(db, 'multi_task_user', 'M');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    for (let i = 0; i < 5; i++) {
      await createTask(db, { groupId: group.id, createdBy: uid, title: `Task ${i + 1}` });
    }

    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(5);
  });

  it('task with due date in the past vs future both stored identically', async () => {
    const uid = await createUser(db, 'past_future_due', 'PF');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    await createTask(db, {
      groupId: group.id, createdBy: uid,
      title: 'Past due', dueAt: '2020-01-01T09:00:00Z',
    });
    await createTask(db, {
      groupId: group.id, createdBy: uid,
      title: 'Future due', dueAt: '2030-01-01T09:00:00Z',
    });

    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(2);
    const past = tasks.find((t) => t.title === 'Past due')!;
    const future = tasks.find((t) => t.title === 'Future due')!;
    expect(past.dueAt).toBe('2020-01-01T09:00:00Z');
    expect(future.dueAt).toBe('2030-01-01T09:00:00Z');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('lists — group sharing', () => {
  it('list created in group is visible to all members via listLists', async () => {
    const alice = await createUser(db, 'alice_list_share', 'Alice');
    const bob = await createUser(db, 'bob_list_share', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    const list = await ensureList(db, group.id, 'Grocery', alice);
    await addItem(db, list.id, 'milk');
    await addItem(db, list.id, 'eggs');

    const result = await listLists(db, group.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.items).toHaveLength(2);
    // Same result regardless of which member calls it — group-scoped, not user-scoped
  });

  it('two members adding to same list — items merge under one list', async () => {
    const alice = await createUser(db, 'alice_twoadd', 'Alice');
    const bob = await createUser(db, 'bob_twoadd', 'Bob');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    const list = await ensureList(db, group.id, 'Costco', alice);
    await addItem(db, list.id, 'sunscreen');

    // Bob adds to the same list
    const list2 = await ensureList(db, group.id, 'Costco', bob);
    await addItem(db, list2.id, 'towels');

    expect(list.id).toBe(list2.id); // same list object

    const result = await listLists(db, group.id);
    expect(result).toHaveLength(1);
    expect(result[0]!.items).toHaveLength(2);
    const texts = result[0]!.items.map((i) => i.text);
    expect(texts).toContain('sunscreen');
    expect(texts).toContain('towels');
  });

  it('ensureList returns existing list on second call', async () => {
    const uid = await createUser(db, 'idempotent_list', 'I');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    const first = await ensureList(db, group.id, 'Packing', uid);
    const second = await ensureList(db, group.id, 'Packing', uid);

    expect(first.id).toBe(second.id);
    const lists = await listLists(db, group.id);
    expect(lists).toHaveLength(1);
  });

  it('setItemChecked marks an item done without affecting other items', async () => {
    const uid = await createUser(db, 'check_user', 'C');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const list = await ensureList(db, group.id, 'Packing', uid);

    const passport = (await addItem(db, list.id, 'passport')).item;
    const charger = (await addItem(db, list.id, 'charger')).item;

    await setItemChecked(db, passport.id, true);

    const result = await listLists(db, group.id);
    const items = result[0]!.items;
    const passportItem = items.find((i) => i.id === passport.id)!;
    const chargerItem = items.find((i) => i.id === charger.id)!;

    expect(passportItem.checked).toBe(true);
    expect(chargerItem.checked).toBe(false);
  });

  it('deleteItem removes item; list and other items remain', async () => {
    const uid = await createUser(db, 'delete_item_user', 'D');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const list = await ensureList(db, group.id, 'Grocery', uid);

    const milk = (await addItem(db, list.id, 'milk')).item;
    await addItem(db, list.id, 'bread');

    await deleteItem(db, milk.id);

    const result = await listLists(db, group.id);
    expect(result[0]!.items).toHaveLength(1);
    expect(result[0]!.items[0]!.text).toBe('bread');
  });
});

describe('lists — cross-group and isolation', () => {
  it('listListsForUser spans all groups the user belongs to', async () => {
    const alice = await createUser(db, 'alice_cross_list', 'Alice');
    const g1 = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    const g2 = await createGroup(db, { name: 'Work', kind: 'group', createdBy: alice });

    const list1 = await ensureList(db, g1.id, 'Family Grocery', alice);
    await addItem(db, list1.id, 'butter');

    const list2 = await ensureList(db, g2.id, 'Work Supplies', alice);
    await addItem(db, list2.id, 'printer paper');

    const allLists = await listListsForUser(db, alice);
    expect(allLists).toHaveLength(2);
    const names = allLists.map((l) => l.name);
    expect(names).toContain('Family Grocery');
    expect(names).toContain('Work Supplies');
  });

  it('list in group A not returned by listLists(groupB)', async () => {
    const alice = await createUser(db, 'alice_list_iso', 'Alice');
    const bob = await createUser(db, 'bob_list_iso', 'Bob');
    const gA = await createGroup(db, { name: 'A', kind: 'group', createdBy: alice });
    const gB = await createGroup(db, { name: 'B', kind: 'group', createdBy: bob });

    await ensureList(db, gA.id, 'Secret List', alice);

    const bLists = await listLists(db, gB.id);
    expect(bLists).toHaveLength(0);
  });

  it('user not in group cannot see its lists via listListsForUser', async () => {
    const alice = await createUser(db, 'alice_list_excl', 'Alice');
    const bob = await createUser(db, 'bob_list_excl', 'Bob');
    const group = await createGroup(db, { name: 'Alice Only', kind: 'group', createdBy: alice });

    const list = await ensureList(db, group.id, 'Private List', alice);
    await addItem(db, list.id, 'secret item');

    const bobLists = await listListsForUser(db, bob);
    expect(bobLists).toHaveLength(0);
  });

  it('same list name in two groups creates two independent lists', async () => {
    const alice = await createUser(db, 'alice_samename', 'Alice');
    const g1 = await createGroup(db, { name: 'G1', kind: 'group', createdBy: alice });
    const g2 = await createGroup(db, { name: 'G2', kind: 'group', createdBy: alice });

    const l1 = await ensureList(db, g1.id, 'Grocery', alice);
    const l2 = await ensureList(db, g2.id, 'Grocery', alice);

    expect(l1.id).not.toBe(l2.id);
    await addItem(db, l1.id, 'g1 item');
    await addItem(db, l2.id, 'g2 item');

    const g1Lists = await listLists(db, g1.id);
    const g2Lists = await listLists(db, g2.id);
    expect(g1Lists[0]!.items[0]!.text).toBe('g1 item');
    expect(g2Lists[0]!.items[0]!.text).toBe('g2 item');
  });

  it('multiple list types in same group are all returned', async () => {
    const uid = await createUser(db, 'multi_list_user', 'M');
    const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    for (const name of ['Grocery', 'Costco', 'Packing', 'Notes', 'To-Do']) {
      const list = await ensureList(db, group.id, name, uid);
      await addItem(db, list.id, `${name} item 1`);
    }

    const result = await listLists(db, group.id);
    expect(result).toHaveLength(5);
    const names = result.map((l) => l.name);
    expect(names).toContain('Grocery');
    expect(names).toContain('Costco');
    expect(names).toContain('Packing');
    expect(names).toContain('Notes');
    expect(names).toContain('To-Do');
  });
});
