/**
 * ADR 0158 — an itinerary email goes through the SAME trip classifier the
 * attachment path uses, and stages a proposal BUNDLE rather than
 * auto-committing. Booking.com / Expedia send the itinerary in the body with
 * no attachment, so before this they only ever produced a stray `create_event`
 * or `add_list_item`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  stageEmailTripProposal,
  type TravelClassifier,
} from '@/services/email/trip-extraction.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createPerson } from '@/services/people.service.js';
import type { TripCancellationPayload } from '@/services/proactive.service.js';
import { addAccommodation, addTravelLeg, createTrip } from '@/services/trips.service.js';
import { shiftYear, zonedDatetime } from '@/services/bot/trip_classifier.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);

// A fixed literal date rots into a silently non-writing test the day it goes
// past (ADR 0100/0158) — the fixture is relative.
const FLY_OUT = isoDay(60);
const FLY_BACK = isoDay(64);
const FLIGHT: TravelClassifier = async () => ({
  kind: 'flight',
  confirmation: 'ABC123',
  itineraryNumber: '73541634338201',
  passengerName: 'Simon Stone',
  legs: [
    {
      origin: 'JFK',
      destination: 'DEN',
      departAt: `${FLY_OUT}T08:00:00`,
      arriveAt: `${FLY_OUT}T10:30:00`,
      departZone: 'America/New_York',
      arriveZone: 'America/Denver',
      carrier: 'United',
      flightNo: 'UA123',
    },
    {
      origin: 'DEN',
      destination: 'JFK',
      departAt: `${FLY_BACK}T17:00:00`,
      arriveAt: `${FLY_BACK}T23:00:00`,
      departZone: 'America/Denver',
      arriveZone: 'America/New_York',
      carrier: 'United',
      flightNo: 'UA456',
    },
  ],
});

const HOTEL: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'Kilima Safari Camp',
  address: 'Amboseli National Park',
  checkinDate: isoDay(30),
  checkoutDate: isoDay(34),
  roomCount: 1,
  confirmation: 'KTO5569',
});

const TRAIN: TravelClassifier = async () => ({
  kind: 'flight',
  confirmation: 'RAIL99',
  itineraryNumber: 'AMTK-55501',
  legs: [
    {
      origin: 'NYP',
      destination: 'WAS',
      // Relative: a fixed 2026-10-21 became a past trip on the 22nd and was
      // (correctly) dropped, failing this test for a reason it is not about.
      departAt: `${isoDay(21)}T09:05:00`,
      arriveAt: `${isoDay(21)}T12:35:00`,
      departZone: 'America/New_York',
      arriveZone: 'America/New_York',
      carrier: 'Amtrak',
      flightNo: '135',
      mode: 'train',
    },
  ],
});

const MARKETING: TravelClassifier = async () => ({ kind: 'other' });

type LegSpec = readonly [string, string, string, string, string, string];
/** [origin, destination, departLocal, arriveLocal, departZone, arriveZone] */
function flightDoc(passengerName: string | undefined, confirmation: string, legs: LegSpec[]): TravelClassifier {
  return async () => ({
    kind: 'flight',
    confirmation,
    passengerName,
    legs: legs.map(([origin, destination, departAt, arriveAt, departZone, arriveZone]) => ({
      origin,
      destination,
      departAt,
      arriveAt,
      departZone,
      arriveZone,
    })),
  });
}

/** Round trip whose outbound already flew but the return is still ahead. */
const STRADDLE: TravelClassifier = async () => ({
  kind: 'flight',
  confirmation: 'STR001',
  legs: [
    {
      origin: 'JFK',
      destination: 'LHR',
      departAt: `${isoDay(-6)}T20:00:00`,
      arriveAt: `${isoDay(-5)}T08:00:00`,
      departZone: 'America/New_York',
      arriveZone: 'Europe/London',
    },
    {
      origin: 'LHR',
      destination: 'JFK',
      departAt: `${isoDay(9)}T11:00:00`,
      arriveAt: `${isoDay(9)}T14:00:00`,
      departZone: 'Europe/London',
      arriveZone: 'America/New_York',
    },
  ],
});

/** Entirely in the past. */
const PAST_TRIP: TravelClassifier = async () => ({
  kind: 'flight',
  confirmation: 'OLD001',
  legs: [
    {
      origin: 'JFK',
      destination: 'MIA',
      departAt: `${isoDay(-20)}T09:00:00`,
      arriveAt: `${isoDay(-20)}T12:00:00`,
      departZone: 'America/New_York',
      arriveZone: 'America/New_York',
    },
  ],
});

const PAST_HOTEL: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'The Old Inn',
  checkinDate: isoDay(-10),
  checkoutDate: isoDay(-7),
});

const BODY =
  'Your booking is confirmed. Itinerary details, passenger, flight numbers and ' +
  'times are all included in this message. Thank you for booking with us.';

/** Same window as FLIGHT (isoDay(60)–isoDay(64)) — the flight and hotel for
 *  one trip, arriving as two separate emails (ADR 0173). */
const OVERLAPPING_HOTEL: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'Evergreen Lodge at Vail',
  address: '250 S Frontage Rd W, Vail, CO',
  checkinDate: FLY_OUT,
  checkoutDate: FLY_BACK,
  confirmation: 'EXP998877',
});

/** Same window as FLIGHT, in the city FLIGHT flies into (DEN is Denver) — the
 *  hotel that genuinely belongs on that trip. */
const DENVER_HOTEL: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'Hotel Teatro',
  address: '1100 14th St, Denver, CO',
  checkinDate: FLY_OUT,
  checkoutDate: FLY_BACK,
  confirmation: 'DEN55501',
});

// The classifier guessed a year too early (ADR 0167's failure mode) — same
// month/day as FLY_OUT/FLY_BACK, one year off. A non-invite .ics on the same
// message (ADR 0175/0177) carries the real year via icsDateHint.
const WRONG_YEAR_HOTEL: TravelClassifier = async () => ({
  kind: 'hotel',
  propertyName: 'Evergreen Lodge at Vail',
  address: '250 S Frontage Rd W, Vail, CO',
  checkinDate: shiftYear(FLY_OUT, -1),
  checkoutDate: shiftYear(FLY_BACK, -1),
  confirmation: 'EXP998877',
});

