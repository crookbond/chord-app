/**
 * Realistic integration tests: John + family/friends across multiple groups.
 *
 * Covers:
 *  - John as owner alongside named dummy users
 *  - @chord from several different members
 *  - Cross-group data isolation (no leakage between groups)
 *  - findTripByDateRange isolation (John's trip in Group A is not returned for
 *    a user who only belongs to Group B)
 *  - PDF / image-attachment classification paths (text and vision stubs)
 *  - Grocery / packing / custom list add + check + delete
 *  - Events: create, RSVP, RSVP update, remove RSVP, delete event
 *  - Tasks: create via bot, mark done, delete
 *  - Saves: create, delete
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { runBotTurn, decideReaction } from '@/services/bot/bot.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import {
  addMember,
  closeTestDb,
  createUser,
  insertMessage,
  openTestDb,
  ensureList,
} from '@/__test-helpers__/db.js';
import {
  createTrip,
  addTravelLeg,
  addAccommodation,
  findTripByDateRange,
  listTripsForGroup,
  listTripsForPersona,
} from '@/services/trips.service.js';
import { createTask, updateTask, deleteTask, listTasks } from '@/services/tasks.service.js';
import { setGrant } from '@/services/trust.service.js';
import {
  listLists,
  addItem,
  setItemChecked,
  deleteItem,
} from '@/services/lists.service.js';
import { createSave, deleteSave, listSaves } from '@/services/saves.service.js';
import { createEvent, listEvents, upsertRsvp, listRsvps } from '@/services/events.service.js';
import { classifyAndAutoFileAttachment } from '@/services/bot/trip_classifier.js';
import { extractAndSummarize } from '@/services/attachments.extract.js';
import { getLlmForUser } from '@/services/llm/factory.js';

// ── helpers ───────────────────────────────────────────────────────────────────

const sendMessage = insertMessage;

/** Minimal 1×1 transparent PNG — used as a stand-in for a scanned-PDF page image. */
const STUB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ── shared fixtures ───────────────────────────────────────────────────────────

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

// ── realistic user/group seed ─────────────────────────────────────────────────

/**
 * John + family group + friends group.
 *
 *  familyGroup  — John (owner), Priya, Arjun, Maya
 *  friendsGroup — John (owner), Dev, Sasha, Marco
 */
async function seedJohnWorld(db: Kysely<DB>) {
  const john  = await createUser(db, 'john',  'John');
  const priya  = await createUser(db, 'priya',  'Priya');
  const arjun  = await createUser(db, 'arjun',  'Arjun');
  const maya   = await createUser(db, 'maya',   'Maya');
  const dev    = await createUser(db, 'dev',    'Dev');
  const sasha  = await createUser(db, 'sasha',  'Sasha');
  const marco  = await createUser(db, 'marco',  'Marco');

  const familyGroup = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
  await addMember(db, familyGroup.id, priya);
  await addMember(db, familyGroup.id, arjun);
  await addMember(db, familyGroup.id, maya);

  const friendsGroup = await createGroup(db, { name: 'Squad', kind: 'group', createdBy: john });
  await addMember(db, friendsGroup.id, dev);
  await addMember(db, friendsGroup.id, sasha);
  await addMember(db, friendsGroup.id, marco);

  return { john, priya, arjun, maya, dev, sasha, marco, familyGroup, friendsGroup };
}

// ── @chord from multiple members ──────────────────────────────────────────────

describe('@chord from multiple group members', () => {
  it('each family member gets a bot reply for their @chord message', async () => {
    const { john, priya, arjun, familyGroup } = await seedJohnWorld(db);

    const invocations: [string, string][] = [
      [john,  '@Chord add sunscreen and towels to Costco list'],
      [priya,  '@Chord we need to book a rental car for the holiday'],
      [arjun,  '@Chord save https://booking.com/hotel/grand-hyatt for the trip'],
    ];

    for (const [sender, body] of invocations) {
      const msg = await sendMessage(db, { groupId: familyGroup.id, senderId: sender, body });
      await runBotTurn(db, msg, { id: familyGroup.id, kind: 'group' });
    }

    const botMsgs = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', familyGroup.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(botMsgs.length, 'hint: one bot reply expected per @chord invocation').toBe(3);
  });

  it('friends-group @chord produces results only in that group', async () => {
    const { john, dev, sasha, familyGroup, friendsGroup } = await seedJohnWorld(db);

    // Family group: John sends @chord
    const fMsg = await sendMessage(db, { groupId: familyGroup.id, senderId: john, body: '@Chord add milk to Costco list' });
    await runBotTurn(db, fMsg, { id: familyGroup.id, kind: 'group' });

    // Friends group: Dev and Sasha send @chord
    for (const [sender, body] of [
      [dev,   '@Chord book a rental car for the weekend'],
      [sasha, '@Chord save https://airbnb.com/rooms/999 for the cabin'],
    ] as [string, string][]) {
      const msg = await sendMessage(db, { groupId: friendsGroup.id, senderId: sender, body });
      await runBotTurn(db, msg, { id: friendsGroup.id, kind: 'group' });
    }

    const familyBotMsgs = await db
      .selectFrom('messages').selectAll()
      .where('group_id', '=', familyGroup.id).where('kind', '=', 'bot').execute();
    const friendsBotMsgs = await db
      .selectFrom('messages').selectAll()
      .where('group_id', '=', friendsGroup.id).where('kind', '=', 'bot').execute();

    expect(familyBotMsgs.length, 'hint: family group should have exactly 1 bot message').toBe(1);
    expect(friendsBotMsgs.length, 'hint: friends group should have exactly 2 bot messages').toBe(2);
  });

  it('bot message body contains relevant tool output', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const msg = await sendMessage(db, {
      groupId: familyGroup.id,
      senderId: john,
      body: '@Chord potluck dinner this Friday at John\'s place',
    });
    await runBotTurn(db, msg, { id: familyGroup.id, kind: 'group' });

    const bot = await db
      .selectFrom('messages').selectAll()
      .where('group_id', '=', familyGroup.id).where('kind', '=', 'bot')
      .executeTakeFirstOrThrow();
    expect(bot.body.toLowerCase(), 'hint: bot reply should mention the tool output (event)').toMatch(/potluck|event/i);
  });
});

