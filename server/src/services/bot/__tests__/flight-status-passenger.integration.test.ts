/**
 * Prod, 2026-09-24 (WhatsApp, personal 1:1): "Can we track Bens flight from
 * today" → the bot called flight_status with "GL779135" — the user's United
 * mileage number, remembered as a memory — and reported no tracker. Ben was
 * on Southwest 2714 LGA→MDW, departed 15:25 -04:00, stored as carrier
 * "Southwest Airlines" + flight_no "2714" with passenger "Ben Doe".
 *
 * Three things composed: the leg's depart_at is text in its own offset and was
 * compared to a UTC bound as text, so a flight three hours gone dropped out of
 * the prompt; the flights block named no passengers; and nothing let the model
 * ask for a person's flight instead of producing a number.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import {
  addAccommodation,
  addTravelLeg,
  createTrip,
  deleteTrip,
  findUpcomingFlights,
} from '@/services/trips.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/** An ISO timestamp written in a fixed offset, the way legs are stored. */
function inOffset(ms: number, offsetHours: number): string {
  const sign = offsetHours < 0 ? '-' : '+';
  const hh = String(Math.abs(offsetHours)).padStart(2, '0');
  return new Date(ms + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, `${sign}${hh}:00`);
}

describe('tracking a family member’s flight (prod 2026-09-24)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    groupId = (await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: userId })).id;

    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: userId,
      key: 'frequent_flyer_united',
      value: 'GL779135',
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'user',
      subjectId: userId,
    });

    const now = Date.now();
    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Ben to Chicago',
      destination: 'Chicago',
      startDate: new Date(now).toISOString().slice(0, 10),
      endDate: new Date(now + 60 * 86_400_000).toISOString().slice(0, 10),
      participantIds: [],
    });
    // Departed 3h15m ago, New York offset - exactly the prod gap at 22:40Z.
    const departMs = now - (3 * 60 + 15) * 60_000;
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'LGA',
      destination: 'MDW',
      departAt: inOffset(departMs, -4),
      arriveAt: inOffset(departMs + 2.5 * 3_600_000, -5),
      carrier: 'Southwest Airlines',
      flightNo: '2714',
      passengerName: 'Ben Doe',
    });
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('keeps a flight that left three hours ago in a -04:00 offset in the window', async () => {
    const now = Date.now();
    const legs = await findUpcomingFlights(db, {
      userId,
      sinceMs: now - 6 * 3_600_000,
      untilMs: now + 30 * 86_400_000,
      limit: 20,
    });
    expect(legs.map((l) => l.flightNo)).toEqual(['2714']);
  });

  it('shows the flight to the bot by designator, with who is on it', async () => {
    const triggerMessageId = newId('m');
    await db
      .insertInto('messages')
      .values({
        id: triggerMessageId,
        group_id: groupId,
        sender_id: userId,
        kind: 'text',
        body: 'Can we track Bens flight from today',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 1,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      })
      .execute();
    const messages = await buildLlmContext(db, {
      groupId,
      isPersonal: true,
      triggerMessageId,
      triggeringUserId: userId,
      attachments: [],
      useNativeTools: true,
    });
    const sys = String(messages[0]?.content);
    expect(sys).toContain('WN2714 (Southwest Airlines) · LGA→MDW');
    expect(sys).toContain('passengers: Ben Doe');
  });

  it('flight_status by passenger name finds the leg and builds the tracker', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: { kind: 'flight_status', label: 'Track flight', query: { passengerName: 'Ben' } },
      },
    });
    expect(result.card?.url).toBe('https://www.flightaware.com/live/flight/SWA2714');
  });

  it('a shared surname is not the same person', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: { kind: 'flight_status', label: 'Track flight', query: { passengerName: 'John Doe' } },
      },
    });
    expect(result.card).toBeUndefined();
    expect((result.data as { reason?: string }).reason).toBe('no_flight_found');
  });

  it('the passenger lookup wins over a mileage number passed as the flight', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: {
          kind: 'flight_status',
          label: 'Track flight',
          query: { flightNumber: 'GL779135', passengerName: 'Ben' },
        },
      },
    });
    expect(result.card?.url).toBe('https://www.flightaware.com/live/flight/SWA2714');
  });
});

