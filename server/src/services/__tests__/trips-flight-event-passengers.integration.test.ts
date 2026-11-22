/**
 * Reported: a flight's calendar event lists one block per passenger, but a
 * family-member passenger (stored as `persona_id`, `passenger_name` NULL) and a
 * passenger set after the leg was created never appeared by name, so searching
 * the calendar for who is travelling found nothing.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addTravelLeg,
  assignPassengersToTrip,
  createTrip,
  findUpcomingFlights,
  rescheduleBookedLegs,
  setLegPassenger,
} from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DEPART = '2026-11-20T21:30:00-05:00';
const ARRIVE = '2026-11-21T22:15:00+05:30';

describe('every passenger on a flight is named in its calendar event', () => {
  let db: Kysely<DB>;
  let uid: string;
  let alice: string;
  let tripId: string;

  beforeEach(async () => {
    db = await openTestDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    uid = await createUser(db, 'john', 'John Doe');
    alice = await createUser(db, 'alice', 'Alice Stone');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const t = await createTrip(db, {
      groupId: g.id, createdBy: uid, name: 'Delhi', destination: 'DEL',
      startDate: '2026-11-20', endDate: '2026-12-05', participantIds: [],
    });
    tripId = t.id;
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const leg = (extra: { passengerName?: string; personaId?: string; confirmation?: string } = {}) => ({
    tripId,
    mode: 'flight' as const,
    origin: 'JFK',
    destination: 'DEL',
    departAt: DEPART,
    arriveAt: ARRIVE,
    carrier: 'AI',
    flightNo: '102',
    confirmation: '6XK2PQ',
    ...extra,
  });

  const events = () =>
    db
      .selectFrom('events')
      .select(['id', 'starts_at', 'description'])
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();

  it('a family-member passenger is named by their display name', async () => {
    await addTravelLeg(db, leg({ personaId: alice }));
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('Passenger: Alice Stone · Confirmation: 6XK2PQ');
  });

  it('a family member and a named passenger share one event, both named', async () => {
    await addTravelLeg(db, leg({ passengerName: 'STONE SIMON MR' }));
    await addTravelLeg(db, leg({ personaId: alice, confirmation: '9ZZ4TT' }));
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe(
      'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n' +
        'Passenger: Alice Stone · Confirmation: 9ZZ4TT',
    );
  });

  it('a passenger set after the leg exists replaces the passenger-less block', async () => {
    const created = await addTravelLeg(db, { ...leg(), notes: 'Itinerary 73541634338201' });
    expect((await events())[0]!.description).toBe('Confirmation: 6XK2PQ\nItinerary 73541634338201');

    await setLegPassenger(db, created.id, { passengerName: 'STONE SIMON MR' });
    expect((await events())[0]!.description).toBe(
      'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n• Itinerary 73541634338201',
    );
  });

  it('replacing a passenger takes the old one off and names the new one', async () => {
    const created = await addTravelLeg(db, leg({ passengerName: 'Wrong Person' }));
    await setLegPassenger(db, created.id, { personaId: alice });
    const desc = (await events())[0]!.description!;
    expect(desc).toBe('Passenger: Alice Stone · Confirmation: 6XK2PQ');
    expect(desc).not.toContain('Wrong Person');
  });

  it('set_trip_passengers names everyone, including the legs it adds', async () => {
    await addTravelLeg(db, leg());
    const res = await assignPassengersToTrip(db, tripId, [
      { personaId: uid, name: 'John' },
      { personaId: alice, name: 'Alice' },
      { personaId: null, name: 'Ben' },
    ]);
    expect(res.legsAdded).toBe(2);
    // Ben is a raw name on the same booking as two members: still a leg of his own.
    const legs = await db
      .selectFrom('travel_legs')
      .select(['persona_id', 'passenger_name'])
      .where('trip_id', '=', tripId)
      .execute();
    expect(legs).toHaveLength(3);
    expect(legs.map((l) => l.persona_id ?? l.passenger_name).sort()).toEqual(['Ben', alice, uid].sort());
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe(
      'Passenger: John Doe · Confirmation: 6XK2PQ\n' +
        'Passenger: Alice Stone · Confirmation: 6XK2PQ\n' +
        'Passenger: Ben · Confirmation: 6XK2PQ',
    );
  });

  it("the bot's flight lookup names a family-member passenger", async () => {
    await addTravelLeg(db, leg({ personaId: alice }));
    const legs = await findUpcomingFlights(db, {
      userId: uid,
      sinceMs: Date.parse(DEPART) - 86_400_000,
      untilMs: Date.parse(DEPART) + 86_400_000,
      limit: 10,
    });
    expect(legs.map((l) => l.passengerName)).toEqual(['Alice Stone']);
  });

  it('a family member who moves flights comes off the old event', async () => {
    await addTravelLeg(db, leg({ passengerName: 'STONE SIMON MR' }));
    await addTravelLeg(db, leg({ personaId: alice, confirmation: '9ZZ4TT' }));
    const laterDepart = '2026-11-21T21:30:00-05:00';
    const moved = await rescheduleBookedLegs(db, {
      ...leg({ personaId: alice, confirmation: '9ZZ4TT' }),
      departAt: laterDepart,
      arriveAt: '2026-11-22T22:15:00+05:30',
    });
    expect(moved).toHaveLength(1);
    const rows = await events();
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => Date.parse(r.starts_at) === Date.parse(DEPART))!;
    const next = rows.find((r) => Date.parse(r.starts_at) === Date.parse(laterDepart))!;
    expect(original.description).toBe('Passenger: STONE SIMON MR · Confirmation: 6XK2PQ');
    expect(next.description).toBe('Passenger: Alice Stone · Confirmation: 9ZZ4TT');
  });
});