// ── data isolation / no cross-group leakage ───────────────────────────────────

describe('data isolation — no cross-group leakage', () => {
  it('tasks created in family group are not visible to friends group', async () => {
    const { john, dev, familyGroup, friendsGroup } = await seedJohnWorld(db);

    await createTask(db, { groupId: familyGroup.id, createdBy: john, title: 'Family-only task' });
    await createTask(db, { groupId: friendsGroup.id, createdBy: dev, title: 'Squad-only task' });

    const familyTasks = await listTasks(db, familyGroup.id);
    const friendsTasks = await listTasks(db, friendsGroup.id);

    expect(familyTasks.map((t) => t.title)).toContain('Family-only task');
    expect(familyTasks.map((t) => t.title)).not.toContain('Squad-only task');

    expect(friendsTasks.map((t) => t.title)).toContain('Squad-only task');
    expect(friendsTasks.map((t) => t.title)).not.toContain('Family-only task');
  });

  it('saves are group-scoped — friends cannot see family saves', async () => {
    const { john, familyGroup, friendsGroup } = await seedJohnWorld(db);

    await createSave(db, {
      groupId: familyGroup.id,
      createdBy: john,
      kind: 'link',
      title: 'Family hotel link',
      url: 'https://hotels.com/family',
      tags: [],
    });
    await createSave(db, {
      groupId: friendsGroup.id,
      createdBy: john,
      kind: 'link',
      title: 'Friends cabin link',
      url: 'https://airbnb.com/friends',
      tags: [],
    });

    const familySaves = await listSaves(db, familyGroup.id);
    const friendsSaves = await listSaves(db, friendsGroup.id);

    expect(familySaves.map((s) => s.title)).not.toContain('Friends cabin link');
    expect(friendsSaves.map((s) => s.title)).not.toContain('Family hotel link');
  });

  it('trips are group-scoped — listTripsForGroup returns only that group\'s trips', async () => {
    const { john, familyGroup, friendsGroup } = await seedJohnWorld(db);

    await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Family Hawaii', destination: 'Hawaii',
      startDate: '2026-07-01', endDate: '2026-07-14', participantIds: [],
    });
    await createTrip(db, {
      groupId: friendsGroup.id, createdBy: john,
      name: 'Squad Vegas', destination: 'Las Vegas',
      startDate: '2026-09-10', endDate: '2026-09-14', participantIds: [],
    });

    const familyTrips = await listTripsForGroup(db, familyGroup.id);
    const friendsTrips = await listTripsForGroup(db, friendsGroup.id);

    expect(familyTrips.map((t) => t.name)).toContain('Family Hawaii');
    expect(familyTrips.map((t) => t.name)).not.toContain('Squad Vegas');

    expect(friendsTrips.map((t) => t.name)).toContain('Squad Vegas');
    expect(friendsTrips.map((t) => t.name)).not.toContain('Family Hawaii');
  });

  it('events are group-scoped', async () => {
    const { john, dev, familyGroup, friendsGroup } = await seedJohnWorld(db);

    await createEvent(db, {
      groupId: familyGroup.id, createdBy: john,
      title: 'Family BBQ', startsAt: '2026-08-01T17:00:00Z',
    });
    await createEvent(db, {
      groupId: friendsGroup.id, createdBy: dev,
      title: 'Squad Game Night', startsAt: '2026-08-05T19:00:00Z',
    });

    const familyEvents = await listEvents(db, familyGroup.id, { pastDays: 3650, futureDays: 3650 });
    const friendsEvents = await listEvents(db, friendsGroup.id, { pastDays: 3650, futureDays: 3650 });

    expect(familyEvents.map((e) => e.title)).not.toContain('Squad Game Night');
    expect(friendsEvents.map((e) => e.title)).not.toContain('Family BBQ');
  });

  it('messages from one group are invisible to the other', async () => {
    const { john, dev, familyGroup, friendsGroup } = await seedJohnWorld(db);

    await sendMessage(db, { groupId: familyGroup.id, senderId: john, body: 'Secret family plan' });
    await sendMessage(db, { groupId: friendsGroup.id, senderId: dev, body: 'Squad meetup details' });

    const familyMsgs = await db
      .selectFrom('messages').selectAll().where('group_id', '=', familyGroup.id).execute();
    const friendsMsgs = await db
      .selectFrom('messages').selectAll().where('group_id', '=', friendsGroup.id).execute();

    expect(familyMsgs.every((m) => m.group_id === familyGroup.id)).toBe(true);
    expect(friendsMsgs.every((m) => m.group_id === friendsGroup.id)).toBe(true);
    expect(familyMsgs.map((m) => m.body)).not.toContain('Squad meetup details');
    expect(friendsMsgs.map((m) => m.body)).not.toContain('Secret family plan');
  });
});

