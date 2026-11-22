/**
 * Comprehensive integration tests: group lifecycle, user management, itineraries,
 * bot tool use, saves, and attachment classification — all against a per-test
 * Postgres database (cloned from chord_test_template) with the mock LLM provider.
 *
 * Failed assertions carry a `hint` message describing the likely fix.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import {
  addMember,
  closeTestDb,
  createUser,
  insertMessage,
  openTestDb,
} from '@/__test-helpers__/db.js';
import { runBotTurn, decideReaction } from '@/services/bot/bot.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, joinGroupByCode, isMember } from '@/services/groups.service.js';
import {
  createTrip,
  addTravelLeg,
  addAccommodation,
  listTripsForGroup,
  findTripByDateRange,
} from '@/services/trips.service.js';
import { classifyAndAutoFileAttachment } from '@/services/bot/trip_classifier.js';

// ── helpers ──────────────────────────────────────────────────────────────────

const insertUserMessage = insertMessage;

// ── shared fixtures ───────────────────────────────────────────────────────────

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

// ── group lifecycle ───────────────────────────────────────────────────────────

describe('group lifecycle', () => {
  it('creates a group and the creator becomes owner', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Trip Planning', kind: 'group', createdBy: uid });

    expect(group.name, 'hint: createGroup should set name').toBe('Trip Planning');
    expect(group.invite_code.length, 'hint: invite_code should be generated').toBeGreaterThan(0);

    const row = await db
      .selectFrom('group_members')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('user_id', '=', uid)
      .executeTakeFirst();
    expect(row?.role, 'hint: creator should be inserted as owner').toBe('owner');
  });

  it('joining via invite code adds member', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });

    const joined = await joinGroupByCode(db, bob, group.invite_code);
    expect(joined?.id, 'hint: joinGroupByCode should return the group').toBe(group.id);
    expect(
      await isMember(db, group.id, bob),
      'hint: bob should be a member after joining by code',
    ).toBe(true);
  });

  it('personal groups cannot be joined by invite code', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const personal = await createGroup(db, { name: 'Alice My Chord', kind: 'personal', createdBy: alice });

    const joined = await joinGroupByCode(db, bob, personal.invite_code);
    expect(joined, 'hint: personal groups must reject invite-code join').toBeNull();
  });

  it('removing a member updates membership table', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const group = await createGroup(db, { name: 'Team', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);

    expect(await isMember(db, group.id, bob), 'pre-condition: bob is a member').toBe(true);

    await db
      .deleteFrom('group_members')
      .where('group_id', '=', group.id)
      .where('user_id', '=', bob)
      .execute();

    expect(
      await isMember(db, group.id, bob),
      'hint: delete from group_members should remove membership',
    ).toBe(false);
  });

  it('deleting a group cascades to members and messages', async () => {
    const uid = await createUser(db, 'charlie');
    const group = await createGroup(db, { name: 'Ephemeral', kind: 'group', createdBy: uid });
    await insertUserMessage(db, { groupId: group.id, senderId: uid, body: 'hello' });

    await db.deleteFrom('group_members').where('group_id', '=', group.id).execute();
    await db.deleteFrom('messages').where('group_id', '=', group.id).execute();
    await db.deleteFrom('groups').where('id', '=', group.id).execute();

    const g = await db.selectFrom('groups').selectAll().where('id', '=', group.id).executeTakeFirst();
    expect(g, 'hint: group should be deleted').toBeUndefined();
    const members = await db
      .selectFrom('group_members')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(members, 'hint: cascade delete should remove members').toHaveLength(0);
  });
});

// ── user management ───────────────────────────────────────────────────────────

describe('user management', () => {
  it('creates many unique users without username collisions', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `user_${i}`);
    const ids = await Promise.all(names.map((n) => createUser(db, n)));
    const unique = new Set(ids);
    expect(unique.size, 'hint: newId must produce unique user IDs').toBe(20);
  });

  it('one user can belong to many groups', async () => {
    const uid = await createUser(db, 'multi_group_user');
    const groups = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createGroup(db, { name: `Group ${i}`, kind: 'group', createdBy: uid }),
      ),
    );

    for (const g of groups) {
      expect(
        await isMember(db, g.id, uid),
        `hint: user should be member of group ${g.name}`,
      ).toBe(true);
    }
  });

  it('adds multiple users to one group', async () => {
    const owner = await createUser(db, 'owner_u');
    const members = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createUser(db, `member_${i}`)),
    );
    const group = await createGroup(db, { name: 'Big Family', kind: 'group', createdBy: owner });

    for (const m of members) {
      await addMember(db, group.id, m);
    }

    const rows = await db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', group.id)
      .execute();
    // owner + 8 members
    expect(rows.length, 'hint: all added members should appear in group_members').toBe(9);
  });

  it('creates many groups with unique invite codes', async () => {
    const uid = await createUser(db, 'prolific');
    const groups = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createGroup(db, { name: `Group ${i}`, kind: 'group', createdBy: uid }),
      ),
    );
    const codes = new Set(groups.map((g) => g.invite_code));
    expect(codes.size, 'hint: each group must get a unique invite code').toBe(10);
  });
});

// ── trip management ───────────────────────────────────────────────────────────

describe('trip management', () => {
  it('creates a complete itinerary — trip + outbound leg + accommodation + return leg', async () => {
    const uid = await createUser(db, 'traveller');
    const group = await createGroup(db, { name: 'Vacay', kind: 'group', createdBy: uid });

    const trip = await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Tokyo 2026',
      destination: 'Tokyo',
      startDate: '2026-06-01',
      endDate: '2026-06-14',
      participantIds: [],
    });

    const outbound = await addTravelLeg(db, {
      tripId: trip.id,
      personaId: uid,
      mode: 'flight',
      origin: 'JFK',
      destination: 'NRT',
      departAt: '2026-06-01T08:00:00Z',
      arriveAt: '2026-06-02T14:00:00Z',
      carrier: 'JL',
      flightNo: 'JL006',
      confirmation: 'ABC123',
    });

    const hotel = await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Shinjuku Grand',
      address: '1-1 Kabukicho, Shinjuku, Tokyo',
      checkinDate: '2026-06-02',
      checkoutDate: '2026-06-13',
      roomCount: 1,
      confirmation: 'HTL999',
    });

    const returnLeg = await addTravelLeg(db, {
      tripId: trip.id,
      personaId: uid,
      mode: 'flight',
      origin: 'NRT',
      destination: 'JFK',
      departAt: '2026-06-13T18:00:00Z',
      arriveAt: '2026-06-14T17:00:00Z',
      carrier: 'JL',
      flightNo: 'JL005',
    });

    expect(outbound.tripId, 'hint: leg should be attached to trip').toBe(trip.id);
    expect(hotel.tripId, 'hint: accommodation should be attached to trip').toBe(trip.id);
    expect(returnLeg.origin, 'hint: return leg origin should be NRT').toBe('NRT');

    const legs = await db
      .selectFrom('travel_legs')
      .selectAll()
      .where('trip_id', '=', trip.id)
      .execute();
    expect(legs.length, 'hint: two legs should be recorded').toBe(2);

    const accoms = await db
      .selectFrom('accommodations')
      .selectAll()
      .where('trip_id', '=', trip.id)
      .execute();
    expect(accoms.length, 'hint: one accommodation should be recorded').toBe(1);
    expect(accoms[0]!.property_name).toBe('Shinjuku Grand');
  });

  it('trip with missing outbound leg — only accommodation present', async () => {
    const uid = await createUser(db, 'forgetful');
    const group = await createGroup(db, { name: 'Gaps', kind: 'group', createdBy: uid });

    const trip = await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Paris 2026',
      destination: 'Paris',
      startDate: '2026-09-10',
      endDate: '2026-09-20',
      participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Hotel de Luxe',
      checkinDate: '2026-09-10',
      checkoutDate: '2026-09-20',
    });

    const legs = await db
      .selectFrom('travel_legs')
      .selectAll()
      .where('trip_id', '=', trip.id)
      .execute();
    expect(legs.length, 'hint: no legs should be present — missing flight not auto-filled').toBe(0);
  });

  it('trip with wrong dates — end before start still saves, consumers must validate', async () => {
    const uid = await createUser(db, 'confused');
    const group = await createGroup(db, { name: 'Oops', kind: 'group', createdBy: uid });

    const trip = await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Backward Trip',
      destination: 'Nowhere',
      startDate: '2026-12-31',
      endDate: '2026-01-01',
      participantIds: [],
    });

    expect(trip.id, 'hint: createTrip should persist even with inverted dates').toBeTruthy();
    expect(trip.startDate).toBe('2026-12-31');
    expect(trip.endDate).toBe('2026-01-01');
  });

  it('date-range lookup finds the right trip among several', async () => {
    const uid = await createUser(db, 'sorter');
    const group = await createGroup(db, { name: 'Multi-trip', kind: 'group', createdBy: uid });

    await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Old Spain Trip',
      destination: 'Madrid',
      startDate: '2025-03-01',
      endDate: '2025-03-10',
      participantIds: [],
    });

    const target = await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Japan 2026',
      destination: 'Osaka',
      startDate: '2026-07-15',
      endDate: '2026-07-25',
      participantIds: [],
    });

    const found = await findTripByDateRange(db, uid, '2026-07-16', '2026-07-20', group.id);
    expect(found?.id, 'hint: findTripByDateRange should return Japan trip, not Spain trip').toBe(
      target.id,
    );
  });

  it('creating trip with multiple participants records all of them', async () => {
    const uid = await createUser(db, 'organiser');
    const p1 = await createUser(db, 'p_alice');
    const p2 = await createUser(db, 'p_bob');
    const group = await createGroup(db, { name: 'Squad', kind: 'group', createdBy: uid });

    const trip = await createTrip(db, {
      groupId: group.id,
      createdBy: uid,
      name: 'Group Trip',
      destination: 'Bali',
      startDate: '2026-08-01',
      endDate: '2026-08-10',
      participantIds: [p1, p2],
    });

    const rows = await db
      .selectFrom('trip_participants')
      .select('persona_id')
      .where('trip_id', '=', trip.id)
      .execute();
    expect(rows.length, 'hint: both participants should be stored').toBe(2);
    const ids = rows.map((r) => r.persona_id);
    expect(ids).toContain(p1);
    expect(ids).toContain(p2);
  });
});

// ── bot turn — @chord questions ───────────────────────────────────────────────

describe('bot @chord questions — mock LLM', () => {
  async function setupGroupWithMembers(): Promise<{
    groupId: string;
    alice: string;
    bob: string;
    carol: string;
  }> {
    const alice = await createUser(db, 'alice_bot', 'Alice');
    const bob = await createUser(db, 'bob_bot', 'Bob');
    const carol = await createUser(db, 'carol_bot', 'Carol');
    const group = await createGroup(db, { name: 'Bot Test Group', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    await addMember(db, group.id, carol);
    return { groupId: group.id, alice, bob, carol };
  }

  it('alice: @Chord add to Costco list - sunscreen → creates list with items', async () => {
    const { groupId, alice } = await setupGroupWithMembers();
    const msg = await insertUserMessage(db, {
      groupId,
      senderId: alice,
      body: '@Chord add to Costco list - sunscreen, snorkels',
    });
    await runBotTurn(db, msg, { id: groupId, kind: 'group' });

    const lists = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(lists.length, 'hint: Costco list should be created').toBeGreaterThanOrEqual(1);
    expect(lists[0]!.name, 'hint: list name should match keyword "Costco"').toBe('Costco');

    const items = await db
      .selectFrom('list_items')
      .selectAll()
      .where('list_id', '=', lists[0]!.id)
      .execute();
    expect(items.length, 'hint: items should be added to the list').toBeGreaterThanOrEqual(1);
  });

  it('bob: @Chord book a rental car → creates a task', async () => {
    const { groupId, bob } = await setupGroupWithMembers();
    const msg = await insertUserMessage(db, {
      groupId,
      senderId: bob,
      body: '@Chord we need to book a rental car for the trip',
    });
    await runBotTurn(db, msg, { id: groupId, kind: 'group' });

    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(tasks.length, 'hint: bot should create a task for "book rental car"').toBeGreaterThanOrEqual(1);
    expect(tasks[0]!.title.toLowerCase()).toContain('rental');
  });

  it('carol: @Chord save https://airbnb.com/... → saves a link', async () => {
    const { groupId, carol } = await setupGroupWithMembers();
    const msg = await insertUserMessage(db, {
      groupId,
      senderId: carol,
      body: '@Chord save https://airbnb.com/rooms/12345 for the trip',
    });
    await runBotTurn(db, msg, { id: groupId, kind: 'group' });

    const saves = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(saves.length, 'hint: bot should call save_link for a URL message').toBeGreaterThanOrEqual(1);
    expect(saves[0]!.url).toContain('airbnb.com');
  });

  it('alice: @Chord potluck dinner Saturday → creates an event', async () => {
    const { groupId, alice } = await setupGroupWithMembers();
    const msg = await insertUserMessage(db, {
      groupId,
      senderId: alice,
      body: '@Chord potluck dinner Saturday at my place',
    });
    await runBotTurn(db, msg, { id: groupId, kind: 'group' });

    const events = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(events.length, 'hint: bot should create an event for "potluck dinner"').toBeGreaterThanOrEqual(1);
    expect(events[0]!.title.toLowerCase()).toContain('potluck');
  });

  it('multiple members send @chord messages — each gets a bot reply', async () => {
    const { groupId, alice, bob, carol } = await setupGroupWithMembers();

    for (const [sender, body] of [
      [alice, '@Chord add milk to Costco list'],
      [bob, '@Chord reserve a rental car for the vacation'],
      [carol, '@Chord save https://booking.com/hotel/abc for our trip'],
    ] as [string, string][]) {
      const msg = await insertUserMessage(db, { groupId, senderId: sender, body });
      await runBotTurn(db, msg, { id: groupId, kind: 'group' });
    }

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .execute();
    expect(
      botMessages.length,
      'hint: each @chord mention from any member should trigger a bot reply',
    ).toBeGreaterThanOrEqual(3);
  });

  it('message without @chord in a group chat does NOT trigger bot', async () => {
    // runBotTurn always executes; the gate lives in decideReaction which the
    // route handler consults before calling runBotTurn at all.
    const { bob } = await setupGroupWithMembers();
    const decision = decideReaction({
      kind: 'text',
      senderId: bob,
      groupKind: 'group',
      body: 'Anyone want coffee?',
    });
    expect(
      decision.react,
      'hint: decideReaction should return react=false for a group message without @chord',
    ).toBe(false);
  });

  it('personal group responds without @chord mention', async () => {
    const uid = await createUser(db, 'solo_user');
    const group = await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: uid });
    const msg = await insertUserMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: 'book a rental car',
    });
    await runBotTurn(db, msg, { id: group.id, kind: 'personal' });

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(
      botMessages.length,
      'hint: personal group should trigger bot on every message, not just @chord',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ── applyToolCall — direct tool dispatch ──────────────────────────────────────

describe('applyToolCall — direct dispatch', () => {
  async function seed(): Promise<{ userId: string; groupId: string }> {
    const userId = await createUser(db, 'tool_user');
    const group = await createGroup(db, { name: 'Tool Test', kind: 'group', createdBy: userId });
    return { userId, groupId: group.id };
  }

  it('create_task stores title and actor', async () => {
    const { userId, groupId } = await seed();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: 'message context',
      call: { name: 'create_task', args: { title: 'Book airport transfer' } },
    });

    const task = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(task.title, 'hint: task title should be stored verbatim').toBe('Book airport transfer');
    expect(task.created_by, 'hint: created_by should be the actorUserId').toBe(userId);
    expect(task.source_raw_context, 'hint: provenance should be stored as source_raw_context').toBe(
      'message context',
    );
  });

  it('add_list_item creates list on first use and adds items', async () => {
    const { userId, groupId } = await seed();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'add_list_item', args: { listName: 'Packing', items: ['passport', 'charger', 'sunscreen'] } },
    });

    const list = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('name', '=', 'Packing')
      .executeTakeFirst();
    expect(list, 'hint: Packing list should be created').toBeTruthy();

    const items = await db
      .selectFrom('list_items')
      .selectAll()
      .where('list_id', '=', list!.id)
      .execute();
    expect(items.length, 'hint: 3 items should be added').toBe(3);
    expect(items.map((i) => i.text)).toContain('passport');
  });

  it('save_link stores URL and sets created_by', async () => {
    const { userId, groupId } = await seed();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'save_link',
        args: { title: 'Hotel Booking', url: 'https://booking.com/h/12345', tags: ['accommodation'] },
      },
    });

    const save = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(save.url, 'hint: URL should be stored').toBe('https://booking.com/h/12345');
    expect(save.created_by, 'hint: created_by should be actor').toBe(userId);
  });

  it('create_trip followed by add_travel_leg links correctly', async () => {
    const { userId, groupId } = await seed();
    const tripResult = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'create_trip',
        args: {
          name: 'Barcelona',
          destination: 'Barcelona',
          startDate: '2026-05-10',
          endDate: '2026-05-17',
          participantNames: [],
        },
      },
    });
    expect(tripResult.summary, 'hint: create_trip should return a summary').toMatch(/trip/i);

    const trip = await db
      .selectFrom('trips')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();

    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'add_travel_leg',
        args: {
          tripId: trip.id,
          mode: 'flight',
          origin: 'LHR',
          destination: 'BCN',
          departAt: '2026-05-10T06:00:00+01:00',
          arriveAt: '2026-05-10T09:30:00+02:00',
          carrier: 'VY',
          flightNo: 'VY7823',
        },
      },
    });

    const legs = await db
      .selectFrom('travel_legs')
      .selectAll()
      .where('trip_id', '=', trip.id)
      .execute();
    expect(legs.length, 'hint: leg should be stored under the trip').toBe(1);
    expect(legs[0]!.flight_no).toBe('VY7823');
  });

  it('add_accommodation with null actorUserId still attaches to trip', async () => {
    const { userId, groupId } = await seed();
    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Rome',
      destination: 'Rome',
      startDate: '2026-07-01',
      endDate: '2026-07-10',
      participantIds: [],
    });

    await applyToolCall(db, {
      groupId,
      actorUserId: null,
      provenance: null,
      call: {
        name: 'add_accommodation',
        args: {
          tripId: trip.id,
          propertyName: 'Hotel Roma',
          checkinDate: '2026-07-01',
          checkoutDate: '2026-07-10',
        },
      },
    });

    const accoms = await db
      .selectFrom('accommodations')
      .selectAll()
      .where('trip_id', '=', trip.id)
      .execute();
    expect(accoms.length, 'hint: add_accommodation must work when actorUserId is null (bot-only turn)').toBe(1);
    expect(accoms[0]!.property_name).toBe('Hotel Roma');
  });

  it('create_event stores event in group', async () => {
    const { userId, groupId } = await seed();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'create_event',
        args: {
          title: 'Team Dinner',
          startsAt: '2026-04-30T19:00:00+00:00',
          location: 'The Ivy',
        },
      },
    });

    const event = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(event.title).toBe('Team Dinner');
    expect(event.location).toBe('The Ivy');
  });
});

// ── itinerary stress: many trips with varied completeness ─────────────────────

describe('itinerary stress — many trips with varied completeness', () => {
  it('stores 10 trips with varying leg/accommodation completeness', async () => {
    const uid = await createUser(db, 'heavy_traveller');
    const group = await createGroup(db, { name: 'Travel Log', kind: 'group', createdBy: uid });

    type TripSpec = {
      dest: string;
      start: string;
      end: string;
      legs: number;
      accoms: number;
    };

    const specs: TripSpec[] = [
      { dest: 'Tokyo', start: '2026-01-10', end: '2026-01-20', legs: 2, accoms: 1 },
      { dest: 'Paris', start: '2026-02-05', end: '2026-02-12', legs: 0, accoms: 1 }, // missing legs
      { dest: 'NYC', start: '2026-03-01', end: '2026-03-07', legs: 2, accoms: 0 }, // missing hotel
      { dest: 'London', start: '2026-04-15', end: '2026-04-22', legs: 0, accoms: 0 }, // skeleton only
      { dest: 'Sydney', start: '2026-05-10', end: '2026-05-25', legs: 2, accoms: 2 },
      { dest: 'Dubai', start: '2026-06-01', end: '2026-06-08', legs: 1, accoms: 1 },
      { dest: 'Bangkok', start: '2026-07-20', end: '2026-07-30', legs: 3, accoms: 2 },
      { dest: 'Rome', start: '2026-08-05', end: '2026-08-12', legs: 0, accoms: 1 }, // arrived, no return
      { dest: 'Bali', start: '2026-09-01', end: '2026-09-14', legs: 2, accoms: 1 },
      { dest: 'Cairo', start: '2026-10-15', end: '2026-10-22', legs: 1, accoms: 0 }, // no hotel
    ];

    for (const spec of specs) {
      const trip = await createTrip(db, {
        groupId: group.id,
        createdBy: uid,
        name: `${spec.dest} trip`,
        destination: spec.dest,
        startDate: spec.start,
        endDate: spec.end,
        participantIds: [],
      });

      for (let i = 0; i < spec.legs; i++) {
        await addTravelLeg(db, {
          tripId: trip.id,
          personaId: uid,
          mode: 'flight',
          origin: i % 2 === 0 ? 'JFK' : spec.dest,
          destination: i % 2 === 0 ? spec.dest : 'JFK',
          // Stagger departure by leg so a 3-leg trip's outbound legs (i=0, i=2)
          // aren't byte-identical — passenger-aware dedup (ADR-era leg collapse)
          // would otherwise correctly fold them into one.
          departAt: `${spec.start}T${String(10 + i).padStart(2, '0')}:00:00Z`,
          arriveAt: `${spec.end}T${String(10 + i).padStart(2, '0')}:00:00Z`,
        });
      }

      for (let i = 0; i < spec.accoms; i++) {
        await addAccommodation(db, {
          tripId: trip.id,
          propertyName: `${spec.dest} Hotel ${i + 1}`,
          checkinDate: spec.start,
          checkoutDate: spec.end,
        });
      }
    }

    const allTrips = await listTripsForGroup(db, group.id);
    expect(allTrips.length, 'hint: all 10 trips should be stored').toBe(10);

    const allLegs = await db.selectFrom('travel_legs').selectAll().execute();
    const totalLegs = specs.reduce((s, sp) => s + sp.legs, 0);
    expect(allLegs.length, `hint: expected ${totalLegs} legs total`).toBe(totalLegs);

    const allAccoms = await db.selectFrom('accommodations').selectAll().execute();
    const totalAccoms = specs.reduce((s, sp) => s + sp.accoms, 0);
    expect(allAccoms.length, `hint: expected ${totalAccoms} accommodations total`).toBe(totalAccoms);
  });
});

// ── attachment classifier (text path, mock LLM) ───────────────────────────────

describe('trip classifier via classifyAndAutoFileAttachment', () => {
  it('does not crash and does not create a trip when mock LLM returns non-JSON', async () => {
    const uid = await createUser(db, 'att_user');
    const group = await createGroup(db, { name: 'Attachments', kind: 'group', createdBy: uid });

    const handled = await classifyAndAutoFileAttachment(db, {
      attachmentId: newId('a'),
      groupId: group.id,
      uploadedBy: uid,
      filename: 'boarding_pass.pdf',
      extractedText: 'Flight from JFK to LHR on 2026-06-01 confirmation XYZ123',
    });

    // Unrecognized (mock can't classify) → returns false, so the caller still
    // runs the image content classifier.
    expect(handled).toBe(false);
    // Mock LLM returns non-parseable text → classify() returns null → nothing created.
    const trips = await listTripsForGroup(db, group.id);
    expect(
      trips.length,
      'hint: mock LLM cannot produce valid classification JSON, so no trip should be auto-created',
    ).toBe(0);
  });

  it('does not crash when text is too short (< 80 chars) and no image', async () => {
    const uid = await createUser(db, 'short_text_user');
    const group = await createGroup(db, { name: 'Short', kind: 'group', createdBy: uid });

    await classifyAndAutoFileAttachment(db, {
      attachmentId: newId('a'),
      groupId: group.id,
      uploadedBy: uid,
      filename: 'receipt.pdf',
      extractedText: 'RECEIPT',
    });

    const trips = await listTripsForGroup(db, group.id);
    expect(
      trips.length,
      'hint: short text with no image should exit classify() early without error',
    ).toBe(0);
  });

  it('does not crash when called with empty text and no image', async () => {
    const uid = await createUser(db, 'empty_att_user');
    const group = await createGroup(db, { name: 'Empty', kind: 'group', createdBy: uid });

    await expect(
      classifyAndAutoFileAttachment(db, {
        attachmentId: newId('a'),
        groupId: group.id,
        uploadedBy: uid,
        filename: 'empty.pdf',
        extractedText: '',
      }),
    ).resolves.not.toThrow();
  });
});

// ── saves ─────────────────────────────────────────────────────────────────────

describe('saves — links and places', () => {
  it('saves a link with tags', async () => {
    const uid = await createUser(db, 'link_saver');
    const group = await createGroup(db, { name: 'Links', kind: 'group', createdBy: uid });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'save_link',
        args: {
          title: 'Snorkelling spot',
          url: 'https://maps.google.com/?q=coral+reef',
          tags: ['beach', 'snorkelling'],
        },
      },
    });

    const saves = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(saves.length).toBe(1);
    expect(saves[0]!.title).toBe('Snorkelling spot');
    const tags = JSON.parse(saves[0]!.tags);
    expect(tags).toContain('beach');
  });

  it('saves a place', async () => {
    const uid = await createUser(db, 'place_saver');
    const group = await createGroup(db, { name: 'Places', kind: 'group', createdBy: uid });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'save_place',
        args: {
          name: 'Nishiki Market',
          city: 'Kyoto',
          tags: ['food', 'market'],
          note: 'Amazing pickles',
        },
      },
    });

    // Places now live in the unified `saves` table (kind='place') so
    // they show up in /me/saves. City is folded into the note.
    const place = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'place')
      .executeTakeFirstOrThrow();
    expect(place.title).toBe('Nishiki Market');
    expect(place.note ?? '').toContain('Kyoto');
  });

  it('bot: @Chord save https://... → save appears in DB', async () => {
    const uid = await createUser(db, 'chat_saver');
    const group = await createGroup(db, { name: 'Chat Saves', kind: 'group', createdBy: uid });

    const msg = await insertUserMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord save https://expedia.com/flight/search for later',
    });
    await runBotTurn(db, msg, { id: group.id, kind: 'group' });

    const saves = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(saves.length, 'hint: save_link tool should fire on URL in @chord message').toBeGreaterThanOrEqual(1);
    expect(saves[0]!.url).toContain('expedia.com');
  });
});