describe('stageEmailTripProposal (ADR 0158)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;

  const stage = (gid: string, classify: TravelClassifier, icsDateHint?: string) =>
    stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: gid,
        subject: 'Booking confirmed',
        bodyText: BODY,
        userLastTz: 'America/New_York',
        icsDateHint,
      },
      classify,
    );

  const proposals = () =>
    db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .execute();

  // Trip-bundle rows only — a flight with a non-owner passenger also stages an
  // `add_person` proposal (ADR 0158), asserted separately.
  const tripProposals = async () =>
    (await proposals()).filter((r) => r.tool_name !== 'add_person');

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'traveller');
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a flight email stages a create_trip + one add_travel_leg per leg, one bundle', async () => {
    const kind = await stage('t_flight', FLIGHT);
    expect(kind).toBe('flight');

    const rows = await tripProposals();
    const byTool = rows.reduce<Record<string, number>>((m, r) => {
      m[r.tool_name] = (m[r.tool_name] ?? 0) + 1;
      return m;
    }, {});
    expect(byTool).toEqual({ create_trip: 1, add_travel_leg: 2 });

    // One bundle, gmail provenance.
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1);
    expect(rows.every((r) => r.provenance === 'gmail:t_flight')).toBe(true);
    expect(rows.every((r) => r.bundle_id !== null)).toBe(true);

    // The ticket time was anchored to the origin airport's zone, not UTC, and
    // the leg carries the booking-site itinerary number + passenger (ADR 0158).
    const leg = JSON.parse(
      rows.find((r) => r.tool_name === 'add_travel_leg')!.args_json,
    ) as { departAt: string; notes?: string; personaName?: string; mode: string };
    expect(leg.departAt).toMatch(new RegExp(`^${FLY_OUT}T08:00:00-0[45]:00$`));
    expect(leg.notes).toBe('Itinerary 73541634338201');
    expect(leg.personaName).toBe('Simon Stone');
    expect(leg.mode).toBe('flight');
  });

  it('a rail itinerary is held too — legs carry mode:train', async () => {
    expect(await stage('t_rail', TRAIN)).toBe('flight');
    const rows = await proposals();
    expect(rows.map((r) => r.tool_name).sort()).toEqual(['add_travel_leg', 'create_trip']);
    const leg = JSON.parse(
      rows.find((r) => r.tool_name === 'add_travel_leg')!.args_json,
    ) as { mode: string; carrier?: string; notes?: string };
    expect(leg.mode).toBe('train');
    expect(leg.carrier).toBe('Amtrak');
    expect(leg.notes).toBe('Itinerary AMTK-55501');
  });

  it('a hotel email stages create_trip + add_accommodation', async () => {
    expect(await stage('t_hotel', HOTEL)).toBe('hotel');
    const tools = (await proposals()).map((r) => r.tool_name).sort();
    expect(tools).toEqual(['add_accommodation', 'create_trip']);
  });

  it('a non-invite .ics date hint corrects a wrong-year guess (ADR 0177)', async () => {
    // Without the hint the wrong year would look like history and stage
    // nothing at all — the past-stay guard runs on the (corrected) date.
    expect(await stage('t_wrongyear_nohint', WRONG_YEAR_HOTEL)).toBe('none');

    expect(await stage('t_wrongyear_hinted', WRONG_YEAR_HOTEL, FLY_OUT)).toBe('hotel');
    const rows = await tripProposals();
    const trip = JSON.parse(rows.find((r) => r.tool_name === 'create_trip')!.args_json) as {
      startDate: string; endDate: string;
    };
    const accom = JSON.parse(rows.find((r) => r.tool_name === 'add_accommodation')!.args_json) as {
      checkinDate: string; checkoutDate: string;
    };
    expect(trip.startDate).toBe(FLY_OUT);
    expect(trip.endDate).toBe(FLY_BACK);
    expect(accom.checkinDate).toBe(FLY_OUT);
    expect(accom.checkoutDate).toBe(FLY_BACK);
  });

  it('when a trip already covers the dates, stages the legs against it — no create_trip', async () => {
    await createTrip(db, {
      groupId: personalGroupId,
      createdBy: userId,
      name: 'Denver',
      destination: 'Denver',
      startDate: isoDay(58),
      endDate: isoDay(66),
      participantIds: [],
    });
    expect(await stage('t_flight2', FLIGHT)).toBe('flight');

    const rows = await tripProposals();
    expect(rows.map((r) => r.tool_name).sort()).toEqual(['add_travel_leg', 'add_travel_leg']);
    for (const r of rows) {
      expect((JSON.parse(r.args_json) as { tripId?: string }).tripId).toBeTruthy();
    }
  });

  it('an already-booked flight is reported handled, not re-staged as a duplicate (ADR 0185)', async () => {
    // First email: stage + confirm — mirrors the attachment path's
    // auto-commit having already put this flight on the calendar.
    await stage('t_committed', FLIGHT);
    const lead = (await tripProposals()).find((r) => r.tool_name === 'create_trip')!;
    const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    // A second email for the SAME flight (a second passenger's ticket, or an
    // itinerary-change resend) — every leg it describes already exists.
    const result = await stage('t_second_copy', FLIGHT);
    expect(result).toBe('flight'); // not 'none' — 'none' would fall through
    // to the general magics extractor and stage a duplicate create_event.
    expect(await tripProposals()).toHaveLength(0);
  });

  it('an already-booked stay is reported handled, not re-staged as a duplicate (ADR 0185)', async () => {
    await stage('t_hotel_committed', HOTEL);
    const lead = (await tripProposals()).find((r) => r.tool_name === 'create_trip')!;
    const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    const result = await stage('t_hotel_second_copy', HOTEL);
    expect(result).toBe('hotel'); // not 'none'
    expect(await tripProposals()).toHaveLength(0);
  });

  it('a flight and a hotel mined separately, neither confirmed yet, land in ONE bundle (ADR 0173)', async () => {
    expect(await stage('t_flight_pending', FLIGHT)).toBe('flight');
    expect(await stage('t_hotel_pending', DENVER_HOTEL)).toBe('hotel');

    const rows = await tripProposals();
    const byTool = rows.reduce<Record<string, number>>((m, r) => {
      m[r.tool_name] = (m[r.tool_name] ?? 0) + 1;
      return m;
    }, {});
    // Exactly one create_trip — the hotel found the flight's PENDING bundle
    // instead of minting its own.
    expect(byTool).toEqual({ create_trip: 1, add_travel_leg: 2, add_accommodation: 1 });
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(1);

    // Confirming that one bundle produces exactly one trip carrying both legs
    // and the accommodation.
    const lead = rows.find((r) => r.tool_name === 'create_trip')!;
    const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    const trips = await db.selectFrom('trips').selectAll().where('group_id', '=', personalGroupId).execute();
    expect(trips).toHaveLength(1);
    const legs = await db.selectFrom('travel_legs').selectAll().where('trip_id', '=', trips[0]!.id).execute();
    expect(legs).toHaveLength(2);
    const accoms = await db.selectFrom('accommodations').selectAll().where('trip_id', '=', trips[0]!.id).execute();
    expect(accoms).toHaveLength(1);
    expect(accoms[0]!.property_name).toBe('Hotel Teatro');
  });

  it('a Vail hotel does not join a pending flight to Denver: place AND dates, not dates alone', async () => {
    // Real prod shape: a flight into DEN and a hotel in Vail are different
    // places to Chord (owner's call: getting from the airport to the resort is
    // the traveler's own business), so the hotel stages its own bundle.
    expect(await stage('t_flight_den', FLIGHT)).toBe('flight');
    expect(await stage('t_hotel_vail', OVERLAPPING_HOTEL)).toBe('hotel');
    const rows = await tripProposals();
    expect(rows.filter((r) => r.tool_name === 'create_trip')).toHaveLength(2);
  });

  it('two travelers with overlapping dates and nothing in common do not share a pending bundle', async () => {
    // Alice's Amtrak weekend vs the in-laws' long-haul flight — the real
    // bug, one step earlier: both unconfirmed, dates overlapping.
    const inLaws = flightDoc('Simon Stone', 'DELJFK', [
      ['DEL', 'JFK', `${isoDay(50)}T02:00:00`, `${isoDay(50)}T09:00:00`, 'Asia/Kolkata', 'America/New_York'],
    ]);
    const weekend = flightDoc('Alice Stone', 'AMTK77', [
      ['NYP', 'WAS', `${isoDay(52)}T08:05:00`, `${isoDay(52)}T11:33:00`, 'America/New_York', 'America/New_York'],
    ]);
    expect(await stage('t_inlaws', inLaws)).toBe('flight');
    expect(await stage('t_weekend', weekend)).toBe('flight');
    const rows = await tripProposals();
    expect(rows.filter((r) => r.tool_name === 'create_trip')).toHaveLength(2);
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(2);
  });

  it('a companion on the very same flight joins that pending bundle', async () => {
    const leg = ['DEL', 'JFK', `${isoDay(50)}T02:00:00`, `${isoDay(50)}T09:00:00`, 'Asia/Kolkata', 'America/New_York'] as const;
    expect(await stage('t_simon', flightDoc('Simon Stone', 'DELJFK', [[...leg]]))).toBe('flight');
    expect(await stage('t_kate', flightDoc('Kate Stone', 'DELJFK', [[...leg]]))).toBe('flight');
    const rows = await tripProposals();
    expect(rows.filter((r) => r.tool_name === 'create_trip')).toHaveLength(1);
    expect(rows.filter((r) => r.tool_name === 'add_travel_leg')).toHaveLength(2);
  });

  it("the same traveler's return, arriving in its own email, joins the outbound's pending bundle", async () => {
    const out = flightDoc('Ben Doe', 'OUT111', [
      ['LGA', 'MDW', `${isoDay(40)}T15:25:00`, `${isoDay(40)}T16:55:00`, 'America/New_York', 'America/Chicago'],
    ]);
    const back = flightDoc('DOE BEN', 'BACK222', [
      ['ORD', 'LGA', `${isoDay(55)}T20:20:00`, `${isoDay(55)}T23:40:00`, 'America/Chicago', 'America/New_York'],
    ]);
    expect(await stage('t_out', out)).toBe('flight');
    expect(await stage('t_back', back)).toBe('flight');
    const rows = await tripProposals();
    expect(rows.filter((r) => r.tool_name === 'create_trip')).toHaveLength(1);
  });

  it('a pending bundle outside the date window is not reused', async () => {
    expect(await stage('t_flight_far', FLIGHT)).toBe('flight'); // isoDay(60)-64
    expect(await stage('t_hotel_far', HOTEL)).toBe('hotel'); // isoDay(30)-34, no overlap

    const rows = await tripProposals();
    // Two separate bundles — the hotel's window doesn't overlap the flight's
    // pending trip, so it correctly minted its own.
    expect(new Set(rows.map((r) => r.bundle_id)).size).toBe(2);
    expect(rows.filter((r) => r.tool_name === 'create_trip')).toHaveLength(2);
  });

  it('marketing / non-travel classification stages nothing', async () => {
    expect(await stage('t_promo', MARKETING)).toBe('none');
    expect(await proposals()).toHaveLength(0);
  });

  it('a trip that is entirely in the past stages nothing (no past-dated proposal)', async () => {
    expect(await stage('t_old', PAST_TRIP)).toBe('none');
    expect(await proposals()).toHaveLength(0);
    expect(await stage('t_oldhotel', PAST_HOTEL)).toBe('none');
    expect(await proposals()).toHaveLength(0);
  });

  it('a mid-trip flight change keeps only the legs still ahead', async () => {
    expect(await stage('t_straddle', STRADDLE)).toBe('flight');
    const rows = await proposals();
    // The already-flown outbound is dropped; only the return leg is staged.
    expect(rows.filter((r) => r.tool_name === 'add_travel_leg')).toHaveLength(1);
    const leg = JSON.parse(
      rows.find((r) => r.tool_name === 'add_travel_leg')!.args_json,
    ) as { origin: string; destination: string };
    expect([leg.origin, leg.destination]).toEqual(['LHR', 'JFK']);
    const trip = JSON.parse(
      rows.find((r) => r.tool_name === 'create_trip')!.args_json,
    ) as { startDate: string };
    expect(trip.startDate >= new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('proposes a non-owner passenger as a person', async () => {
    await db.updateTable('users').set({ display_name: 'John Doe' }).where('id', '=', userId).execute();
    await stage('t_pax', FLIGHT); // passengerName: "Simon Stone"
    const person = (await proposals()).find((r) => r.tool_name === 'add_person');
    expect(person).toBeTruthy();
    expect((JSON.parse(person!.args_json) as { displayName: string }).displayName).toBe('Simon Stone');
  });

  it('does not propose the account owner as a person', async () => {
    await db.updateTable('users').set({ display_name: 'Simon Stone' }).where('id', '=', userId).execute();
    await stage('t_self', FLIGHT);
    expect((await proposals()).some((r) => r.tool_name === 'add_person')).toBe(false);
  });

  it('does not re-propose a passenger already in People', async () => {
    await db.updateTable('users').set({ display_name: 'John Doe' }).where('id', '=', userId).execute();
    await createPerson(db, { ownerUserId: userId, displayName: 'Simon Stone' });
    await stage('t_known', FLIGHT);
    expect((await proposals()).some((r) => r.tool_name === 'add_person')).toBe(false);
  });

  it('does not stage a second bundle for the same thread', async () => {
    await stage('t_dup', FLIGHT);
    const first = (await proposals()).length;
    expect(await stage('t_dup', FLIGHT)).toBe('flight'); // reports the kind, stages nothing new
    expect((await proposals()).length).toBe(first);
  });

  it('confirming the bundle creates the trip and its legs', async () => {
    await stage('t_confirm', FLIGHT);
    const lead = (await proposals()).find((r) => r.tool_name === 'create_trip')!;
    const bundleId = lead.bundle_id!;

    const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    const trips = await db
      .selectFrom('trips')
      .selectAll()
      .where('group_id', '=', personalGroupId)
      .execute();
    expect(trips).toHaveLength(1);
    const legs = await db
      .selectFrom('travel_legs')
      .selectAll()
      .where('trip_id', '=', trips[0]!.id)
      .execute();
    expect(legs).toHaveLength(2);
    // Whole bundle consumed.
    expect(
      await db
        .selectFrom('proposals')
        .selectAll()
        .where('bundle_id', '=', bundleId)
        .where('status', '=', 'pending')
        .execute(),
    ).toHaveLength(0);
  });

  it("the flight legs' calendar events carry the booking IDs + a link back to the email", async () => {
    const now = new Date().toISOString();
    await db.updateTable('users').set({ email: 'traveller@gmail.com' }).where('id', '=', userId).execute();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
        gmail_thread_id: 'abc123thread',
        subject: 'Your flight',
        snippet: 's',
        from_email: 'noreply@booking.com',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    await stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: 'abc123thread',
        subject: 'Your flight',
        bodyText: BODY,
        userLastTz: 'America/New_York',
      },
      FLIGHT,
    );
    const lead = (await proposals()).find((r) => r.tool_name === 'create_trip')!;
    await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });

    const evt = await db
      .selectFrom('events')
      .select(['title', 'description'])
      .where('group_id', '=', personalGroupId)
      .where('title', 'like', '%JFK%')
      .executeTakeFirstOrThrow();
    expect(evt.description).toContain('Confirmation: ABC123');
    expect(evt.description).toContain('Itinerary 73541634338201');
    expect(evt.description).toContain('Passenger: Simon Stone');
    expect(evt.description).toContain('https://mail.google.com/mail/u/0/');
    expect(evt.description).toContain('#all/abc123thread');
  });
});