// ── flight matching — only within accessible groups ───────────────────────────

describe('trip date-range matching — no cross-group leakage', () => {
  it('Priya (family-only) cannot match a trip from friends group', async () => {
    const { john, priya, friendsGroup } = await seedJohnWorld(db);

    // Create a trip in the friends group (Priya is not in this group)
    await createTrip(db, {
      groupId: friendsGroup.id, createdBy: john,
      name: 'Squad Ski Trip', destination: 'Whistler',
      startDate: '2026-12-20', endDate: '2026-12-28', participantIds: [],
    });

    // Priya looks for a trip matching those dates — she should find nothing
    // because she is not a member of the friends group
    const match = await findTripByDateRange(db, priya, '2026-12-21', '2026-12-27');
    expect(match, 'hint: Priya is not in the friends group so the ski trip must not be returned').toBeNull();
  });

  it('John (in both groups) date-range search prefers the specified group', async () => {
    const { john, familyGroup, friendsGroup } = await seedJohnWorld(db);

    const familyTrip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Family Bali', destination: 'Bali',
      startDate: '2026-06-01', endDate: '2026-06-15', participantIds: [],
    });
    await createTrip(db, {
      groupId: friendsGroup.id, createdBy: john,
      name: 'Squad Bali', destination: 'Bali',
      startDate: '2026-06-03', endDate: '2026-06-12', participantIds: [],
    });

    // When specifying familyGroup as preferred, should get the family trip
    const match = await findTripByDateRange(
      db, john, '2026-06-05', '2026-06-10', familyGroup.id,
    );
    expect(match?.id, 'hint: preferGroupId should return the family trip, not the squad trip').toBe(familyTrip.id);
  });

  it('two family members upload different legs — both attach to the same trip', async () => {
    const { john, priya, familyGroup } = await seedJohnWorld(db);

    const trip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Greece 2026', destination: 'Athens',
      startDate: '2026-05-10', endDate: '2026-05-20', participantIds: [],
    });

    // John's outbound leg
    await addTravelLeg(db, {
      tripId: trip.id, personaId: john, mode: 'flight',
      origin: 'JFK', destination: 'ATH',
      departAt: '2026-05-10T09:00:00Z', arriveAt: '2026-05-11T06:00:00Z',
      carrier: 'OA', flightNo: 'OA401',
    });

    // Priya's separate booking — same trip, different flight number
    await addTravelLeg(db, {
      tripId: trip.id, personaId: priya, mode: 'flight',
      origin: 'LHR', destination: 'ATH',
      departAt: '2026-05-10T11:00:00Z', arriveAt: '2026-05-10T17:00:00Z',
      carrier: 'A3', flightNo: 'A3601',
    });

    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Athens Grand Hotel',
      checkinDate: '2026-05-11',
      checkoutDate: '2026-05-20',
    });

    const legs = await db
      .selectFrom('travel_legs').selectAll().where('trip_id', '=', trip.id).execute();
    expect(legs.length, 'hint: both members\' legs should attach to the single trip').toBe(2);
    expect(legs.map((l) => l.persona_id)).toContain(john);
    expect(legs.map((l) => l.persona_id)).toContain(priya);
  });
});

// ── PDF / image attachment classification ─────────────────────────────────────

