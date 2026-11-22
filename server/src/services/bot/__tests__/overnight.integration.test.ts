/**
 * Overnight bot smoke suite — every write tool exercised via a full
 * runBotTurn call against a per-test Postgres database.
 *
 * Each test wires a deterministic LLM response (tool-fence JSON) through
 * vi.hoisted mock state, runs the complete bot pipeline, then asserts
 * the resulting database state.
 *
 * Coverage:
 *   lists      — grocery, Costco, packing, add-to-existing, notes list
 *   tasks      — basic, reminder, assignee, due-date
 *   saves      — link, place, media (book/podcast/movie), contact
 *   events     — create, RSVP (yes+dish, no, maybe)
 *   trips      — create, add_travel_leg (flight/train/car), add_accommodation,
 *                add_reservation (restaurant/activity), get_trip_status
 *   multi-trip — two trips with overlapping date ranges under same header key;
 *                two trips with distinct date ranges
 *   deletion   — DB-level trip removal + cascade (no bot delete_trip tool yet)
 *   resilience — malformed tool args skipped; valid sibling tool still fires
 */

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import {
  closeTestDb,
  createUser,
  fence,
  insertMessage,
  openTestDb,
} from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { createTrip } from '@/services/trips.service.js';
import { setGrant } from '@/services/trust.service.js';