describe('stageEmailTripProposal applies a cancellation directly (ADR 0168)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;

  const stage = (gid: string, classify: TravelClassifier) =>
    stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: gid,
        subject: 'Cancellation notice',
        bodyText: BODY,
        userLastTz: 'America/New_York',
      },
      classify,
    );

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'traveller2');
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('cancels a matching accommodation and, with no other live legs/stays, the trip too', async () => {
    const checkinDate = isoDay(30);
    const checkoutDate = isoDay(34);
    const trip = await createTrip(db, {
      groupId: personalGroupId,
      createdBy: userId,
      name: 'Vail',
      destination: 'Vail',
      startDate: checkinDate,
      endDate: checkoutDate,
      participantIds: [],
    });
    const accom = await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Residence Inn by Marriott Vail',
      checkinDate,
      checkoutDate,
      confirmation: 'ZO-AX1057-43807',
    });

    const CANCEL_HOTEL: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'hotel',
      propertyName: 'Residence Inn by Marriott Vail',
      checkinDate,
      checkoutDate,
      confirmation: 'ZO-AX1057-43807',
    });
    expect(await stage('t_cancel_hotel', CANCEL_HOTEL)).toBe('cancellation');

    const cancelledAccom = await db
      .selectFrom('accommodations')
      .select('cancelled_at')
      .where('id', '=', accom.id)
      .executeTakeFirstOrThrow();
    expect(cancelledAccom.cancelled_at).toBeTruthy();

    const cancelledTrip = await db
      .selectFrom('trips')
      .select('cancelled_at')
      .where('id', '=', trip.id)
      .executeTakeFirstOrThrow();
    expect(cancelledTrip.cancelled_at).toBeTruthy();

    // Never staged as a proposal — a cancellation is applied, not confirmed.
    const pending = await db
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(0);

    // ADR 0169 — a full-trip cancellation still gets a heads-up nudge, with
    // no dangling "what's still booked" (nothing is).
    const nudge = await db
      .selectFrom('proactive_messages')
      .select(['group_id', 'persona_id', 'payload'])
      .where('kind', '=', 'trip_cancellation')
      .executeTakeFirstOrThrow();
    expect(nudge.group_id).toBe(trip.groupId);
    expect(nudge.persona_id).toBe(userId);
    const payload = JSON.parse(nudge.payload) as TripCancellationPayload;
    expect(payload.remainingItems).toHaveLength(0);
    expect(payload.cancelledItems[0]).toContain('Residence Inn by Marriott Vail');
  });

  it('a cancelled leg does not cancel the trip while a return leg is still live', async () => {
    const out = isoDay(60);
    const back = isoDay(64);
    const trip = await createTrip(db, {
      groupId: personalGroupId,
      createdBy: userId,
      name: 'Denver',
      destination: 'Denver',
      startDate: out,
      endDate: back,
      participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'JFK',
      destination: 'DEN',
      departAt: `${out}T08:00:00-04:00`,
      arriveAt: `${out}T10:30:00-06:00`,
      flightNo: 'UA123',
      confirmation: 'ABC123',
    });
    const returnLeg = await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'DEN',
      destination: 'JFK',
      departAt: `${back}T17:00:00-06:00`,
      arriveAt: `${back}T23:00:00-04:00`,
      flightNo: 'UA456',
      confirmation: 'ABC123',
    });

    const CANCEL_OUTBOUND: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'flight',
      confirmation: 'ABC123',
      legs: [{ origin: 'JFK', destination: 'DEN', departAt: `${out}T08:00:00` }],
    });
    expect(await stage('t_cancel_leg', CANCEL_OUTBOUND)).toBe('cancellation');

    const legs = await db
      .selectFrom('travel_legs')
      .select(['id', 'cancelled_at'])
      .where('trip_id', '=', trip.id)
      .execute();
    const outbound = legs.find((l) => l.id !== returnLeg.id)!;
    const stillReturn = legs.find((l) => l.id === returnLeg.id)!;
    expect(outbound.cancelled_at).toBeTruthy();
    expect(stillReturn.cancelled_at).toBeFalsy();

    const tripRow = await db
      .selectFrom('trips')
      .select('cancelled_at')
      .where('id', '=', trip.id)
      .executeTakeFirstOrThrow();
    expect(tripRow.cancelled_at).toBeFalsy(); // one leg is still live

    // ADR 0169 — the gap nudge names the return leg as still booked.
    const nudge = await db
      .selectFrom('proactive_messages')
      .select('payload')
      .where('kind', '=', 'trip_cancellation')
      .executeTakeFirstOrThrow();
    const payload = JSON.parse(nudge.payload) as TripCancellationPayload;
    expect(payload.remainingItems).toHaveLength(1);
    expect(payload.remainingItems[0]).toContain('UA456');
    expect(payload.cancelledItems[0]).toContain('UA123');
  });

  it('a shared PNR across both legs does not risk cancelling the wrong one', async () => {
    // Insertion order REVERSED from the test above — the return leg exists
    // in the table before the outbound does — to prove the match is chosen
    // by route+date, not by whichever row a confirmation-only scan returns
    // first (ADR 0168's matcher-order fix).
    const out = isoDay(60);
    const back = isoDay(64);
    const trip = await createTrip(db, {
      groupId: personalGroupId,
      createdBy: userId,
      name: 'Denver',
      destination: 'Denver',
      startDate: out,
      endDate: back,
      participantIds: [],
    });
    const returnLeg = await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'DEN',
      destination: 'JFK',
      departAt: `${back}T17:00:00-06:00`,
      arriveAt: `${back}T23:00:00-04:00`,
      flightNo: 'UA456',
      confirmation: 'SHARED1',
    });
    const outboundLeg = await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'JFK',
      destination: 'DEN',
      departAt: `${out}T08:00:00-04:00`,
      arriveAt: `${out}T10:30:00-06:00`,
      flightNo: 'UA123',
      confirmation: 'SHARED1',
    });

    const CANCEL_RETURN: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'flight',
      confirmation: 'SHARED1',
      legs: [{ origin: 'DEN', destination: 'JFK', departAt: `${back}T17:00:00` }],
    });
    expect(await stage('t_shared_pnr', CANCEL_RETURN)).toBe('cancellation');

    const legs = await db
      .selectFrom('travel_legs')
      .select(['id', 'cancelled_at'])
      .where('trip_id', '=', trip.id)
      .execute();
    expect(legs.find((l) => l.id === returnLeg.id)!.cancelled_at).toBeTruthy();
    expect(legs.find((l) => l.id === outboundLeg.id)!.cancelled_at).toBeFalsy();
  });

  it('a cancellation with no matching trip is a safe no-op', async () => {
    const CANCEL_UNKNOWN: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'hotel',
      propertyName: 'Some Other Hotel',
      checkinDate: isoDay(30),
      checkoutDate: isoDay(34),
    });
    expect(await stage('t_cancel_unknown', CANCEL_UNKNOWN)).toBe('none');
    expect(
      await db.selectFrom('trips').select('id').where('group_id', '=', personalGroupId).execute(),
    ).toHaveLength(0);
  });

  it('a rebooking for the same dates after a cancellation creates a fresh trip', async () => {
    const checkinDate = isoDay(30);
    const checkoutDate = isoDay(34);
    const trip = await createTrip(db, {
      groupId: personalGroupId,
      createdBy: userId,
      name: 'Vail',
      destination: 'Vail',
      startDate: checkinDate,
      endDate: checkoutDate,
      participantIds: [],
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Residence Inn by Marriott Vail',
      checkinDate,
      checkoutDate,
      confirmation: 'OLD-CONF',
    });
    await db
      .updateTable('trips')
      .set({ cancelled_at: new Date().toISOString() })
      .where('id', '=', trip.id)
      .execute();

    const REBOOK_HOTEL: TravelClassifier = async () => ({
      kind: 'hotel',
      propertyName: 'Sonnenalp Hotel',
      checkinDate,
      checkoutDate,
      confirmation: 'NEW-CONF',
    });
    expect(await stage('t_rebook', REBOOK_HOTEL)).toBe('hotel');

    // A fresh create_trip proposal, not add_accommodation onto the dead trip
    // — findTripByDateRange excluded the cancelled row, so there was nothing
    // to attach to.
    const rows = await db
      .selectFrom('proposals')
      .select(['tool_name', 'args_json'])
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .execute();
    expect(rows.map((r) => r.tool_name).sort()).toEqual(['add_accommodation', 'create_trip']);
    const accomArgs = JSON.parse(
      rows.find((r) => r.tool_name === 'add_accommodation')!.args_json,
    ) as { tripId?: string };
    expect(accomArgs.tripId).not.toBe(trip.id);
  });
});