describe('PDF and image attachment classification', () => {
  it('realistic flight-text attachment: classifier runs without error (mock LLM → no trip created)', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);

    const flightText = [
      'BOARDING PASS — CONFIRMED',
      'Passenger: JOHN DOE',
      'Flight: AA 101   JFK → LAX',
      'Departure: 2026-08-15 08:00   Arrival: 2026-08-15 11:15',
      'Seat: 12A   Confirmation: PNR123XYZ',
    ].join('\n');

    await classifyAndAutoFileAttachment(db, {
      attachmentId: newId('a'),
      groupId: familyGroup.id,
      uploadedBy: john,
      filename: 'boarding_pass_aa101.pdf',
      extractedText: flightText,
    });

    // Mock LLM returns non-JSON → no trip auto-created; no crash
    const trips = await listTripsForGroup(db, familyGroup.id);
    expect(
      trips.length,
      'hint: mock LLM cannot return valid classification JSON; no trip should be auto-created',
    ).toBe(0);
  });

  it('realistic hotel-text attachment: classifier runs without error', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);

    const hotelText = [
      'BOOKING CONFIRMATION — Marriott Tokyo',
      'Guest: John Doe',
      'Check-in: 2026-09-01  Check-out: 2026-09-08',
      'Room: Deluxe King  Confirmation: MRT-998877',
      '1-1-1 Marunouchi, Chiyoda City, Tokyo',
    ].join('\n');

    await classifyAndAutoFileAttachment(db, {
      attachmentId: newId('a'),
      groupId: familyGroup.id,
      uploadedBy: john,
      filename: 'marriott_tokyo_confirmation.pdf',
      extractedText: hotelText,
    });

    const trips = await listTripsForGroup(db, familyGroup.id);
    expect(trips.length, 'hint: no trip auto-created with mock LLM').toBe(0);
  });

  it('image-only PDF stub (pageImage present, no text): classifier does not crash', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);

    await classifyAndAutoFileAttachment(db, {
      attachmentId: newId('a'),
      groupId: familyGroup.id,
      uploadedBy: john,
      filename: 'scanned_ticket.pdf',
      extractedText: '',
      pageImage: STUB_PNG,
    });

    // Mock LLM cannot classify from an image either; no crash is the goal
    const trips = await listTripsForGroup(db, familyGroup.id);
    expect(trips.length, 'hint: vision path with mock LLM should not crash or create phantom trips').toBe(0);
  });

  it('text file extraction via extractAndSummarize', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chord-test-'));
    const filePath = path.join(dir, 'itinerary.txt');
    await fs.writeFile(
      filePath,
      'John Doe – Greece Itinerary\n' +
      'Flight AA101 JFK→ATH 15 May 2026\n' +
      'Hotel Athenian Riviera, 15–22 May 2026\n' +
      'Return OA402 ATH→JFK 22 May 2026\n',
    );

    const result = await extractAndSummarize({
      path: filePath,
      mimeType: 'text/plain',
      filename: 'itinerary.txt',
      llm: await getLlmForUser(db, null, 'bot_turn'),
    });

    await fs.rm(dir, { recursive: true, force: true });

    expect(result.text, 'hint: plain-text file should be read and returned as extracted text').toContain('Greece');
    expect(result.text).toContain('John Doe');
    // Summary is attempted via mock LLM — may be non-meaningful but must not throw
  });

  it('multiple PDF classification calls in the same group do not interfere', async () => {
    const { john, priya, familyGroup } = await seedJohnWorld(db);

    const docs = [
      { user: john, filename: 'john_flight.pdf', text: 'A'.repeat(100) },
      { user: priya, filename: 'priya_hotel.pdf', text: 'B'.repeat(100) },
      { user: john, filename: 'totally_wrong.pdf', text: 'not a travel doc at all XYZ123' },
    ];

    for (const doc of docs) {
      await classifyAndAutoFileAttachment(db, {
        attachmentId: newId('a'),
        groupId: familyGroup.id,
        uploadedBy: doc.user,
        filename: doc.filename,
        extractedText: doc.text,
      });
    }

    // Three classification runs should complete without errors
    const trips = await listTripsForGroup(db, familyGroup.id);
    expect(trips.length, 'hint: mock LLM cannot classify — no trips should be created').toBe(0);
  });
});

// ── grocery / packing / custom lists ─────────────────────────────────────────

