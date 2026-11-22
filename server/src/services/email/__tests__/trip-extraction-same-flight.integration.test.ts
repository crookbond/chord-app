/**
 * Reported 2026-11-19: Ben's Delta DL2503 home from Chicago showed 4-5 times
 * on the calendar. The flight was first added in chat (Sep 15, "Ben", no
 * booking reference, 9:20 PM ET). Delta then moved it five minutes and its
 * email (booking HLA4A2, "BEN DOE", 8:25 PM Chicago = 9:25 PM ET) was
 * staged as a second leg on another trip in another chat: no booking reference
 * to join on, a different instant, a different group. Now the same traveler on
 * the same flight number and route, a few hours apart at most, is that flight
 * moved, and the email updates the chat-made leg in place.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { stageEmailTripProposal, type TravelClassifier } from '@/services/email/trip-extraction.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addTravelLeg, createTrip } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const isoDay = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const DAY = isoDay(40);

/** The Delta email's shape: local airport times, the moved departure. */
const DELTA_EMAIL = (confirmation: string, passengerName = 'BEN DOE'): TravelClassifier => async () => ({
  kind: 'flight',
  confirmation,
  passengerName,
  legs: [
    {
      origin: 'ORD',
      destination: 'LGA',
      departAt: `${DAY}T20:25:00`,
      arriveAt: `${DAY}T23:42:00`,
      departZone: 'America/Chicago',
      arriveZone: 'America/New_York',
      carrier: 'Delta',
      flightNo: 'DL2503',
    },
  ],
});

describe('an email for a flight already added in chat updates it', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;
  let chatLegDepart: string;

  beforeEach(async () => {
    db = await openTestDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    userId = await createUser(db, 'john', 'John Doe');
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
    // The chat booking: five minutes earlier, no booking reference, first name only.
    const emailInstant = new Date(`${DAY}T20:25:00-06:00`).getTime();
    chatLegDepart = new Date(emailInstant - 5 * 60_000).toISOString();
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Ben to Chicago', destination: 'Chicago',
      startDate: isoDay(1), endDate: DAY, participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'ORD',
      destination: 'LGA',
      departAt: chatLegDepart,
      arriveAt: new Date(new Date(`${DAY}T23:41:00-05:00`).getTime()).toISOString(),
      carrier: 'Delta',
      flightNo: '2503',
      passengerName: 'Ben',
      sourceRawContext: 'chat:m_q9-KNnUSP2GZ',
    });
    // The other trip the email used to land on, in a shared chat.
    const rdms = await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: userId });
    await createTrip(db, {
      groupId: rdms.id, createdBy: userId, name: 'Trip to ORD', destination: 'ORD',
      startDate: DAY, endDate: isoDay(50), participantIds: [],
    });
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const stage = (classify: TravelClassifier) =>
    stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: 'ema_jkPXgnLuMHPM:AQQkADAwATExAGI4Ny00YzQwLTE5NmYtMDACLTAwCgAQAP8n0u8JTXdAlQL-u3FUuAM=',
        subject: 'Your flight has changed',
        bodyText: 'Your Delta itinerary has changed. Flight DL2503 Chicago to New York, departing 8:25 PM.',
        userLastTz: 'America/New_York',
      },
      classify,
    );

  const legs = () => db.selectFrom('travel_legs').selectAll().execute();
  const flightEvents = () =>
    db
      .selectFrom('events')
      .select(['starts_at', 'external_uid'])
      .where('deleted_at', 'is', null)
      .where('external_uid', 'like', 'chord:travel_leg:%')
      .execute();

  it('moves the chat-made leg and its event, and stages no second leg', async () => {
    expect(await stage(DELTA_EMAIL('HLA4A2'))).toBe('flight');

    const pending = await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('status', '=', 'pending')
      .where('tool_name', 'in', ['create_trip', 'add_travel_leg'])
      .execute();
    expect(pending).toEqual([]);

    const rows = await legs();
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.depart_at).toISOString()).toBe(new Date(`${DAY}T20:25:00-06:00`).toISOString());
    expect(rows[0]!.confirmation).toBe('HLA4A2');

    const evs = await flightEvents();
    expect(evs).toHaveLength(1);
    expect(new Date(evs[0]!.starts_at).toISOString()).toBe(new Date(`${DAY}T20:25:00-06:00`).toISOString());
  });

  it('a different booking reference is a different booking, staged as before', async () => {
    await db.updateTable('travel_legs').set({ confirmation: 'ZZZ999' }).execute();
    await stage(DELTA_EMAIL('HLA4A2'));
    const pending = await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('status', '=', 'pending')
      .where('tool_name', '=', 'add_travel_leg')
      .execute();
    expect(pending).toHaveLength(1);
    expect(await legs()).toHaveLength(1);
    expect((await legs())[0]!.depart_at).toBe(chatLegDepart);
  });

  it('another traveler on that flight is not taken for Ben', async () => {
    await stage(DELTA_EMAIL('HLA4A2', 'NOLAN DOE'));
    expect((await legs())[0]!.depart_at).toBe(chatLegDepart);
    const pending = await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('status', '=', 'pending')
      .where('tool_name', '=', 'add_travel_leg')
      .execute();
    expect(pending).toHaveLength(1);
  });
});