/** The system prompt the bot gets for a message in `groupId`. */
async function systemPromptFor(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  isPersonal: boolean,
  body = 'when does Ben land?',
): Promise<string> {
  const triggerMessageId = newId('m');
  await db
    .insertInto('messages')
    .values({
      id: triggerMessageId,
      group_id: groupId,
      sender_id: userId,
      kind: 'text',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 1,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  const messages = await buildLlmContext(db, {
    groupId,
    isPersonal,
    triggerMessageId,
    triggeringUserId: userId,
    attachments: [],
    useNativeTools: true,
    tz: 'America/New_York',
  });
  return String(messages[0]?.content);
}

// A family keeps a flight in the calendar as often as in Trips, and asks
// about it with the calendar in mind - the answer must be in the prompt.
describe('travel from the calendar and Trips is in the bot’s context', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let familyId: string;
  const now = Date.now();
  const day = (n: number) => new Date(now + n * 86_400_000).toISOString().slice(0, 10);

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    personalId = (await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: userId })).id;
    familyId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: userId })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a calendar-only flight in the family group shows in the personal 1:1, and tracks by name', async () => {
    await createEvent(db, {
      groupId: familyId,
      createdBy: userId,
      title: 'Ben flight UA 512 to Denver',
      startsAt: inOffset(now + 26 * 3_600_000, -4),
    });
    const sys = await systemPromptFor(db, personalId, userId, true);
    expect(sys).toContain('calendar event "Ben flight UA 512 to Denver"');
    expect(sys).toContain('flight UA512');

    const result = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: { kind: 'flight_status', label: 'Track', query: { passengerName: 'Ben' } },
      },
    });
    expect(result.card?.url).toBe('https://www.flightaware.com/live/flight/UAL512');
  });

  it('shows a train leg, a flight with no number yet, and a hotel-only trip', async () => {
    const trip = await createTrip(db, {
      groupId: familyId, createdBy: userId, name: 'Trip to PHL', destination: 'Philadelphia',
      startDate: day(2), endDate: day(4), participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'train', origin: 'NYP', destination: 'PHL',
      departAt: inOffset(now + 2 * 86_400_000, -4), arriveAt: inOffset(now + 2 * 86_400_000 + 5_400_000, -4),
      carrier: 'Amtrak', flightNo: '93', passengerName: 'DOE, BEN',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'PHL', destination: 'ORD',
      departAt: inOffset(now + 4 * 86_400_000, -4), arriveAt: inOffset(now + 4 * 86_400_000 + 7_200_000, -5),
      passengerName: 'Ben Doe',
    });
    const hotelTrip = await createTrip(db, {
      groupId: familyId, createdBy: userId, name: 'Vail weekend', destination: 'Vail',
      startDate: day(10), endDate: day(12), participantIds: [],
    });
    await addAccommodation(db, {
      tripId: hotelTrip.id, propertyName: 'Residence Inn', checkinDate: day(10), checkoutDate: day(12),
    });

    const sys = await systemPromptFor(db, personalId, userId, true);
    expect(sys).toMatch(/- train Amtrak 93 · NYP→PHL .*passengers: DOE, BEN · trip "Trip to PHL"/);
    expect(sys).toMatch(/- flight \(no flight number on file\) · PHL→ORD/);
    expect(sys).toContain('- trip "Vail weekend" to Vail');
  });

  it('leaves out a deleted trip, and lists a leg once despite its calendar copy', async () => {
    const trip = await createTrip(db, {
      groupId: familyId, createdBy: userId, name: 'Ben to Chicago', destination: 'Chicago',
      startDate: day(1), endDate: day(3), participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'MDW',
      departAt: inOffset(now + 86_400_000, -4), arriveAt: inOffset(now + 86_400_000 + 9_000_000, -5),
      carrier: 'Southwest Airlines', flightNo: '2714', passengerName: 'Ben Doe',
    });
    const gone = await createTrip(db, {
      groupId: familyId, createdBy: userId, name: 'Binned trip', destination: 'Boston',
      startDate: day(5), endDate: day(6), participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: gone.id, mode: 'flight', origin: 'LGA', destination: 'BOS',
      departAt: inOffset(now + 5 * 86_400_000, -4), arriveAt: inOffset(now + 5 * 86_400_000 + 4_000_000, -4),
      carrier: 'Delta', flightNo: '1234',
    });
    await deleteTrip(db, gone.id);

    const sys = await systemPromptFor(db, familyId, userId, false);
    expect(sys.match(/WN2714/g)?.length).toBe(1);
    expect(sys).not.toContain('DL1234');
    expect(sys).not.toContain('Binned trip');
  });
});