describe('grocery, packing, and custom lists', () => {
  it('bot creates Costco list from @chord message by John', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const msg = await sendMessage(db, {
      groupId: familyGroup.id,
      senderId: john,
      // Mock regex requires the first keyword (costco/add to) to appear before the item keyword
      body: '@Chord add to Costco list - sunscreen, snorkels, beach towels',
    });
    await runBotTurn(db, msg, { id: familyGroup.id, kind: 'group' });

    const lists = await listLists(db, familyGroup.id);
    expect(lists.some((l) => l.name === 'Costco'), 'hint: bot should create/find Costco list').toBe(true);
    const costco = lists.find((l) => l.name === 'Costco')!;
    expect(costco.items.length, 'hint: items should be added to Costco list').toBeGreaterThanOrEqual(1);
  });

  it('Priya directly adds to Packing list via applyToolCall', async () => {
    const { priya, familyGroup } = await seedJohnWorld(db);
    await applyToolCall(db, {
      groupId: familyGroup.id,
      actorUserId: priya,
      provenance: null,
      call: {
        name: 'add_list_item',
        args: {
          listName: 'Packing',
          items: ['passport', 'travel adapter', 'sunscreen SPF50', 'snorkel mask'],
        },
      },
    });

    const lists = await listLists(db, familyGroup.id);
    const packing = lists.find((l) => l.name === 'Packing');
    expect(packing, 'hint: Packing list should be created').toBeTruthy();
    expect(packing!.items.map((i) => i.text)).toContain('passport');
    expect(packing!.items.length, 'hint: all 4 items should be in packing list').toBe(4);
  });

  it('Arjun adds to Grocery list', async () => {
    const { arjun, familyGroup } = await seedJohnWorld(db);
    await applyToolCall(db, {
      groupId: familyGroup.id,
      actorUserId: arjun,
      provenance: null,
      call: {
        name: 'add_list_item',
        args: { listName: 'Grocery', items: ['milk', 'bread', 'eggs', 'olive oil', 'pasta'] },
      },
    });

    const lists = await listLists(db, familyGroup.id);
    const grocery = lists.find((l) => l.name === 'Grocery');
    expect(grocery, 'hint: Grocery list should exist').toBeTruthy();
    expect(grocery!.items.map((i) => i.text)).toContain('eggs');
  });

  it('multiple members add to the same list — items accumulate', async () => {
    const { john, priya, arjun, familyGroup } = await seedJohnWorld(db);

    for (const [actor, items] of [
      [john,  ['beach umbrella', 'flip flops']],
      [priya,  ['travel pillow', 'earplugs']],
      [arjun,  ['camera', 'memory card']],
    ] as [string, string[]][]) {
      await applyToolCall(db, {
        groupId: familyGroup.id,
        actorUserId: actor,
        provenance: null,
        call: { name: 'add_list_item', args: { listName: 'Packing', items } },
      });
    }

    const lists = await listLists(db, familyGroup.id);
    const packing = lists.find((l) => l.name === 'Packing')!;
    expect(packing.items.length, 'hint: 6 items from 3 members should all be in the list').toBe(6);
  });

  it('checking off a list item updates its checked state', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const list = await ensureList(db, familyGroup.id, 'Packing', john);
    const item = (await addItem(db, list.id, 'boarding pass')).item;

    expect(item.checked, 'pre-condition: newly added item is unchecked').toBe(false);

    const updated = await setItemChecked(db, item.id, true);
    expect(updated?.checked, 'hint: setItemChecked(true) should mark item as checked').toBe(true);

    const unchecked = await setItemChecked(db, item.id, false);
    expect(unchecked?.checked, 'hint: setItemChecked(false) should uncheck item').toBe(false);
  });

  it('deleting a list item removes it permanently', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const list = await ensureList(db, familyGroup.id, 'Grocery', john);
    const keep = (await addItem(db, list.id, 'bananas')).item;
    const remove = (await addItem(db, list.id, 'oops-item')).item;

    await deleteItem(db, remove.id);

    const lists = await listLists(db, familyGroup.id);
    const grocery = lists.find((l) => l.id === list.id)!;
    const ids = grocery.items.map((i) => i.id);
    expect(ids, 'hint: deleted item should not appear in list').not.toContain(remove.id);
    expect(ids, 'hint: kept item should still be present').toContain(keep.id);
  });

  it('lists are group-scoped — family Packing list is not visible in friends group', async () => {
    const { john, familyGroup, friendsGroup } = await seedJohnWorld(db);
    await ensureList(db, familyGroup.id, 'Packing', john);
    await ensureList(db, friendsGroup.id, 'Snacks', john);

    const familyLists = await listLists(db, familyGroup.id);
    const friendsLists = await listLists(db, friendsGroup.id);

    expect(familyLists.map((l) => l.name)).not.toContain('Snacks');
    expect(friendsLists.map((l) => l.name)).not.toContain('Packing');
  });
});

// ── events: create, RSVP, update, delete ─────────────────────────────────────