describe('runEmailMagics short-circuits a travel thread into a trip bundle', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'mailer');
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  it('stages the bundle, marks the thread, and never calls the LLM extractor', async () => {
    const gid = 't_booking';
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'New York – Denver flight booking details',
        snippet: 'booking',
        from_email: 'noreply@booking.com',
        is_unread: 1,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'New York – Denver flight booking details',
        snippet: 'booking',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: BODY,
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'travel/flights', parentId: null, title: 'Flights', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'travel/flights' }],
    });

    let extractorCalls = 0;
    const extractor: EmailExtractor = {
      async extract() {
        extractorCalls += 1;
        return null;
      },
    };

    const result = await runEmailMagics(db, userId, { extractor, tripClassifier: FLIGHT });

    expect(result.trips).toBe(1);
    expect(extractorCalls).toBe(0); // the travel short-circuit ran instead
    const props = await db
      .selectFrom('proposals')
      .select(['tool_name', 'provenance'])
      .where('proposed_by_user_id', '=', userId)
      .execute();
    expect(props.map((p) => p.tool_name).sort()).toEqual([
      'add_person', // the non-owner passenger (ADR 0158)
      'add_travel_leg',
      'add_travel_leg',
      'create_trip',
    ]);
    expect(props.every((p) => p.provenance === `gmail:${gid}`)).toBe(true);

    // Marked, so a second run does nothing.
    const again = await runEmailMagics(db, userId, { extractor, tripClassifier: FLIGHT });
    expect(again.trips).toBe(0);
    expect(again.processed).toBe(0);
  });

  it('a second email for an already-committed flight never reaches the general extractor (ADR 0185)', async () => {
    // A trip already exists for this flight — e.g. the attachment path's
    // auto-commit (ADR 0071/0158), which runs outside runEmailMagics
    // entirely and so leaves no provenance the general extractor could key
    // off. Reproduced here via stage+confirm, which lands the same shape.
    const personal = await ensurePersonalGroup(db, userId);
    const staged = await stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId: personal.id,
        gmailThreadId: 't_already_booked',
        subject: 'Booking confirmed',
        bodyText: BODY,
        userLastTz: 'America/New_York',
      },
      FLIGHT,
    );
    expect(staged).toBe('flight');
    const lead = await db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'create_trip')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow();
    await confirmProposal(db, { id: lead.id, resolvedByUserId: userId });

    // A second, independent thread forwarding the same flight (a second
    // passenger's ticket, or an itinerary-change resend).
    const gid = 't_dup_flight';
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Fwd: Flight confirmation',
        snippet: 'booking',
        from_email: 'noreply@airline.com',
        is_unread: 1,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'Fwd: Flight confirmation',
        snippet: 'booking',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        body_excerpt: BODY,
        ics_text: '',
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'travel/flights', parentId: null, title: 'Flights', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'travel/flights' }],
    });

    let extractorCalls = 0;
    const extractor: EmailExtractor = {
      async extract() {
        extractorCalls += 1;
        return null;
      },
    };
    const result = await runEmailMagics(db, userId, { extractor, tripClassifier: FLIGHT });

    // The bug: 'none' from the matched-duplicate branch fell through to the
    // general extractor, which staged its own create_event for the same
    // flight.
    expect(extractorCalls).toBe(0);
    const dupThreadProposals = await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('proposed_by_user_id', '=', userId)
      .where('provenance', '=', `gmail:${gid}`)
      .execute();
    expect(dupThreadProposals).toHaveLength(0);
    expect(result.trips).toBeGreaterThanOrEqual(1);
  });

  it('prod incident: two Air India eTickets + an itinerary-change resend for one flight produce no duplicate events (ADR 0185)', async () => {
    // Reproduces the actual prod incident verbatim (ownertest@gmail.com,
    // 2026-09-18): PNR 7CTFHU, Air India AI105 DEL→EWR, two passengers.
    // The attachment path (classifyAndAutoFileAttachment, ADR 0071/0158)
    // auto-commits outside runEmailMagics and leaves source_raw_context
    // empty on the legs it creates — reproduced directly via
    // createTrip/addTravelLeg rather than through stageEmailTripProposal,
    // exactly as prod's rows looked (travel_legs.source_raw_context = '').
    // Three separate threads then each independently describe the SAME
    // flight to runEmailMagics: "...eTicket ... - SIMON",
    // "...eTicket ... - KATE", and "Fwd: Change in Itinerary".
    const personal = await ensurePersonalGroup(db, userId);
    const trip = await createTrip(db, {
      groupId: personal.id,
      createdBy: userId,
      name: 'Trip to New York',
      destination: 'EWR',
      startDate: FLY_OUT,
      endDate: FLY_OUT,
      participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'DEL',
      destination: 'EWR',
      departAt: `${FLY_OUT}T01:50:00+05:30`,
      arriveAt: `${FLY_OUT}T09:00:00-04:00`,
      carrier: 'AIR INDIA',
      flightNo: 'AI105',
      confirmation: '7CTFHU',
      passengerName: 'STONE SIMON MR',
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'DEL',
      destination: 'EWR',
      departAt: `${FLY_OUT}T01:50:00+05:30`,
      arriveAt: `${FLY_OUT}T09:00:00-04:00`,
      carrier: 'AIR INDIA',
      flightNo: 'AI105',
      confirmation: '7CTFHU',
      passengerName: 'STONE KATE MRS',
    });

    const ai105For = (passengerName: string): TravelClassifier => async () => ({
      kind: 'flight',
      confirmation: '7CTFHU',
      passengerName,
      legs: [
        {
          origin: 'DEL',
          destination: 'EWR',
          departAt: `${FLY_OUT}T01:50:00`,
          arriveAt: `${FLY_OUT}T09:00:00`,
          departZone: 'Asia/Kolkata',
          arriveZone: 'America/New_York',
          carrier: 'AIR INDIA',
          flightNo: 'AI105',
        },
      ],
    });

    const incidentThreads: Array<{ gid: string; subject: string; classifier: TravelClassifier }> = [
      {
        gid: 't_simon_eticket',
        subject: 'Fwd: Air India Web Booking eTicket (7CTFHU) - SIMON',
        classifier: ai105For('STONE SIMON MR'),
      },
      {
        gid: 't_kate_eticket',
        subject: 'Fwd: Air India Web Booking eTicket (7CTFHU) - KATE',
        classifier: ai105For('STONE KATE MRS'),
      },
      {
        gid: 't_itinerary_change',
        subject: 'Fwd: Change in Itinerary',
        classifier: ai105For('STONE SIMON MR'),
      },
    ];

    let extractorCalls = 0;
    const extractor: EmailExtractor = {
      async extract() {
        extractorCalls += 1;
        return null;
      },
    };

    for (const t of incidentThreads) {
      const now = new Date().toISOString();
      const threadRow = newId('emt');
      await db
        .insertInto('email_threads')
        .values({
          id: threadRow,
          user_id: userId,
          gmail_thread_id: t.gid,
          subject: t.subject,
          snippet: 'eTicket',
          from_email: 'noreply@airindia.com',
          is_unread: 1,
          last_message_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      await db
        .insertInto('email_messages')
        .values({
          id: newId('emm'),
          user_id: userId,
          thread_id: threadRow,
          gmail_message_id: newId('gm'),
          gmail_thread_id: t.gid,
          subject: t.subject,
          snippet: 'eTicket',
          to_emails: JSON.stringify([]),
          cc_emails: JSON.stringify([]),
          body_excerpt: BODY,
          ics_text: '',
          internal_date: now,
          created_at: now,
        })
        .execute();
      await ingestClassification(db, userId, {
        version: 1,
        userId,
        categories: [{ id: 'travel/flights', parentId: null, title: 'Flights', depth: 0 }],
        assignments: [{ gmailThreadId: t.gid, categoryId: 'travel/flights' }],
      });

      const result = await runEmailMagics(db, userId, { extractor, tripClassifier: t.classifier });
      // Every thread was recognized as (this) travel and marked handled —
      // none of them should ever fall through to the general extractor.
      expect(result.trips).toBeGreaterThanOrEqual(1);
    }

    // The actual bug: each of the three threads staged its own standalone
    // create_event, producing five calendar entries for one flight and
    // tripping ADR 0042's conflict-nudge machinery. None of that here.
    expect(extractorCalls).toBe(0);
    const pendingProposals = await db
      .selectFrom('proposals')
      .select('tool_name')
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .execute();
    expect(pendingProposals.filter((p) => p.tool_name === 'create_event')).toHaveLength(0);
    const legs = await db.selectFrom('travel_legs').selectAll().where('trip_id', '=', trip.id).execute();
    expect(legs).toHaveLength(2); // still exactly the two legs already on the books
  });
});

