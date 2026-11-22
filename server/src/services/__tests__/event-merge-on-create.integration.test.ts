/**
 * Reported: one flight ends up as several calendar events - a booking email,
 * an e-ticket and a change notice each make one, and an itinerary with two
 * passengers makes one per passenger. The same event arriving again must
 * update the one already there.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addTravelLeg, createTrip, rescheduleBookedLegs } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DEPART = '2026-11-20T21:30:00-05:00';
const ARRIVE = '2026-11-21T22:15:00+05:30';

describe('the same event again updates the one already there', () => {
  let db: Kysely<DB>;
  let uid: string;
  let personal: string;

  beforeEach(async () => {
    db = await openTestDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    uid = await createUser(db, 'john');
    personal = (await ensurePersonalGroup(db, uid)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const events = () =>
    db
      .selectFrom('events')
      .select(['id', 'title', 'starts_at', 'ends_at', 'location', 'description', 'external_uid'])
      .where('deleted_at', 'is', null)
      .orderBy('created_at', 'asc')
      .execute();

  it('three differently worded emails about one flight make one event', async () => {
    const first = await createEvent(db, {
      groupId: personal,
      createdBy: uid,
      assigneeId: uid,
      title: 'Flight to Delhi',
      startsAt: DEPART,
      endsAt: ARRIVE,
      description: null,
    });
    expect(first.merged).toBeUndefined();

    const second = await createEvent(db, {
      groupId: personal,
      createdBy: uid,
      assigneeId: uid,
      title: 'Air India AI 102 JFK to DEL',
      // The same instant, printed in another zone.
      startsAt: '2026-11-21T02:30:00Z',
      endsAt: ARRIVE,
      location: 'JFK Terminal 4',
      description: 'Confirmation: 6XK2PQ',
    });
    expect(second.merged).toBe('updated');
    expect(second.id).toBe(first.id);

    const third = await createEvent(db, {
      groupId: personal,
      createdBy: uid,
      assigneeId: uid,
      title: 'Your flight AI 102',
      startsAt: DEPART,
      endsAt: ARRIVE,
      description: 'Confirmation: 6XK2PQ',
    });
    expect(third.merged).toBe('unchanged');

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Air India AI 102 JFK to DEL',
      location: 'JFK Terminal 4',
      description: 'Confirmation: 6XK2PQ',
    });
  });

  it('a different flight at the same time stays a second event', async () => {
    await createEvent(db, {
      groupId: personal, createdBy: uid, assigneeId: uid,
      title: 'AI 102 JFK→DEL', startsAt: DEPART, endsAt: ARRIVE, description: null,
    });
    const other = await createEvent(db, {
      groupId: personal, createdBy: uid, assigneeId: uid,
      title: 'UA 82 EWR→DEL', startsAt: DEPART, endsAt: ARRIVE, description: null,
    });
    expect(other.merged).toBeUndefined();
    expect(await events()).toHaveLength(2);
  });

  it('an event that came from Google is left untouched and not duplicated', async () => {
    // The airline's own invite, pulled from the calendar.
    await createEvent(db, {
      groupId: personal, createdBy: uid, assigneeId: uid,
      title: 'Air India flight AI 102', startsAt: DEPART, endsAt: ARRIVE,
      externalUid: 'gcal:primary:abc123', description: 'From Air India',
    });
    const ours = await createEvent(db, {
      groupId: personal, createdBy: uid, assigneeId: uid,
      title: 'AI 102 JFK→DEL', startsAt: DEPART, endsAt: ARRIVE,
      description: 'Confirmation: 6XK2PQ',
    });
    expect(ours.merged).toBe('covered');
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.description).toBe('From Air India');
  });

  it("a private event does not swallow a group event's copies", async () => {
    const other = await createUser(db, 'alice');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    await db
      .insertInto('group_members')
      .values({ group_id: family.id, user_id: other, role: 'member', tier: 'verified', joined_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .execute();
    await createEvent(db, {
      groupId: personal, createdBy: uid, assigneeId: uid,
      title: 'Dinner', startsAt: DEPART, description: null,
    });
    const shared = await createEvent(db, {
      groupId: family.id, createdBy: uid, title: 'Dinner', startsAt: DEPART, description: null,
    });
    expect(shared.merged).toBeUndefined();
    const owners = await db
      .selectFrom('events')
      .select('owner_user_id')
      .where('group_id', '=', family.id)
      .execute();
    expect(owners.map((o) => o.owner_user_id).sort()).toEqual([uid, other].sort());
  });

  describe('flight legs', () => {
    const trip = async () => {
      const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
      const t = await createTrip(db, {
        groupId: g.id, createdBy: uid, name: 'Delhi', destination: 'DEL',
        startDate: '2026-11-20', endDate: '2026-12-05', participantIds: [],
      });
      return { groupId: g.id, tripId: t.id };
    };
    const leg = (tripId: string, passengerName: string) => ({
      tripId,
      mode: 'flight' as const,
      origin: 'JFK',
      destination: 'DEL',
      departAt: DEPART,
      arriveAt: ARRIVE,
      carrier: 'AI',
      flightNo: '102',
      confirmation: '6XK2PQ',
      passengerName,
    });

    it('two passengers on one flight share one event that lists both', async () => {
      const { tripId } = await trip();
      await addTravelLeg(db, leg(tripId, 'STONE SIMON MR'));
      await addTravelLeg(db, leg(tripId, 'STONE ALICE MS'));

      const legs = await db.selectFrom('travel_legs').select('id').where('trip_id', '=', tripId).execute();
      expect(legs).toHaveLength(2);
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe('AI 102 JFK→DEL');
      expect(rows[0]!.description).toBe(
        'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n' +
          'Passenger: STONE ALICE MS · Confirmation: 6XK2PQ',
      );
    });

    it('two separate itineraries for one flight: one event, each booking beside its passenger', async () => {
      const { tripId } = await trip();
      await addTravelLeg(db, { ...leg(tripId, 'STONE SIMON MR'), notes: 'Itinerary 73541634338201' });
      await addTravelLeg(db, {
        ...leg(tripId, 'STONE ALICE MS'),
        confirmation: '9ZZ4TT',
        notes: 'Itinerary 73541634338999',
      });
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.description).toBe(
        'Passenger: STONE SIMON MR · Confirmation: 6XK2PQ\n' +
          '• Itinerary 73541634338201\n' +
          'Passenger: STONE ALICE MS · Confirmation: 9ZZ4TT\n' +
          '• Itinerary 73541634338999',
      );
    });

    it('a leg joins a flight event an email already made', async () => {
      const { groupId, tripId } = await trip();
      await createEvent(db, {
        groupId, createdBy: uid, assigneeId: uid,
        title: 'Flight to Delhi', startsAt: DEPART, endsAt: ARRIVE, description: null,
      });
      await addTravelLeg(db, leg(tripId, 'STONE SIMON MR'));
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: 'AI 102 JFK→DEL', location: 'JFK → DEL' });
      expect(rows[0]!.description).toContain('Passenger: STONE SIMON MR');
    });

    it('moving one passenger leaves the other on the original event', async () => {
      const { tripId } = await trip();
      await addTravelLeg(db, leg(tripId, 'STONE SIMON MR'));
      await addTravelLeg(db, { ...leg(tripId, 'STONE ALICE MS'), confirmation: '9ZZ4TT' });

      const laterDepart = '2026-11-21T21:30:00-05:00';
      const laterArrive = '2026-11-22T22:15:00+05:30';
      const moved = await rescheduleBookedLegs(db, {
        ...leg(tripId, 'STONE ALICE MS'),
        confirmation: '9ZZ4TT',
        departAt: laterDepart,
        arriveAt: laterArrive,
      });
      expect(moved).toHaveLength(1);

      const rows = await events();
      expect(rows).toHaveLength(2);
      const original = rows.find((r) => Date.parse(r.starts_at) === Date.parse(DEPART))!;
      const next = rows.find((r) => Date.parse(r.starts_at) === Date.parse(laterDepart))!;
      expect(original.description).toContain('Passenger: STONE SIMON MR');
      expect(original.description).not.toContain('ALICE');
      expect(next.description).toContain('Passenger: STONE ALICE MS');
    });

    it('moving the only passenger moves the event rather than making a second', async () => {
      const { tripId } = await trip();
      await addTravelLeg(db, leg(tripId, 'STONE SIMON MR'));
      const laterDepart = '2026-11-21T21:30:00-05:00';
      await rescheduleBookedLegs(db, {
        ...leg(tripId, 'STONE SIMON MR'),
        departAt: laterDepart,
        arriveAt: '2026-11-22T22:15:00+05:30',
      });
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(Date.parse(rows[0]!.starts_at)).toBe(Date.parse(laterDepart));
    });
  });
});