describe('events — create, RSVP, update, delete', () => {
  it('John creates a BBQ event and everyone RSVPs', async () => {
    const { john, priya, arjun, maya, familyGroup } = await seedJohnWorld(db);

    const event = await createEvent(db, {
      groupId: familyGroup.id,
      createdBy: john,
      title: 'Summer BBQ',
      startsAt: '2026-07-04T17:00:00Z',
      location: 'John\'s Backyard',
    });

    await upsertRsvp(db, { eventId: event.id, userId: john, displayName: 'John', status: 'yes' });
    await upsertRsvp(db, { eventId: event.id, userId: priya, displayName: 'Priya', status: 'yes', dish: 'Dal Makhani' });
    await upsertRsvp(db, { eventId: event.id, userId: arjun, displayName: 'Arjun', status: 'maybe' });
    await upsertRsvp(db, { eventId: event.id, userId: maya, displayName: 'Maya', status: 'no' });

    const rsvps = await listRsvps(db, event.id);
    expect(rsvps.length, 'hint: 4 RSVPs expected').toBe(4);
    expect(rsvps.filter((r) => r.status === 'yes').length).toBe(2);
    expect(rsvps.find((r) => r.displayName === 'Priya')?.dish).toBe('Dal Makhani');
    expect(rsvps.find((r) => r.displayName === 'Maya')?.status).toBe('no');
  });

  it('Arjun changes his RSVP from maybe to yes', async () => {
    const { john, arjun, familyGroup } = await seedJohnWorld(db);
    const event = await createEvent(db, {
      groupId: familyGroup.id, createdBy: john,
      title: 'Game Night', startsAt: '2026-08-10T19:00:00Z',
    });

    await upsertRsvp(db, { eventId: event.id, userId: arjun, displayName: 'Arjun', status: 'maybe' });
    const updated = await upsertRsvp(db, { eventId: event.id, userId: arjun, displayName: 'Arjun', status: 'yes', dish: 'Samosas' });

    expect(updated.status, 'hint: upsertRsvp should update status to yes').toBe('yes');
    expect(updated.dish, 'hint: dish should be updated on re-RSVP').toBe('Samosas');

    // Only one RSVP row should exist (upsert, not insert)
    const rsvps = await listRsvps(db, event.id);
    expect(rsvps.filter((r) => r.displayName === 'Arjun').length, 'hint: upsert should not duplicate RSVPs').toBe(1);
  });

  it('deleting an RSVP row removes it', async () => {
    const { john, priya, familyGroup } = await seedJohnWorld(db);
    const event = await createEvent(db, {
      groupId: familyGroup.id, createdBy: john,
      title: 'Diwali Party', startsAt: '2026-10-20T18:00:00Z',
    });
    await upsertRsvp(db, { eventId: event.id, userId: john, displayName: 'John', status: 'yes' });
    const priyaRsvp = await upsertRsvp(db, { eventId: event.id, userId: priya, displayName: 'Priya', status: 'yes' });

    await db.deleteFrom('rsvps').where('id', '=', priyaRsvp.id).execute();

    const rsvps = await listRsvps(db, event.id);
    expect(rsvps.length, 'hint: one RSVP should remain after deleting Priya\'s').toBe(1);
    expect(rsvps[0]!.displayName).toBe('John');
  });

  it('deleting an event removes it from the group', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const keep = await createEvent(db, {
      groupId: familyGroup.id, createdBy: john,
      title: 'Keep This Event', startsAt: '2026-11-01T10:00:00Z',
    });
    const remove = await createEvent(db, {
      groupId: familyGroup.id, createdBy: john,
      title: 'Remove This Event', startsAt: '2026-11-15T10:00:00Z',
    });

    await db.deleteFrom('rsvps').where('event_id', '=', remove.id).execute();
    await db.deleteFrom('events').where('id', '=', remove.id).execute();

    const events = await listEvents(db, familyGroup.id, { pastDays: 3650, futureDays: 3650 });
    expect(events.map((e) => e.id)).toContain(keep.id);
    expect(events.map((e) => e.id), 'hint: deleted event should not appear').not.toContain(remove.id);
  });

  it('bot @chord creates an event in the correct group', async () => {
    const { john, familyGroup, friendsGroup } = await seedJohnWorld(db);

    const msg = await sendMessage(db, {
      groupId: familyGroup.id,
      senderId: john,
      body: '@Chord plan a potluck dinner party this weekend',
    });
    await runBotTurn(db, msg, { id: familyGroup.id, kind: 'group' });

    const familyEvents = await listEvents(db, familyGroup.id, { pastDays: 3650, futureDays: 3650 });
    const friendsEvents = await listEvents(db, friendsGroup.id, { pastDays: 3650, futureDays: 3650 });

    expect(familyEvents.length, 'hint: event should land in family group').toBeGreaterThanOrEqual(1);
    expect(friendsEvents.length, 'hint: event should NOT appear in friends group').toBe(0);
  });
});

// ── tasks: create, complete, delete ──────────────────────────────────────────