// ── mock LLM ─────────────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => ({ response: '' }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'overnight-mock',
    defaultModel: 'overnight-mock',
    supportsNativeTools: false,
    // complete() is used for memory extraction; return an empty array so
    // the extraction layer parses cleanly without us also having to encode
    // a valid memory shape into mockState.response.
    complete: async () => '[]',
    async *stream() {
      yield { type: 'text', delta: mockState.response };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

// ── helpers ───────────────────────────────────────────────────────────────────

const botMsg = (db: Kysely<DB>, groupId: string, senderId: string, body: string) =>
  insertMessage(db, { groupId, senderId, body, mentionsBot: true });

/** `create_event` refuses a start that has already passed, so event fixtures
 *  have to be relative — a hardcoded date silently stops writing once it rots
 *  past today. */
const soon = (days = 14): string =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

// ── fixtures ──────────────────────────────────────────────────────────────────

let db: Kysely<DB>;
let uid: string;
let gid: string;

beforeEach(async () => {
  db = await openTestDb();
  uid = await createUser(db, 'overnight_user', 'Test User');
  const group = await createGroup(db, { name: 'Overnight Test', kind: 'group', createdBy: uid });
  gid = group.id;
  mockState.response = '';
});

afterEach(async () => {
  await closeTestDb(db);
});

// ── lists ─────────────────────────────────────────────────────────────────────

describe('lists', () => {
  it('@Chord add to grocery list - milk, eggs, butter', async () => {
    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Grocery', items: ['milk', 'eggs', 'butter'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord add milk, eggs, butter to grocery list');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const list = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', gid)
      .where('name', '=', 'Grocery')
      .executeTakeFirst();
    expect(list, 'Grocery list should be created').toBeTruthy();

    const items = await db
      .selectFrom('list_items')
      .selectAll()
      .where('list_id', '=', list!.id)
      .execute();
    expect(items.length).toBe(3);
    expect(items.map((i) => i.text)).toContain('milk');
  });

  it('@Chord add to Costco list - sunscreen, towels', async () => {
    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Costco', items: ['sunscreen', 'towels'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord add sunscreen and towels to Costco run');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const list = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'Costco')
      .selectAll()
      .executeTakeFirst();
    expect(list).toBeTruthy();
    const items = await db
      .selectFrom('list_items')
      .where('list_id', '=', list!.id)
      .selectAll()
      .execute();
    expect(items.length).toBe(2);
  });

  it('@Chord packing list - passport, charger, adaptor', async () => {
    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Packing', items: ['passport', 'charger', 'adaptor'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord start a packing list - passport, charger, adaptor');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const list = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'Packing')
      .selectAll()
      .executeTakeFirst();
    expect(list).toBeTruthy();
    const items = await db
      .selectFrom('list_items')
      .where('list_id', '=', list!.id)
      .selectAll()
      .execute();
    expect(items.length).toBe(3);
    expect(items.map((i) => i.text)).toContain('passport');
  });

  it('adding to existing list merges items, not duplicate lists', async () => {
    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Grocery', items: ['bread'] },
    });
    const msg1 = await botMsg(db, gid, uid, '@Chord add bread to grocery list');
    await runBotTurn(db, msg1, { id: gid, kind: 'group' });

    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Grocery', items: ['cheese', 'yogurt'] },
    });
    const msg2 = await botMsg(db, gid, uid, '@Chord also add cheese and yogurt');
    await runBotTurn(db, msg2, { id: gid, kind: 'group' });

    const lists = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'Grocery')
      .selectAll()
      .execute();
    expect(lists.length, 'should be exactly one Grocery list, not two').toBe(1);

    const items = await db
      .selectFrom('list_items')
      .where('list_id', '=', lists[0]!.id)
      .selectAll()
      .execute();
    expect(items.length, '3 items total across both messages').toBe(3);
  });

  it('@Chord notes list - call dentist, renew passport', async () => {
    mockState.response = fence({
      name: 'add_list_item',
      args: { listName: 'Notes', items: ['call dentist', 'renew passport'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord add to notes: call dentist, renew passport');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const list = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'Notes')
      .selectAll()
      .executeTakeFirst();
    expect(list).toBeTruthy();
  });
});

// ── tasks / reminders ─────────────────────────────────────────────────────────

describe('tasks and reminders', () => {
  it('@Chord remind me to confirm flights next Monday', async () => {
    mockState.response = fence({
      name: 'create_task',
      args: { title: 'Confirm flights', remindCue: 'next Monday' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord remind me to confirm flights next Monday');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const tasks = await db
      .selectFrom('tasks')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title).toContain('Confirm flights');
    expect(tasks[0]!.remind_cue).toBe('next Monday');
  });

  it('@Chord book rental car — assigned to Bob', async () => {
    const bob = await createUser(db, 'bob_task', 'Bob');
    await db.insertInto('group_members').values({
      group_id: gid, user_id: bob, role: 'member', tier: 'trusted', joined_at: new Date().toISOString(),
    }).execute();
    // ADR 0026 — assignment is closed by default; Bob must grant the
    // triggering user trust before the bot's create_task can land on him.
    await setGrant(db, bob, uid, ['task']);

    mockState.response = fence({
      name: 'create_task',
      args: { title: 'Book rental car', assigneeName: 'Bob' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord Bob should book the rental car');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const tasks = await db
      .selectFrom('tasks')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title.toLowerCase()).toContain('rental');
  });

  it('@Chord task with due date', async () => {
    mockState.response = fence({
      name: 'create_task',
      args: { title: 'Submit travel forms', dueAt: '2026-07-01T09:00:00+00:00' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord remind me to submit travel forms by July 1');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const tasks = await db
      .selectFrom('tasks')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.due_at).toBeTruthy();
  });

  it('@Chord multiple reminders in one message — two tasks created', async () => {
    mockState.response = fence(
      { name: 'create_task', args: { title: 'Book airport parking' } },
      { name: 'create_task', args: { title: 'Print boarding passes', remindCue: 'night before' } },
    );
    const msg = await botMsg(db, gid, uid, '@Chord book airport parking and print boarding passes the night before');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const tasks = await db
      .selectFrom('tasks')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(tasks.length).toBe(2);
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain('Book airport parking');
    expect(titles).toContain('Print boarding passes');
  });
});

// ── saves ─────────────────────────────────────────────────────────────────────

describe('saves', () => {
  it('@Chord save link', async () => {
    mockState.response = fence({
      name: 'save_link',
      args: { title: 'Airbnb Chicago', url: 'https://airbnb.com/rooms/99999', tags: ['accommodation'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save https://airbnb.com/rooms/99999 for the trip');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const saves = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(saves.length).toBe(1);
    expect(saves[0]!.url).toContain('airbnb.com');
    expect(JSON.parse(saves[0]!.tags)).toContain('accommodation');
  });

  it('@Chord save place - Nishiki Market, Kyoto', async () => {
    mockState.response = fence({
      name: 'save_place',
      args: { name: 'Nishiki Market', city: 'Kyoto', tags: ['food', 'market'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save Nishiki Market in Kyoto - must visit');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    // Places now route through the unified `saves` table (kind='place').
    const places = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .where('kind', '=', 'place')
      .selectAll()
      .execute();
    expect(places.length).toBe(1);
    expect(places[0]!.title).toBe('Nishiki Market');
    expect(places[0]!.note ?? '').toContain('Kyoto');
  });

  it('@Chord save a book', async () => {
    mockState.response = fence({
      name: 'save_media',
      args: { kind: 'book', title: 'The Overstory', note: 'Recommended by Carol' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save book: The Overstory by Richard Powers');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const media = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .where('kind', '=', 'media')
      .selectAll()
      .execute();
    expect(media.length).toBe(1);
    expect(media[0]!.title).toBe('The Overstory');
    expect(JSON.parse(media[0]!.tags)).toContain('book');
  });

  it('@Chord save a podcast', async () => {
    mockState.response = fence({
      name: 'save_media',
      args: { kind: 'podcast', title: 'Conan O\'Brien Needs A Friend' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save podcast Conan O\'Brien Needs A Friend');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const media = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .where('kind', '=', 'media')
      .selectAll()
      .execute();
    expect(media.length).toBe(1);
    expect(JSON.parse(media[0]!.tags)).toContain('podcast');
  });

  it('@Chord save a movie', async () => {
    mockState.response = fence({
      name: 'save_media',
      args: { kind: 'movie', title: 'Everything Everywhere All at Once', note: 'Watch together' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save movie: Everything Everywhere All at Once');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const media = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .where('kind', '=', 'media')
      .selectAll()
      .execute();
    expect(media[0]!.title).toContain('Everything');
    expect(JSON.parse(media[0]!.tags)).toContain('movie');
  });

  it('@Chord save contact - Dr. Patel, dentist', async () => {
    mockState.response = fence({
      name: 'save_contact',
      args: { name: 'Dr. Patel', org: 'Smile Dental', tags: ['dentist', 'health'] },
    });
    const msg = await botMsg(db, gid, uid, '@Chord save Dr. Patel from Smile Dental');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    // Contacts now live in the unified `saves` table (kind='contact');
    // the `org` collapses into the note line.
    const contacts = await db
      .selectFrom('saves')
      .where('group_id', '=', gid)
      .where('kind', '=', 'contact')
      .selectAll()
      .execute();
    expect(contacts.length).toBe(1);
    expect(contacts[0]!.title).toBe('Dr. Patel');
    expect(contacts[0]!.note ?? '').toContain('Smile Dental');
  });
});

// ── events ────────────────────────────────────────────────────────────────────

describe('events', () => {
  it('@Chord create an event - July 4th cookout', async () => {
    mockState.response = fence({
      name: 'create_event',
      args: {
        title: 'July 4th Cookout',
        startsAt: `${soon()}T17:00:00+00:00`,
        location: 'Backyard',
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord July 4th cookout at 5pm in the backyard');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const events = await db
      .selectFrom('events')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(events.length).toBe(1);
    expect(events[0]!.title).toBe('July 4th Cookout');
    expect(events[0]!.location).toBe('Backyard');
  });

  it('@Chord RSVP yes to cookout — with dish', async () => {
    // First create an event directly.
    const eventId = newId('e');
    await db.insertInto('events').values({
      id: eventId,
      group_id: gid,
      title: 'Potluck',
      starts_at: '2026-08-15T18:00:00Z',
      location: null,
      created_by: uid,
      created_at: new Date().toISOString(),
    }).execute();

    mockState.response = fence({
      name: 'record_rsvp',
      args: { eventId, displayName: 'Test User', status: 'yes', dish: 'biryani' },
    });
    const msg = await botMsg(db, gid, uid, '@Chord RSVP yes to potluck, bringing biryani');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const rsvps = await db
      .selectFrom('rsvps')
      .where('event_id', '=', eventId)
      .selectAll()
      .execute();
    expect(rsvps.length).toBe(1);
    expect(rsvps[0]!.status).toBe('yes');
    expect(rsvps[0]!.dish).toBe('biryani');
  });

  it('@Chord RSVP no to event', async () => {
    const eventId = newId('e');
    await db.insertInto('events').values({
      id: eventId,
      group_id: gid,
      title: 'Book Club',
      starts_at: '2026-09-05T19:00:00Z',
      location: null,
      created_by: uid,
      created_at: new Date().toISOString(),
    }).execute();

    mockState.response = fence({
      name: 'record_rsvp',
      args: { eventId, displayName: 'Test User', status: 'no' },
    });
    const msg = await botMsg(db, gid, uid, "@Chord can't make book club");
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const rsvp = await db
      .selectFrom('rsvps')
      .where('event_id', '=', eventId)
      .selectAll()
      .executeTakeFirst();
    expect(rsvp?.status).toBe('no');
  });

  it('@Chord RSVP upserts — sending yes then maybe ends up as maybe', async () => {
    const eventId = newId('e');
    await db.insertInto('events').values({
      id: eventId,
      group_id: gid,
      title: 'Game Night',
      starts_at: '2026-10-10T20:00:00Z',
      location: null,
      created_by: uid,
      created_at: new Date().toISOString(),
    }).execute();

    mockState.response = fence({
      name: 'record_rsvp',
      args: { eventId, displayName: 'Test User', status: 'yes' },
    });
    await runBotTurn(db, await botMsg(db, gid, uid, '@Chord yes to game night'), { id: gid, kind: 'group' });

    mockState.response = fence({
      name: 'record_rsvp',
      args: { eventId, displayName: 'Test User', status: 'maybe' },
    });
    await runBotTurn(db, await botMsg(db, gid, uid, '@Chord actually maybe for game night'), { id: gid, kind: 'group' });

    const rsvps = await db
      .selectFrom('rsvps')
      .where('event_id', '=', eventId)
      .selectAll()
      .execute();
    expect(rsvps.length, 'upsert should produce exactly one RSVP row').toBe(1);
    expect(rsvps[0]!.status).toBe('maybe');
  });
});

// ── trips ─────────────────────────────────────────────────────────────────────

describe('trips', () => {
  it('@Chord create trip — Chicago July 4th', async () => {
    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'Chicago July 4th',
        destination: 'Chicago',
        startDate: '2026-07-03',
        endDate: '2026-07-06',
        participantNames: [],
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord we\'re going to Chicago for July 4th, July 3-6');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length).toBe(1);
    expect(trips[0]!.name).toBe('Chicago July 4th');
    expect(trips[0]!.destination).toBe('Chicago');
    expect(trips[0]!.start_date).toBe('2026-07-03');
    expect(trips[0]!.end_date).toBe('2026-07-06');
  });

  it('@Chord add flight leg to existing trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Chicago July 4th',
      destination: 'Chicago',
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_travel_leg',
      args: {
        tripId: trip.id,
        mode: 'flight',
        origin: 'JFK',
        destination: 'ORD',
        departAt: '2026-07-03T08:00:00+00:00',
        arriveAt: '2026-07-03T10:30:00+00:00',
        carrier: 'AA',
        flightNo: 'AA123',
        confirmation: 'XYZ789',
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord AA123 JFK→ORD July 3rd 8am');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const legs = await db
      .selectFrom('travel_legs')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .execute();
    expect(legs.length).toBe(1);
    expect(legs[0]!.flight_no).toBe('AA123');
    expect(legs[0]!.origin).toBe('JFK');
    expect(legs[0]!.destination).toBe('ORD');
    expect(legs[0]!.confirmation).toBe('XYZ789');
  });

  it('@Chord add train leg to trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'NYC Weekend',
      destination: 'New York',
      startDate: '2026-08-14',
      endDate: '2026-08-16',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_travel_leg',
      args: {
        tripId: trip.id,
        mode: 'train',
        origin: 'BOS',
        destination: 'NYP',
        departAt: '2026-08-14T07:00:00+00:00',
        arriveAt: '2026-08-14T11:00:00+00:00',
        carrier: 'Amtrak',
        confirmation: 'AMTRAK42',
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord Amtrak BOS to Penn Station August 14');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const legs = await db
      .selectFrom('travel_legs')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .execute();
    expect(legs.length).toBe(1);
    expect(legs[0]!.mode).toBe('train');
    expect(legs[0]!.carrier).toBe('Amtrak');
  });

  it('@Chord add car leg to trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Road Trip',
      destination: 'Nashville',
      startDate: '2026-09-05',
      endDate: '2026-09-07',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_travel_leg',
      args: {
        tripId: trip.id,
        mode: 'car',
        origin: 'Chicago',
        destination: 'Nashville',
        departAt: '2026-09-05T06:00:00+00:00',
        arriveAt: '2026-09-05T12:00:00+00:00',
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord driving Chicago to Nashville September 5th');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const legs = await db
      .selectFrom('travel_legs')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .execute();
    expect(legs.length).toBe(1);
    expect(legs[0]!.mode).toBe('car');
  });

  it('@Chord add hotel/accommodation to trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Chicago July 4th',
      destination: 'Chicago',
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_accommodation',
      args: {
        tripId: trip.id,
        propertyName: 'Marriott Chicago',
        checkinDate: '2026-07-03',
        checkoutDate: '2026-07-06',
        confirmation: 'HTL777',
        roomCount: 2,
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord booked Marriott Chicago July 3-6, conf HTL777');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const accoms = await db
      .selectFrom('accommodations')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .execute();
    expect(accoms.length).toBe(1);
    expect(accoms[0]!.property_name).toBe('Marriott Chicago');
    expect(accoms[0]!.confirmation).toBe('HTL777');
    expect(accoms[0]!.room_count).toBe(2);
  });

  it('@Chord add restaurant reservation to trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Chicago July 4th',
      destination: 'Chicago',
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_reservation',
      args: {
        tripId: trip.id,
        kind: 'restaurant',
        name: 'Girl & The Goat',
        dateTime: '2026-07-04T19:30:00+00:00',
        confirmation: 'RES001',
        notes: 'Birthday celebration',
      },
    });
    const msg = await botMsg(db, gid, uid, "@Chord dinner at Girl & The Goat July 4th 7:30pm");
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const reservations = await db
      .selectFrom('trip_reservations')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .execute();
    expect(reservations.length).toBe(1);
    expect(reservations[0]!.name).toBe('Girl & The Goat');
    expect(reservations[0]!.kind).toBe('restaurant');
    expect(reservations[0]!.notes).toBe('Birthday celebration');
  });

  it('@Chord add activity reservation to trip', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Tokyo 2026',
      destination: 'Tokyo',
      startDate: '2026-10-10',
      endDate: '2026-10-20',
      participantIds: [],
    });

    mockState.response = fence({
      name: 'add_reservation',
      args: {
        tripId: trip.id,
        kind: 'activity',
        name: 'TeamLab Planets',
        dateTime: '2026-10-15T14:00:00+09:00',
        confirmation: 'TL9999',
      },
    });
    const msg = await botMsg(db, gid, uid, '@Chord booked TeamLab Planets October 15');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const res = await db
      .selectFrom('trip_reservations')
      .where('trip_id', '=', trip.id)
      .selectAll()
      .executeTakeFirst();
    expect(res?.name).toBe('TeamLab Planets');
    expect(res?.kind).toBe('activity');
  });

  it('@Chord create trip then immediately add flight — single message', async () => {
    mockState.response = fence(
      {
        name: 'create_trip',
        args: {
          name: 'Austin SXSW',
          destination: 'Austin',
          startDate: '2027-03-07',
          endDate: '2027-03-15',
          participantNames: [],
        },
      },
      {
        name: 'add_travel_leg',
        args: {
          mode: 'flight',
          origin: 'ORD',
          destination: 'AUS',
          departAt: '2027-03-07T10:00:00+00:00',
          arriveAt: '2027-03-07T12:30:00+00:00',
          carrier: 'UA',
          flightNo: 'UA500',
        },
      },
    );
    const msg = await botMsg(
      db, gid, uid,
      '@Chord SXSW March 7-15, flying ORD→AUS UA500',
    );
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length).toBe(1);
    expect(trips[0]!.destination).toBe('Austin');

    const legs = await db
      .selectFrom('travel_legs')
      .where('trip_id', '=', trips[0]!.id)
      .selectAll()
      .execute();
    expect(legs.length).toBe(1);
    expect(legs[0]!.flight_no).toBe('UA500');
  });
});

// ── multi-trip / overlapping date ranges ──────────────────────────────────────

describe('multi-trip — date range grouping', () => {
  it('two trips with identical date range share the same grouping key', async () => {
    // John's trip
    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'John Chicago Trip',
        destination: 'Chicago',
        startDate: '2026-07-03',
        endDate: '2026-07-06',
        participantNames: ['John'],
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, "@Chord John's Chicago trip July 3-6"),
      { id: gid, kind: 'group' },
    );

    // Arjun's trip — same dates
    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'Arjun Chicago Trip',
        destination: 'Chicago',
        startDate: '2026-07-03',
        endDate: '2026-07-06',
        participantNames: ['Arjun'],
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, "@Chord Arjun's Chicago trip also July 3-6"),
      { id: gid, kind: 'group' },
    );

    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length, 'both trips should exist in DB').toBe(2);

    const keys = trips.map((t) => `${t.start_date}/${t.end_date}`);
    expect(keys[0]).toBe(keys[1]);
  });

  it('drops trip tools when the trigger carries an attachment (auto-filer owns trip docs)', async () => {
    mockState.response = fence(
      { name: 'create_trip', args: { name: 'Tokyo', destination: 'Tokyo', startDate: '2026-07-03', endDate: '2026-07-10' } },
      {
        name: 'add_travel_leg',
        args: { mode: 'flight', origin: 'JFK', destination: 'NRT', departAt: '2026-07-03T11:00:00-04:00', arriveAt: '2026-07-04T14:00:00-04:00' },
      },
    );
    const msg = await insertMessage(db, {
      groupId: gid,
      senderId: uid,
      body: '@Chord here is my flight',
      mentionsBot: true,
      attachmentId: 'att_flight_1',
    });
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    // The deterministic auto-filer handles trip docs; the bot turn must not
    // re-propose, so neither a trip nor a leg is created from this turn.
    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips).toHaveLength(0);
    const legs = await db.selectFrom('travel_legs').selectAll().execute();
    expect(legs).toHaveLength(0);
    const proposals = await db.selectFrom('proposals').selectAll().execute();
    expect(proposals).toHaveLength(0);
  });

  async function makeAttachment(mime: string): Promise<string> {
    const id = newId('att');
    await db
      .insertInto('attachments')
      .values({
        id,
        scope_kind: 'group',
        scope_id: gid,
        uploaded_by: uid,
        filename: 'shot',
        mime_type: mime,
        size: 1,
        path: '/tmp/shot',
        pinned: 0,
        created_at: new Date().toISOString(),
      })
      .execute();
    return id;
  }

  it('drops content tools (event/task) when the trigger is an IMAGE — content classifier owns it', async () => {
    const attId = await makeAttachment('image/png');
    mockState.response = fence({
      name: 'create_event',
      args: { title: 'Amazon delivery', startsAt: `${soon()}T12:00:00-04:00` },
    });
    const msg = await insertMessage(db, {
      groupId: gid,
      senderId: uid,
      body: '@Chord delivery',
      mentionsBot: true,
      attachmentId: attId,
    });
    await runBotTurn(db, msg, { id: gid, kind: 'group' });
    const events = await db.selectFrom('events').where('group_id', '=', gid).selectAll().execute();
    expect(events).toHaveLength(0);
  });

  // Any non-image indexed doc (PDF, docx, txt, …) is treated the same: only the
  // trip auto-filer covers it, so content tools stay available to the bot.
  it.each(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain'])(
    'keeps content tools when the attachment is a NON-image (%s)',
    async (mime) => {
      const attId = await makeAttachment(mime);
      mockState.response = fence({
        name: 'create_event',
        args: { title: 'Amazon delivery', startsAt: `${soon()}T12:00:00-04:00` },
      });
      const msg = await insertMessage(db, {
        groupId: gid,
        senderId: uid,
        body: '@Chord delivery',
        mentionsBot: true,
        attachmentId: attId,
      });
      await runBotTurn(db, msg, { id: gid, kind: 'group' });
      const events = await db.selectFrom('events').where('group_id', '=', gid).selectAll().execute();
      expect(events).toHaveLength(1);
    },
  );

  it('two trips with different date ranges have different grouping keys', async () => {
    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'July 4th Chicago',
        destination: 'Chicago',
        startDate: '2026-07-03',
        endDate: '2026-07-06',
        participantNames: [],
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord Chicago trip July 3-6'),
      { id: gid, kind: 'group' },
    );

    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'Labor Day Nashville',
        destination: 'Nashville',
        startDate: '2026-09-04',
        endDate: '2026-09-07',
        participantNames: [],
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord Nashville trip Labor Day weekend'),
      { id: gid, kind: 'group' },
    );

    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length).toBe(2);
    const k1 = `${trips[0]!.start_date}/${trips[0]!.end_date}`;
    const k2 = `${trips[1]!.start_date}/${trips[1]!.end_date}`;
    expect(k1).not.toBe(k2);
  });

  it('three trips: two share a date range, one is distinct', async () => {
    const specs = [
      { name: 'John Chicago', dest: 'Chicago', start: '2026-07-03', end: '2026-07-06' },
      { name: 'Arjun Chicago', dest: 'Chicago', start: '2026-07-03', end: '2026-07-06' },
      { name: 'Solo Tokyo', dest: 'Tokyo', start: '2026-09-10', end: '2026-09-20' },
    ];

    for (const s of specs) {
      mockState.response = fence({
        name: 'create_trip',
        args: { name: s.name, destination: s.dest, startDate: s.start, endDate: s.end, participantNames: [] },
      });
      await runBotTurn(
        db,
        await botMsg(db, gid, uid, `@Chord ${s.name}`),
        { id: gid, kind: 'group' },
      );
    }

    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length).toBe(3);

    const groups = new Map<string, number>();
    for (const t of trips) {
      const key = `${t.start_date}/${t.end_date}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    expect(groups.size, 'two unique date-range groups').toBe(2);
    expect(groups.get('2026-07-03/2026-07-06'), 'Chicago group has 2 trips').toBe(2);
    expect(groups.get('2026-09-10/2026-09-20'), 'Tokyo group has 1 trip').toBe(1);
  });

  it('full trip build: create + flight + hotel + restaurant in separate @chord messages', async () => {
    // Message 1: create trip
    mockState.response = fence({
      name: 'create_trip',
      args: {
        name: 'Paris Anniversary',
        destination: 'Paris',
        startDate: '2026-11-01',
        endDate: '2026-11-08',
        participantNames: [],
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord Paris trip November 1-8'),
      { id: gid, kind: 'group' },
    );

    const trip = await db
      .selectFrom('trips')
      .where('group_id', '=', gid)
      .selectAll()
      .executeTakeFirstOrThrow();

    // Message 2: add flight
    mockState.response = fence({
      name: 'add_travel_leg',
      args: {
        tripId: trip.id,
        mode: 'flight',
        origin: 'JFK',
        destination: 'CDG',
        departAt: '2026-11-01T22:00:00+00:00',
        arriveAt: '2026-11-02T12:00:00+01:00',
        carrier: 'AF',
        flightNo: 'AF009',
        confirmation: 'PARIS1',
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord AF009 JFK to CDG November 1st'),
      { id: gid, kind: 'group' },
    );

    // Message 3: add hotel
    mockState.response = fence({
      name: 'add_accommodation',
      args: {
        tripId: trip.id,
        propertyName: 'Le Marais Hotel',
        checkinDate: '2026-11-02',
        checkoutDate: '2026-11-08',
        confirmation: 'HOTEL42',
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord staying at Le Marais Hotel Nov 2-8'),
      { id: gid, kind: 'group' },
    );

    // Message 4: add restaurant
    mockState.response = fence({
      name: 'add_reservation',
      args: {
        tripId: trip.id,
        kind: 'restaurant',
        name: 'Le Jules Verne',
        dateTime: '2026-11-05T20:00:00+01:00',
        confirmation: 'EIFFEL',
      },
    });
    await runBotTurn(
      db,
      await botMsg(db, gid, uid, '@Chord dinner at Le Jules Verne November 5th'),
      { id: gid, kind: 'group' },
    );

    // Verify full itinerary in DB
    const [legs, accoms, reservations] = await Promise.all([
      db.selectFrom('travel_legs').where('trip_id', '=', trip.id).selectAll().execute(),
      db.selectFrom('accommodations').where('trip_id', '=', trip.id).selectAll().execute(),
      db.selectFrom('trip_reservations').where('trip_id', '=', trip.id).selectAll().execute(),
    ]);

    expect(legs.length).toBe(1);
    expect(legs[0]!.flight_no).toBe('AF009');
    expect(accoms.length).toBe(1);
    expect(accoms[0]!.property_name).toBe('Le Marais Hotel');
    expect(reservations.length).toBe(1);
    expect(reservations[0]!.name).toBe('Le Jules Verne');
  });
});

// ── trip deletion (DB-level — no bot delete_trip tool yet) ────────────────────

describe('trip deletion', () => {
  it('deleting a trip cascades to legs, accommodations, reservations', async () => {
    const trip = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Delete Me',
      destination: 'Nowhere',
      startDate: '2026-12-01',
      endDate: '2026-12-05',
      participantIds: [],
    });

    // Seed child rows
    await db.insertInto('travel_legs').values({
      id: newId('tl'),
      trip_id: trip.id,
      persona_id: uid,
      mode: 'flight',
      origin: 'A',
      destination: 'B',
      depart_at: '2026-12-01T10:00:00Z',
      arrive_at: '2026-12-01T12:00:00Z',
      carrier: null,
      flight_no: null,
      confirmation: null,
      source_raw_context: null,
      created_at: new Date().toISOString(),
    }).execute();

    await db.insertInto('accommodations').values({
      id: newId('ac'),
      trip_id: trip.id,
      property_name: 'Hotel X',
      address: null,
      checkin_date: '2026-12-01',
      checkout_date: '2026-12-05',
      room_count: null,
      confirmation: null,
      created_at: new Date().toISOString(),
    }).execute();

    // Delete trip — FK cascade should clean up children.
    await db.deleteFrom('trips').where('id', '=', trip.id).execute();

    const [legs, accoms] = await Promise.all([
      db.selectFrom('travel_legs').where('trip_id', '=', trip.id).selectAll().execute(),
      db.selectFrom('accommodations').where('trip_id', '=', trip.id).selectAll().execute(),
    ]);
    expect(legs.length, 'legs should be cascade-deleted').toBe(0);
    expect(accoms.length, 'accommodations should be cascade-deleted').toBe(0);
  });

  it('deleting one of two same-date trips leaves the other intact', async () => {
    const trip1 = await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Trip A',
      destination: 'Chicago',
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      participantIds: [],
    });
    await createTrip(db, {
      groupId: gid,
      createdBy: uid,
      name: 'Trip B',
      destination: 'Chicago',
      startDate: '2026-07-03',
      endDate: '2026-07-06',
      participantIds: [],
    });

    await db.deleteFrom('trips').where('id', '=', trip1.id).execute();

    const remaining = await db
      .selectFrom('trips')
      .where('group_id', '=', gid)
      .selectAll()
      .execute();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.name).toBe('Trip B');
  });
});

// ── resilience ────────────────────────────────────────────────────────────────

describe('resilience', () => {
  it('invalid tool args are skipped; valid sibling tool still fires', async () => {
    // First fence has invalid create_trip (missing required destination),
    // second is a valid add_list_item.
    mockState.response = fence(
      {
        name: 'create_trip',
        args: { name: 'Bad Trip' },
        // Missing destination, startDate, endDate — should fail validation
      },
      {
        name: 'add_list_item',
        args: { listName: 'Recovery', items: ['item-after-bad-tool'] },
      },
    );
    const msg = await botMsg(db, gid, uid, '@Chord broken trip then a list item');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    // Bad tool should not create a trip
    const trips = await db.selectFrom('trips').where('group_id', '=', gid).selectAll().execute();
    expect(trips.length, 'invalid create_trip should be skipped').toBe(0);

    // Good tool should still have fired
    const list = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'Recovery')
      .selectAll()
      .executeTakeFirst();
    expect(list, 'valid add_list_item after bad tool should still succeed').toBeTruthy();
  });

  it('bot always posts a reply message even when no tool fires', async () => {
    mockState.response = 'Sorry, I didn\'t quite understand that. Could you rephrase?';
    const msg = await botMsg(db, gid, uid, '@Chord xyzzy frumple');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const botMessages = await db
      .selectFrom('messages')
      .where('group_id', '=', gid)
      .where('kind', '=', 'bot')
      .selectAll()
      .execute();
    expect(botMessages.length).toBe(1);
    expect(botMessages[0]!.body).toBeTruthy();
  });

  it('unknown tool name in fence is silently skipped', async () => {
    mockState.response = fence(
      { name: 'nonexistent_tool', args: { foo: 'bar' } },
      { name: 'add_list_item', args: { listName: 'After Unknown', items: ['ok'] } },
    );
    const msg = await botMsg(db, gid, uid, '@Chord do the unknown thing then add ok to a list');
    await runBotTurn(db, msg, { id: gid, kind: 'group' });

    const list = await db
      .selectFrom('lists')
      .where('group_id', '=', gid)
      .where('name', '=', 'After Unknown')
      .selectAll()
      .executeTakeFirst();
    expect(list, 'list after unknown tool should be created').toBeTruthy();
  });

  it('personal group triggers bot without @Chord mention — task created', async () => {
    const personalGroup = await createGroup(db, {
      name: 'My Chord',
      kind: 'personal',
      createdBy: uid,
    });

    mockState.response = fence({
      name: 'create_task',
      args: { title: 'Schedule dentist appointment' },
    });

    const msg = await botMsg(db, personalGroup.id, uid, 'schedule dentist appointment');
    // Override mentionsBot since this is personal (no @chord needed)
    await runBotTurn(db, { ...msg, mentionsBot: false }, { id: personalGroup.id, kind: 'personal' });

    const tasks = await db
      .selectFrom('tasks')
      .where('group_id', '=', personalGroup.id)
      .selectAll()
      .execute();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title).toBe('Schedule dentist appointment');
  });
});