describe('a booking id is the booking (moved flights, cancellations across trips)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;

  const stage = (gid: string, classify: TravelClassifier) =>
    stageEmailTripProposal(
      db,
      {
        userId,
        personalGroupId,
        gmailThreadId: gid,
        subject: 'Booking notice',
        bodyText: BODY,
        userLastTz: 'America/New_York',
      },
      classify,
    );
  const localNY = (day: string, hhmm: string) =>
    zonedDatetime(`${day}T${hhmm}:00`, 'America/New_York', undefined, 'America/New_York');
  const legRows = (tripId: string) =>
    db.selectFrom('travel_legs').selectAll().where('trip_id', '=', tripId).orderBy('depart_at').execute();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'booker');
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('the same booking with a new departure time updates the leg and its calendar event — no duplicate', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Denver', destination: 'DEN',
      startDate: day, endDate: day, participantIds: [],
    });
    const original = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
      departAt: localNY(day, '08:00'), arriveAt: localNY(day, '11:00'),
      passengerName: 'Simon Stone', confirmation: 'KX8QP2', flightNo: 'UA123',
    });

    // The airline moves it three hours later and the notice arrives by email.
    const moved = flightDoc('STONE SIMON MR', 'KX8QP2', [
      ['LGA', 'DEN', `${day}T11:00:00`, `${day}T14:00:00`, 'America/New_York', 'America/New_York'],
    ]);
    expect(await stage('t_moved', moved)).toBe('flight');

    const legs = await legRows(trip.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.id).toBe(original.id);
    expect(legs[0]!.depart_at).toBe(localNY(day, '11:00'));
    expect((await db.selectFrom('proposals').selectAll().where('proposed_by_user_id', '=', userId).execute()).filter((r) => r.tool_name === 'add_travel_leg')).toHaveLength(0);
    expect(await db.selectFrom('trips').selectAll().where('group_id', '=', personalGroupId).execute()).toHaveLength(1);

    const ev = await db
      .selectFrom('events')
      .selectAll()
      .where('external_uid', '=', `chord:travel_leg:${original.id}`)
      .execute();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.starts_at).toBe(localNY(day, '11:00'));
  });

  it('adding the moved leg directly (the bot tool / a confirmed proposal) moves it too', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Denver', destination: 'DEN',
      startDate: day, endDate: day, participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'DEN',
      departAt: localNY(day, '08:00'), arriveAt: localNY(day, '11:00'), confirmation: 'KX8QP2',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'DEN',
      departAt: localNY(day, '09:30'), arriveAt: localNY(day, '12:30'), confirmation: 'KX8QP2',
    });
    expect(await legRows(trip.id)).toHaveLength(1);
  });

  it('a placeholder booking id ("N/A") never merges two different flights', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Kenya', destination: 'NBO',
      startDate: day, endDate: day, participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'NBO', destination: 'MRA',
      departAt: localNY(day, '08:00'), arriveAt: localNY(day, '09:00'), confirmation: 'N/A',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'NBO', destination: 'MRA',
      departAt: localNY(day, '15:00'), arriveAt: localNY(day, '16:00'), confirmation: 'N/A',
    });
    expect(await legRows(trip.id)).toHaveLength(2);
  });

  it('the same leg restated with a different name order and airport spelling is a duplicate, not a new leg', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Home', destination: 'LGA',
      startDate: day, endDate: day, participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'ORD', destination: 'LGA',
      departAt: '2030-01-01T20:20:00-06:00', arriveAt: '2030-01-01T23:40:00-05:00',
      passengerName: 'STONE SIMON MR',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: "Chicago O'Hare International", destination: 'New York La Guardia',
      departAt: '2030-01-01T21:20:00-05:00', arriveAt: '2030-01-01T23:40:00-05:00',
      passengerName: 'Simon Stone',
    });
    expect(await legRows(trip.id)).toHaveLength(1);
  });

  it('a cancellation finds its booking across overlapping trips, not inside whichever trip starts closest', async () => {
    const day = isoDay(40);
    // The booking's own trip starts three days BEFORE the flight...
    const kenya = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Kenya', destination: 'NBO',
      startDate: isoDay(37), endDate: isoDay(50), participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: kenya.id, mode: 'flight', origin: 'JFK', destination: 'NBO',
      departAt: localNY(day, '22:00'), arriveAt: localNY(isoDay(41), '17:00'),
      passengerName: 'John Doe', confirmation: 'QRTT99',
    });
    // ...and an unrelated trip that starts on the flight's day, so a date
    // window picks IT first and never looks at the booking.
    await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Other', destination: 'BOS',
      startDate: day, endDate: isoDay(45), participantIds: [],
    });

    const CANCEL: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'flight',
      confirmation: 'QRTT99',
      legs: [{ origin: 'JFK', destination: 'NBO', departAt: `${day}T22:00:00` }],
    });
    expect(await stage('t_cancel_overlap', CANCEL)).toBe('cancellation');
    expect((await legRows(kenya.id))[0]!.cancelled_at).not.toBeNull();
  });

  it('with no booking id, a flight two travelers are on is ambiguous and nothing is cancelled', async () => {
    const day = isoDay(40);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Doha', destination: 'DOH',
      startDate: day, endDate: isoDay(41), participantIds: [],
    });
    for (const name of ['John Doe', 'Ben Doe']) {
      await addTravelLeg(db, {
        tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'DOH',
        departAt: localNY(day, '22:00'), arriveAt: localNY(isoDay(41), '17:20'),
        passengerName: name,
      });
    }
    const CANCEL_NO_PNR: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'flight',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: `${day}T22:00:00` }],
    });
    expect(await stage('t_cancel_ambiguous', CANCEL_NO_PNR)).toBe('none');
    expect((await legRows(trip.id)).every((l) => l.cancelled_at === null)).toBe(true);
  });

  it('with the booking id, cancelling the flight cancels every passenger on that booking', async () => {
    const day = isoDay(40);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Doha', destination: 'DOH',
      startDate: day, endDate: isoDay(41), participantIds: [],
    });
    for (const name of ['John Doe', 'Ben Doe']) {
      await addTravelLeg(db, {
        tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'DOH',
        departAt: localNY(day, '22:00'), arriveAt: localNY(isoDay(41), '17:20'),
        passengerName: name, confirmation: 'QR7702',
      });
    }
    const CANCEL_PNR: TravelClassifier = async () => ({
      kind: 'cancellation',
      cancelsKind: 'flight',
      confirmation: 'QR7702',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: `${day}T22:00:00` }],
    });
    expect(await stage('t_cancel_booking', CANCEL_PNR)).toBe('cancellation');
    expect((await legRows(trip.id)).every((l) => l.cancelled_at !== null)).toBe(true);
  });

  // ── route changes under one booking reference ─────────────────────────────
  const NY = 'America/New_York';
  const seedRoundTrip = async (names: string[] = ['Simon Stone']) => {
    const day = isoDay(60);
    const back = isoDay(64);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Denver', destination: 'DEN',
      startDate: day, endDate: back, participantIds: [],
    });
    for (const name of names) {
      await addTravelLeg(db, {
        tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'DEN',
        departAt: localNY(day, '08:00'), arriveAt: localNY(day, '11:00'), passengerName: name, confirmation: 'KX8QP2',
      });
      await addTravelLeg(db, {
        tripId: trip.id, mode: 'flight', origin: 'DEN', destination: 'LGA',
        departAt: localNY(back, '17:00'), arriveAt: localNY(back, '23:00'), passengerName: name, confirmation: 'KX8QP2',
      });
    }
    return { trip, day, back };
  };
  const addProposals = async () =>
    (await db.selectFrom('proposals').selectAll().where('proposed_by_user_id', '=', userId).execute()).filter(
      (r) => r.tool_name === 'add_travel_leg',
    );
  const routes = async (tripId: string) => (await legRows(tripId)).map((l) => `${l.origin}>${l.destination}`).sort();

  it('a full itinerary that changes route replaces the old legs in place — same booking, no duplicates', async () => {
    const { trip, day, back } = await seedRoundTrip();
    const before = (await legRows(trip.id)).map((l) => l.id).sort();
    const changed = flightDoc('STONE SIMON MR', 'KX8QP2', [
      ['LGA', 'SLC', `${day}T08:00:00`, `${day}T10:30:00`, NY, 'America/Denver'],
      ['SLC', 'LGA', `${back}T17:00:00`, `${back}T23:00:00`, 'America/Denver', NY],
    ]);
    expect(await stage('t_route_full', changed)).toBe('flight');

    expect(await routes(trip.id)).toEqual(['LGA>SLC', 'SLC>LGA']);
    expect((await legRows(trip.id)).map((l) => l.id).sort()).toEqual(before); // the same rows
    expect(await addProposals()).toHaveLength(0);
    const events = await db.selectFrom('events').selectAll().where('external_uid', 'like', 'chord:travel_leg:%').execute();
    expect(events.map((e) => e.location).sort()).toEqual(['LGA → SLC', 'SLC → LGA']);
  });

  it('a one-for-one leftover is the same leg re-routed', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'Denver', destination: 'DEN',
      startDate: day, endDate: day, participantIds: [],
    });
    const original = await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'JFK', destination: 'DEN',
      departAt: localNY(day, '08:00'), arriveAt: localNY(day, '11:00'), passengerName: 'John Doe', confirmation: 'ZZ99TT',
    });
    const changed = flightDoc('John Doe', 'ZZ99TT', [
      ['BOS', 'SLC', `${day}T09:00:00`, `${day}T12:00:00`, NY, 'America/Denver'],
    ]);
    expect(await stage('t_route_one', changed)).toBe('flight');
    const legs = await legRows(trip.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.id).toBe(original.id);
    expect(`${legs[0]!.origin}>${legs[0]!.destination}`).toBe('BOS>SLC');
  });

  it('a notice naming only the changed segment replaces just the one old leg it shares an end with', async () => {
    const { trip, day } = await seedRoundTrip();
    const partial = flightDoc('Simon Stone', 'KX8QP2', [
      ['LGA', 'SLC', `${day}T08:00:00`, `${day}T10:30:00`, NY, 'America/Denver'],
    ]);
    expect(await stage('t_route_partial', partial)).toBe('flight');
    // The outbound (shares the origin) was re-routed; the return, never
    // mentioned, is untouched — nothing is removed on the strength of silence.
    expect(await routes(trip.id)).toEqual(['DEN>LGA', 'LGA>SLC']);
    expect(await addProposals()).toHaveLength(0);
  });

  it('an ambiguous change is left alone and offered as an addition, never guessed', async () => {
    const day = isoDay(60);
    const trip = await createTrip(db, {
      groupId: personalGroupId, createdBy: userId, name: 'From New York', destination: 'DEN',
      startDate: day, endDate: isoDay(61), participantIds: [],
    });
    for (const [dest, d] of [['DEN', day], ['BOS', isoDay(61)]] as const) {
      await addTravelLeg(db, {
        tripId: trip.id, mode: 'flight', origin: 'LGA', destination: dest,
        departAt: localNY(d, '08:00'), arriveAt: localNY(d, '10:00'), passengerName: 'Simon Stone', confirmation: 'KX8QP2',
      });
    }
    // The new leg shares its origin with BOTH old legs — no way to say which it replaces.
    const ambiguous = flightDoc('Simon Stone', 'KX8QP2', [
      ['LGA', 'SLC', `${day}T08:00:00`, `${day}T10:30:00`, NY, 'America/Denver'],
    ]);
    expect(await stage('t_route_ambiguous', ambiguous)).toBe('flight');
    expect(await routes(trip.id)).toEqual(['LGA>BOS', 'LGA>DEN']); // untouched
    expect(await addProposals()).toHaveLength(1); // offered, for a person to confirm
  });

  it("another passenger's legs on the same booking are never re-routed by someone else's notice", async () => {
    const { trip, day, back } = await seedRoundTrip(['John Doe', 'Alice Stone']);
    const changed = flightDoc('Alice Stone', 'KX8QP2', [
      ['LGA', 'SLC', `${day}T08:00:00`, `${day}T10:30:00`, NY, 'America/Denver'],
      ['SLC', 'LGA', `${back}T17:00:00`, `${back}T23:00:00`, 'America/Denver', NY],
    ]);
    expect(await stage('t_route_pax', changed)).toBe('flight');
    const legs = await legRows(trip.id);
    const by = (n: string) => legs.filter((l) => l.passenger_name === n).map((l) => `${l.origin}>${l.destination}`).sort();
    expect(by('Alice Stone')).toEqual(['LGA>SLC', 'SLC>LGA']);
    expect(by('John Doe')).toEqual(['DEN>LGA', 'LGA>DEN']);
  });

  it('a single leg added by hand under the same booking still adds — a route change needs the whole document', async () => {
    const { trip, day } = await seedRoundTrip();
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'LGA', destination: 'SLC',
      departAt: localNY(day, '08:00'), arriveAt: localNY(day, '10:30'), passengerName: 'Simon Stone', confirmation: 'KX8QP2',
    });
    expect(await legRows(trip.id)).toHaveLength(3);
  });

});