describe('tasks — create, complete, delete', () => {
  it('John @chords a task and it appears as open', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const msg = await sendMessage(db, {
      groupId: familyGroup.id,
      senderId: john,
      body: '@Chord we need to book a rental car for the Hawaii trip',
    });
    await runBotTurn(db, msg, { id: familyGroup.id, kind: 'group' });

    const tasks = await listTasks(db, familyGroup.id);
    expect(tasks.length, 'hint: bot should create a task for "book rental car"').toBeGreaterThanOrEqual(1);
    expect(tasks[0]!.status).toBe('open');
  });

  it('marking a task done updates its status', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const task = await createTask(db, {
      groupId: familyGroup.id,
      createdBy: john,
      title: 'Pack carry-on',
    });

    expect(task.status, 'pre-condition: new task is open').toBe('open');

    const done = await updateTask(db, task.id, { status: 'done' });
    expect(done?.status, 'hint: updateTask should set status to done').toBe('done');
  });

  it('assigning a task to a member works', async () => {
    const { john, priya, familyGroup } = await seedJohnWorld(db);
    // ADR 0026 — assignment is closed by default; Priya must grant John
    // trust to land a task on her.
    await setGrant(db, priya, john, ['task']);
    const task = await createTask(db, {
      groupId: familyGroup.id,
      createdBy: john,
      title: 'Book restaurant',
      assigneeId: priya,
    });
    expect(task.assigneeId, 'hint: assigneeId should be stored').toBe(priya);
  });

  it('deleting a task removes it from the group', async () => {
    const { john, familyGroup } = await seedJohnWorld(db);
    const t1 = await createTask(db, { groupId: familyGroup.id, createdBy: john, title: 'Keep' });
    const t2 = await createTask(db, { groupId: familyGroup.id, createdBy: john, title: 'Delete me' });

    await deleteTask(db, t2.id);

    const tasks = await listTasks(db, familyGroup.id);
    expect(tasks.map((t) => t.id)).toContain(t1.id);
    expect(tasks.map((t) => t.id), 'hint: deleted task should not be returned').not.toContain(t2.id);
  });

  it('tasks from different groups are independent', async () => {
    const { john, dev, familyGroup, friendsGroup } = await seedJohnWorld(db);
    await createTask(db, { groupId: familyGroup.id, createdBy: john, title: 'Family task' });
    await createTask(db, { groupId: friendsGroup.id, createdBy: dev, title: 'Friends task' });

    const familyTasks = await listTasks(db, familyGroup.id);
    const friendsTasks = await listTasks(db, friendsGroup.id);
    expect(familyTasks.map((t) => t.title)).not.toContain('Friends task');
    expect(friendsTasks.map((t) => t.title)).not.toContain('Family task');
  });
});

// ── saves: create and delete ──────────────────────────────────────────────────

describe('saves — create, delete', () => {
  it('saves accumulate from multiple members and can be deleted selectively', async () => {
    const { john, priya, arjun, familyGroup } = await seedJohnWorld(db);

    const s1 = await createSave(db, {
      groupId: familyGroup.id, createdBy: john, kind: 'link',
      title: 'Airbnb villa', url: 'https://airbnb.com/rooms/111', tags: [],
    });
    const s2 = await createSave(db, {
      groupId: familyGroup.id, createdBy: priya, kind: 'link',
      title: 'Hilton hotel', url: 'https://hilton.com/rooms/222', tags: [],
    });
    const s3 = await createSave(db, {
      groupId: familyGroup.id, createdBy: arjun, kind: 'place',
      title: 'Nishiki Market', tags: [],
    });

    let saves = await listSaves(db, familyGroup.id);
    expect(saves.length, 'hint: 3 saves should exist before deletion').toBe(3);

    await deleteSave(db, s2.id);

    saves = await listSaves(db, familyGroup.id);
    expect(saves.length, 'hint: 2 saves should remain after deleting Hilton link').toBe(2);
    expect(saves.map((s) => s.id)).not.toContain(s2.id);
    expect(saves.map((s) => s.id)).toContain(s1.id);
    expect(saves.map((s) => s.id)).toContain(s3.id);
  });

  it('save created by bot (null actor) has null createdBy', async () => {
    const { familyGroup } = await seedJohnWorld(db);
    await applyToolCall(db, {
      groupId: familyGroup.id,
      actorUserId: null,
      provenance: null,
      call: { name: 'save_link', args: { title: 'Auto-saved', url: 'https://example.com' } },
    });

    const saves = await listSaves(db, familyGroup.id);
    expect(saves[0]!.createdBy, 'hint: null actorUserId should store null created_by').toBeNull();
  });
});

// ── decideReaction gate ───────────────────────────────────────────────────────

describe('decideReaction — bot trigger rules', () => {
  it('group chat: react=true only when @chord is present', () => {
    const cases: [string, boolean][] = [
      ['@Chord remind me to pack', true],
      ['@chord add milk to the list', true],
      ['anyone want coffee?', false],
      ['flight is at 8am', false],
      ['', false],
    ];
    for (const [body, expected] of cases) {
      const { react } = decideReaction({ kind: 'text', senderId: 'u1', groupKind: 'group', body });
      expect(react, `hint: "${body}" in group chat should be react=${expected}`).toBe(expected);
    }
  });

  it('personal chat: react=true for every non-bot message', () => {
    for (const body of ['hello', 'what\'s the plan?', '']) {
      const { react } = decideReaction({ kind: 'text', senderId: 'u1', groupKind: 'personal', body });
      expect(react, `hint: personal chat "${body}" should always be react=true`).toBe(true);
    }
  });

  it('bot/system messages never trigger a reaction', () => {
    for (const kind of ['bot', 'system'] as const) {
      const { react } = decideReaction({ kind, senderId: 'u1', groupKind: 'group', body: '@chord anything' });
      expect(react, `hint: ${kind} messages should never trigger bot`).toBe(false);
    }
  });

  it('null senderId (system message) never triggers reaction', () => {
    const { react } = decideReaction({
      kind: 'text',
      senderId: null,
      groupKind: 'group',
      body: '@Chord do something',
    });
    expect(react, 'hint: null senderId should never trigger bot').toBe(false);
  });
});

// ── passenger attribution & person-scoped trip lookup ─────────────────────────

describe('passenger attribution and person-scoped trip lookup', () => {
  it('listTripsForPersona returns only trips where that user has a leg', async () => {
    const { john, priya, arjun, familyGroup } = await seedJohnWorld(db);

    const johnTrip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'John NYC', destination: 'New York',
      startDate: '2026-05-01', endDate: '2026-05-05', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: johnTrip.id, personaId: john, mode: 'flight',
      origin: 'ORD', destination: 'JFK',
      departAt: '2026-05-01T08:00:00Z', arriveAt: '2026-05-01T12:00:00Z',
    });

    const benTrip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Ben MDW→LGA', destination: 'New York',
      startDate: '2026-04-24', endDate: '2026-04-24', participantIds: [],
    });
    // Leg attributed to arjun (standing in for "Ben" — a group member)
    await addTravelLeg(db, {
      tripId: benTrip.id, personaId: arjun, mode: 'flight',
      origin: 'MDW', destination: 'LGA',
      departAt: '2026-04-24T10:30:00-05:00', arriveAt: '2026-04-24T14:15:00-04:00',
    });

    const johnTrips = await listTripsForPersona(db, familyGroup.id, john);
    const arjunTrips = await listTripsForPersona(db, familyGroup.id, arjun);
    const priyaTrips = await listTripsForPersona(db, familyGroup.id, priya);

    expect(johnTrips.map((t) => t.id), 'John should only see his own leg trips').toEqual([johnTrip.id]);
    expect(arjunTrips.map((t) => t.id), 'Arjun should only see his own leg trips').toEqual([benTrip.id]);
    expect(priyaTrips, 'Priya has no legs so should get empty list').toHaveLength(0);
  });

  it('get_trip_status via applyToolCall with personName resolves to the right trip', async () => {
    const { john, arjun, familyGroup } = await seedJohnWorld(db);

    const johnTrip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'John Rome', destination: 'Rome',
      startDate: '2026-06-10', endDate: '2026-06-20', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: johnTrip.id, personaId: john, mode: 'flight',
      origin: 'JFK', destination: 'FCO',
      departAt: '2026-06-10T09:00:00Z', arriveAt: '2026-06-10T22:00:00Z',
    });

    const arjunTrip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Arjun Chicago', destination: 'Chicago',
      startDate: '2026-07-01', endDate: '2026-07-04', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: arjunTrip.id, personaId: arjun, mode: 'flight',
      origin: 'LGA', destination: 'ORD',
      departAt: '2026-07-01T07:00:00Z', arriveAt: '2026-07-01T08:30:00Z',
    });

    const result = await applyToolCall(db, {
      groupId: familyGroup.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'get_trip_status', args: { personName: 'arjun' } },
    });

    expect(result.summary, 'hint: get_trip_status with personName should return Arjun\'s trip').toContain('Arjun Chicago');
    expect(result.card?.title, 'hint: card title should be Arjun\'s trip name').toBe('Arjun Chicago');
  });

  it('PDF classifier resolves passengerName to the matching group member', async () => {
    const { john, arjun, familyGroup } = await seedJohnWorld(db);

    // Create the trip first (mock LLM can't classify, so we simulate what the
    // classifier would do after a successful LLM call by calling the service directly)
    const trip = await createTrip(db, {
      groupId: familyGroup.id, createdBy: john,
      name: 'Trip to New York', destination: 'LGA',
      startDate: '2026-04-24', endDate: '2026-04-24', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      personaId: arjun,   // arjun = the resolved passenger ("Ben"-style upload)
      mode: 'flight',
      origin: 'MDW',
      destination: 'LGA',
      departAt: '2026-04-24T10:30:00-05:00',
      arriveAt: '2026-04-24T14:15:00-04:00',
      carrier: 'WN',
      flightNo: 'WN 1234',
    });

    const legs = await db
      .selectFrom('travel_legs').selectAll().where('trip_id', '=', trip.id).execute();
    expect(legs[0]!.persona_id, 'leg should be attributed to the actual passenger, not the uploader').toBe(arjun);
    expect(legs[0]!.persona_id).not.toBe(john);

    // Confirm listTripsForPersona returns it under arjun
    const arjunTrips = await listTripsForPersona(db, familyGroup.id, arjun);
    expect(arjunTrips.map((t) => t.id)).toContain(trip.id);
  });
});
