/**
 * ADR 0190 — a faithful replay of the REAL ownertest@gmail.com prod trip data
 * (pulled from prod on 2026-09-18) through the new matcher, in the true
 * chronological order each leg/stay actually arrived (`created_at`), using
 * the real group membership (only John and Alice are Chord accounts in
 * either group — Ben, Nolan, Simon and Kate are raw passenger-name
 * strings, never personas, confirmed against prod's own `group_members`).
 *
 * This is not a synthetic scenario — every route/date/name/spelling below
 * is copied verbatim from the prod pull. It exists to show, honestly,
 * what this worktree actually does with the real data: where it fixes the
 * prod bug, and where real-world name/place-text variance still defeats it.
 *
 * `ingestLeg`/`ingestStay` mirror `ensureTripForFlight`/`ensureTripForHotel`
 * (trip_classifier.ts) exactly, including `resolvePassengerInGroup`'s own
 * exact-then-substring matching, reproduced inline here since that function
 * isn't exported — this is the attachment path, and every leg/stay below
 * really did arrive with a blank `source_raw_context` in prod except where
 * noted.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import {
  ensureTripForFlight,
  zonedDatetime,
  type FlightClassification,
} from '@/services/bot/trip_classifier.js';
import {
  addAccommodation,
  addTravelLeg,
  createTrip,
  findTripForStay,
  findTripForTraveler,
} from '@/services/trips.service.js';

/** Exact mirror of trip_classifier.ts's private `resolvePassengerInGroup`. */
async function resolvePassengerInGroup(db: Kysely<DB>, groupId: string, name: string): Promise<string | null> {
  const needle = name.trim().toLowerCase();
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .where('group_members.group_id', '=', groupId)
    .select(['users.id', 'users.username', 'users.display_name'])
    .execute();
  const exact = rows.find(
    (r) => r.username.toLowerCase() === needle || (r.display_name?.toLowerCase() ?? '') === needle,
  );
  if (exact) return exact.id;
  const partial = rows.find((r) => {
    const uname = r.username.toLowerCase();
    const dname = r.display_name?.toLowerCase() ?? '';
    return uname.includes(needle) || (dname && dname.includes(needle)) || needle.includes(uname) || (dname && needle.includes(dname));
  });
  return partial?.id ?? null;
}

interface LegInput {
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  carrier?: string;
  flightNo?: string;
  mode?: 'flight' | 'train' | 'car' | 'ferry' | 'other';
}

/** Mirrors `ensureTripForFlight` + its caller's personaId resolution exactly. */
async function ingestLeg(
  db: Kysely<DB>,
  opts: { groupId: string; uploadedBy: string; passengerNameRaw?: string; legs: LegInput[]; tripDestination: string },
): Promise<{ tripId: string; matched: boolean }> {
  const resolvedPersonaId = opts.passengerNameRaw
    ? await resolvePassengerInGroup(db, opts.groupId, opts.passengerNameRaw)
    : null;
  const passengerName = !resolvedPersonaId ? opts.passengerNameRaw : undefined;

  const matched = await findTripForTraveler(db, {
    userId: opts.uploadedBy,
    personaId: resolvedPersonaId,
    passengerName: resolvedPersonaId ? null : passengerName,
    legs: opts.legs,
    preferGroupId: opts.groupId,
  });

  let tripId: string;
  if (matched) {
    tripId = matched.id;
  } else {
    const allDates = opts.legs.flatMap((l) => [l.departAt.slice(0, 10), l.arriveAt.slice(0, 10)]);
    const windowStart = allDates.reduce((a, b) => (a < b ? a : b));
    const windowEnd = allDates.reduce((a, b) => (a > b ? a : b));
    const created = await createTrip(db, {
      groupId: opts.groupId,
      createdBy: opts.uploadedBy,
      name: `Trip to ${opts.legs[0]!.destination}`,
      destination: opts.tripDestination,
      startDate: windowStart,
      endDate: windowEnd,
      participantIds: [],
    });
    tripId = created.id;
  }

  for (const l of opts.legs) {
    await addTravelLeg(db, {
      tripId,
      personaId: resolvedPersonaId ?? undefined,
      passengerName: passengerName ?? undefined,
      mode: l.mode ?? 'flight',
      origin: l.origin,
      destination: l.destination,
      departAt: l.departAt,
      arriveAt: l.arriveAt,
      carrier: l.carrier,
      flightNo: l.flightNo,
    });
  }
  return { tripId, matched: !!matched };
}

/** Mirrors `ensureTripForHotel` exactly. */
async function ingestStay(
  db: Kysely<DB>,
  opts: { groupId: string; uploadedBy: string; city: string; propertyName: string; checkinDate: string; checkoutDate: string },
): Promise<{ tripId: string; matched: boolean }> {
  const matched = await findTripForStay(db, { userId: opts.uploadedBy, groupId: opts.groupId, city: opts.city, checkinDate: opts.checkinDate, checkoutDate: opts.checkoutDate });
  let tripId: string;
  if (matched) {
    tripId = matched.id;
  } else {
    const created = await createTrip(db, {
      groupId: opts.groupId,
      createdBy: opts.uploadedBy,
      name: `Trip to ${opts.city}`,
      destination: opts.city,
      startDate: opts.checkinDate,
      endDate: opts.checkoutDate,
      participantIds: [],
    });
    tripId = created.id;
  }
  await addAccommodation(db, {
    tripId,
    propertyName: opts.propertyName,
    checkinDate: opts.checkinDate,
    checkoutDate: opts.checkoutDate,
  });
  return { tripId, matched: !!matched };
}

describe('ADR 0190 replay — real ownertest@gmail.com prod trips', () => {
  let db: Kysely<DB>;
  let john: string;
  let alice: string;
  let rdms: string; // family group — real prod members: John + Alice
  let myChord: string; // personal group — John only

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'ownertest', 'John Doe');
    alice = await createUser(db, 'alice.dr.stone', 'Alice stone');
    const g1 = await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: john });
    rdms = g1.id;
    await db
      .insertInto('group_members')
      .values({ group_id: rdms, user_id: alice, role: 'member', tier: 'verified', joined_at: new Date().toISOString() })
      .execute();
    const g2 = await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: john });
    myChord = g2.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('the Kenya safari: chronological replay of every real leg/stay', async () => {
    // 1. 2026-05-19T21:47:15Z — Nairobi-Wilson→Mara-Keekorok, "MR. DOE JOHN"
    const r1 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, passengerNameRaw: 'MR. DOE JOHN', tripDestination: 'Mara-Keekorok',
      legs: [{ origin: 'Nairobi-Wilson', destination: 'Mara-Keekorok', departAt: '2026-08-03T10:30:00+03:00', arriveAt: '2026-08-03T11:10:00+03:00', carrier: 'Airkenya Express', flightNo: '853' }],
    });

    // 2. 2026-05-19T21:47:24Z — Masai Mara - Keekorok→Amboseli, no passenger
    const r2 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, tripDestination: 'Amboseli',
      legs: [{ origin: 'Masai Mara - Keekorok', destination: 'Amboseli', departAt: '2026-08-06T11:30:00+03:00', arriveAt: '2026-08-06T12:30:00+03:00', carrier: 'Mombasa Air Safari', flightNo: '002' }],
    });

    // 3. 2026-05-19T21:48:19Z — Amboseli→Diani Ukunda, no passenger
    const r3 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, tripDestination: 'Diani Ukunda',
      legs: [{ origin: 'Amboseli', destination: 'Diani Ukunda', departAt: '2026-08-08T12:45:00+03:00', arriveAt: '2026-08-08T13:45:00+03:00', carrier: 'Mombasa Air Safari', flightNo: '002' }],
    });

    // 4. 2026-05-19T21:48:53Z — Ukunda→Nairobi Wilson, no passenger
    const r4 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, tripDestination: 'Nairobi Wilson',
      legs: [{ origin: 'Ukunda', destination: 'Nairobi Wilson', departAt: '2026-08-10T16:00:00+03:00', arriveAt: '2026-08-10T17:15:00+03:00', carrier: 'Fly ALS', flightNo: 'ALS118' }],
    });

    // 5. 2026-05-22T20:52-21:02Z — the JFK<->DOH<->NBO document, 4 passengers + the DOH->NBO onward leg, all one upload
    const r5john = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, passengerNameRaw: 'John', tripDestination: 'DOH',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00', carrier: 'QATAR AIRWAYS', flightNo: 'QR 702' }],
    });
    const r5ben = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, passengerNameRaw: 'Ben', tripDestination: 'DOH',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00', carrier: 'QATAR AIRWAYS', flightNo: 'QR 702' }],
    });
    const r6 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, tripDestination: 'NBO',
      legs: [{ origin: 'DOH', destination: 'NBO', departAt: '2026-08-02T18:45:00+03:00', arriveAt: '2026-08-02T23:50:00+03:00', carrier: 'QATAR AIRWAYS', flightNo: 'QR 1341' }],
    });

    // 6. 2026-05-22T21:02:03Z — the return, DOH->JFK, no passenger
    const r7 = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, tripDestination: 'JFK',
      legs: [{ origin: 'DOH', destination: 'JFK', departAt: '2026-08-11T08:15:00+03:00', arriveAt: '2026-08-11T15:10:00-04:00', carrier: 'QATAR AIRWAYS', flightNo: 'QR 701' }],
    });

    const allTrips = await db.selectFrom('trips').where('group_id', '=', rdms).selectAll().execute();

    // Report exactly what happened — this is the honest output, not a
    // pre-decided expectation.
    console.log('=== Kenya safari replay ===');
    console.log('Mara-Keekorok leg (John, "MR. DOE JOHN"): matched existing trip?', r1.matched, 'tripId', r1.tripId);
    console.log('Amboseli leg (no passenger): matched?', r2.matched, 'tripId', r2.tripId);
    console.log('Diani leg (no passenger): matched?', r3.matched, 'tripId', r3.tripId);
    console.log('Nairobi-Wilson return leg (no passenger): matched?', r4.matched, 'tripId', r4.tripId);
    console.log('JFK->DOH John: matched?', r5john.matched, 'tripId', r5john.tripId);
    console.log('JFK->DOH Ben: matched?', r5ben.matched, 'tripId', r5ben.tripId);
    console.log('DOH->NBO (no passenger): matched?', r6.matched, 'tripId', r6.tripId);
    console.log('DOH->JFK return (no passenger): matched?', r7.matched, 'tripId', r7.tripId);
    console.log('Total distinct trips created for the whole safari:', allTrips.length);
    console.log('Trip destinations:', allTrips.map((t) => t.destination).sort());

    // OBSERVED, not aspirational: this still splits into 8 trips (WORSE
    // than prod's already-wrong 5), because almost every internal safari
    // leg carries NO passenger name in the real classifier output — there
    // is no traveler to chain by, so `findTripForTraveler`'s city-matching
    // never even runs (it only fires downstream of an identified
    // traveler). Where a name IS given ("MR. DOE JOHN"), it doesn't
    // match John's own account exactly or by substring, and place text
    // varies too much for the exact-fallback ("Masai Mara - Keekorok" vs
    // "Mara-Keekorok", "Ukunda" vs "Diani Ukunda") to bridge the gap the
    // metro table can't. This is the honest limit of "person, then group"
    // against real, sparse third-party-operator documents — flagged for
    // the owner, not silently accepted as fixed.
    expect(r1.matched).toBe(false);
    expect(r2.matched).toBe(false);
    expect(r3.matched).toBe(false);
    expect(r4.matched).toBe(false);
    expect(r5john.matched).toBe(false);
    // Ben is on John's exact flight, so he joins John's trip — companions
    // share one itinerary (ADR 0190), no name-matching needed.
    expect(r5ben.matched).toBe(true);
    expect(r5ben.tripId).toBe(r5john.tripId);
    expect(r6.matched).toBe(false);
    expect(r7.matched).toBe(false);
    expect(allTrips.length).toBe(7);
  });

  it('Alice\'s DC weekend stays hers; Simon\'s Toronto trip and his long-haul ticket are ONE trip of his', async () => {
    // 2026-08-14T16:08:52Z — Alice's Amtrak NYC<->DC weekend, one document,
    // "STONE, ALICE". THIS is the trip prod names "Trip to Washington, DC".
    const alice = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'STONE, ALICE', tripDestination: 'Washington, DC',
      legs: [
        { origin: 'New York, NY', destination: 'Washington, DC', departAt: '2026-10-21T08:05:00-04:00', arriveAt: '2026-10-21T11:33:00-04:00', carrier: 'Amtrak', flightNo: 'NORTHEAST REGIONAL 1153', mode: 'train' },
        { origin: 'Washington, DC', destination: 'New York, NY', departAt: '2026-10-23T17:15:00-04:00', arriveAt: '2026-10-23T20:35:00-04:00', carrier: 'Amtrak', flightNo: 'CAROLINIAN 80', mode: 'train' },
      ],
    });

    // 2026-09-14T19:59:13Z — Simon's Toronto round trip, one document,
    // "SIMON STONE".
    const yyz = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'SIMON STONE', tripDestination: 'YYZ',
      legs: [
        { origin: 'LGA', destination: 'YYZ', departAt: '2026-10-24T08:45:00-04:00', arriveAt: '2026-10-24T10:20:00-04:00', carrier: 'Air Canada', flightNo: '705' },
        { origin: 'YYZ', destination: 'LGA', departAt: '2026-11-15T14:00:00-05:00', arriveAt: '2026-11-15T15:38:00-05:00', carrier: 'Air Canada Jazz', flightNo: '8464' },
      ],
    });

    // 2026-09-18T14:27:01Z — Simon's Delhi<->New York ticket, one document,
    // "STONE SIMON MR" (word order swapped, honorific added). Prod filed
    // these two legs onto Alice's DC trip, because the trip's date window
    // happened to cover them.
    const longHaul = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'STONE SIMON MR', tripDestination: 'EWR',
      legs: [
        { origin: 'DEL', destination: 'EWR', departAt: '2026-10-12T01:50:00+05:30', arriveAt: '2026-10-12T09:00:00-04:00', carrier: 'AIR INDIA', flightNo: 'AI105' },
        { origin: 'JFK', destination: 'DEL', departAt: '2026-11-25T10:00:00-05:00', arriveAt: '2026-11-26T11:40:00+05:30', carrier: 'AIR INDIA', flightNo: 'AI102' },
      ],
    });

    // 2026-09-18T14:27:10Z — Kate's copy of the same itinerary,
    // "STONE KATE MRS", a separate document nine seconds later.
    const kate = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'STONE KATE MRS', tripDestination: 'EWR',
      legs: [
        { origin: 'DEL', destination: 'EWR', departAt: '2026-10-12T01:50:00+05:30', arriveAt: '2026-10-12T09:00:00-04:00', carrier: 'AIR INDIA', flightNo: 'AI105' },
        { origin: 'JFK', destination: 'DEL', departAt: '2026-11-25T10:00:00-05:00', arriveAt: '2026-11-26T11:40:00+05:30', carrier: 'AIR INDIA', flightNo: 'AI102' },
      ],
    });

    const trips = await db.selectFrom('trips').where('group_id', '=', myChord).selectAll().execute();
    console.log('=== Alice / Simon / Kate replay ===');
    console.log('Alice DC weekend tripId', alice.tripId);
    console.log('Simon YYZ matched?', yyz.matched, 'tripId', yyz.tripId);
    console.log('Simon long-haul matched?', longHaul.matched, 'tripId', longHaul.tripId);
    console.log('Kate matched?', kate.matched, 'tripId', kate.tripId);
    console.log('Total trips in My Chord:', trips.length);

    // THE prod bug, closed: Alice's weekend sits inside the window Simon's
    // long-haul ticket spans, and nothing merges them — different people.
    expect(alice.tripId).not.toBe(yyz.tripId);
    expect(alice.tripId).not.toBe(longHaul.tripId);
    // FIXED (name variance): "SIMON STONE" and "STONE SIMON MR" are the
    // same two words plus a dropped honorific, so `namesMatch` reads them as
    // one traveler — and his Toronto side trip sits between his two long-haul
    // legs (EWR and LGA are one metro), so it is one trip of his.
    expect(longHaul.matched).toBe(true);
    expect(longHaul.tripId).toBe(yyz.tripId);
    // Kate is on the identical flights, so she is on the same trip as
    // Simon — travelers who share a leg share an itinerary — and still not
    // on Alice's, who shares nothing with them.
    expect(kate.matched).toBe(true);
    expect(kate.tripId).toBe(longHaul.tripId);
    expect(kate.tripId).not.toBe(alice.tripId);
    expect(trips.length).toBe(2);
  });

  it('attachment path: a re-uploaded ticket printed in bare local time matches its stored, zoned twin', async () => {
    // The classifier deliberately leaves ticket times bare ("...T01:50:00" plus
    // an airport IANA zone); the caller zones them (`zonedDatetime`) before
    // storing. `ensureTripForFlight` matched on the BARE strings, which
    // `new Date()` reads in the SERVER's zone — hours off the stored value —
    // so an identical re-upload never matched its own twin.
    const flight: FlightClassification = {
      kind: 'flight',
      passengerName: 'STONE SIMON MR',
      confirmation: '7CTFHU',
      legs: [{
        origin: 'DEL', destination: 'EWR',
        departAt: '2026-10-12T01:50:00', arriveAt: '2026-10-12T09:00:00',
        departZone: 'Asia/Kolkata', arriveZone: 'America/New_York',
        carrier: 'AIR INDIA', flightNo: 'AI105',
      }],
    };
    const zoning = { offsetMinutes: undefined, tz: 'America/New_York' };

    const first = await ensureTripForFlight(db, myChord, john, flight, null, 'STONE SIMON MR', zoning);
    await addTravelLeg(db, {
      tripId: first.tripId,
      passengerName: 'STONE SIMON MR',
      mode: 'flight',
      origin: 'DEL', destination: 'EWR',
      departAt: zonedDatetime('2026-10-12T01:50:00', 'Asia/Kolkata', undefined, 'America/New_York'),
      arriveAt: zonedDatetime('2026-10-12T09:00:00', 'America/New_York', undefined, 'America/New_York'),
    });

    const second = await ensureTripForFlight(db, myChord, john, flight, null, 'STONE SIMON MR', zoning);
    expect(second.tripId).toBe(first.tripId);
    const trips = await db.selectFrom('trips').where('group_id', '=', myChord).selectAll().execute();
    expect(trips.length).toBe(1);
  });

  it('Ben: LGA->MDW then the duplicate ORD->LGA return (the real duplicate-leg case)', async () => {
    // 2026-06-06T03:19:19.711Z / .951Z — 9.2s apart, one Flight classification
    // with a 2-leg array (out 9/24, back 11/20), "Ben Doe" on the whole
    // document per Flight.passengerName, but the RAW LEG for the return
    // carried no passenger of its own in prod (blank passenger_name column).
    const original = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'Ben Doe', tripDestination: 'MDW',
      legs: [
        { origin: 'LGA', destination: 'MDW', departAt: '2026-09-24T15:25:00-04:00', arriveAt: '2026-09-24T16:55:00-05:00', carrier: 'Southwest Airlines', flightNo: '2714' },
        { origin: 'ORD', destination: 'LGA', departAt: '2026-11-20T20:20:00-06:00', arriveAt: '2026-11-20T23:40:00-05:00', carrier: 'Delta', flightNo: '2503' },
      ],
    });
    // 2026-09-15T23:53:22.117Z chat — the SAME return leg restated with a
    // shortened name ("Ben", not "Ben Doe") — the real duplicate-leg case.
    const restated = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'Ben', tripDestination: 'LGA',
      legs: [{ origin: 'ORD', destination: 'LGA', departAt: '2026-11-20T21:20:00-05:00', arriveAt: '2026-11-20T23:41:00-05:00', carrier: 'Delta', flightNo: '2503' }],
    });

    const trips = await db.selectFrom('trips').where('group_id', '=', myChord).selectAll().execute();
    console.log('=== Ben to Chicago replay ===');
    console.log('Original 2-leg document matched?', original.matched, 'tripId', original.tripId);
    console.log('Chat restatement ("Ben") matched?', restated.matched, 'tripId', restated.tripId);
    console.log('Same trip?', original.tripId === restated.tripId);
    console.log('Total trips so far:', trips.length);

    // FIXED, and it took two changes to get here. (1) "Ben" is a single
    // token contained in "Ben Doe" — `namesMatch`'s subset rule (only
    // trusted when it resolves to exactly one identity — ADR 0190's own
    // asymmetry) recognizes the restatement as the same traveler. (2) Once
    // recognized, `chainConnects`'s duplicate check compares by real
    // INSTANT (`departAtMs`), not raw string equality — the original leg
    // and the chat restatement print different offsets for the identical
    // moment ("...T20:20:00-06:00" vs "...T21:20:00-05:00", both 02:20 UTC
    // the next day), which a plain string compare would have read as two
    // different legs and rejected the chain on a false seam.
    expect(original.tripId).toBe(restated.tripId);
    expect(trips.length).toBe(1);
  });

  it('Vail: the chat-created 2026 stay vs the gmail-sourced 2027 rebooking', async () => {
    // 2026-09-15T13:14Z — the user's own chat message: "staying at Ever Green
    // Lodge at Vail from Feb 11-15, 2026"
    const chatStay = await ingestStay(db, {
      groupId: rdms, uploadedBy: john, city: 'Vail, CO',
      propertyName: 'Ever Green Lodge at Vail', checkinDate: '2026-02-11', checkoutDate: '2026-02-15',
    });
    // 2026-09-15T17:16-20:14Z — a Booking.com email for a real rebooking, no
    // year on the ticket, correctly resolved to 2027 (ADR 0167) since Feb
    // 2026 had already passed by the time the email arrived.
    const flightLeg1 = await ingestLeg(db, {
      groupId: myChord, uploadedBy: john, passengerNameRaw: 'John', tripDestination: 'DEN',
      legs: [{ origin: 'LGA', destination: 'DEN', departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00', carrier: 'Southwest Airlines', flightNo: 'WN2909' }],
    });
    const emailStay = await ingestStay(db, {
      groupId: myChord, uploadedBy: john, city: 'Vail',
      propertyName: 'Evergreen Lodge at Vail', checkinDate: '2027-02-11', checkoutDate: '2027-02-15',
    });

    console.log('=== Vail replay ===');
    console.log('2026 chat stay matched an existing trip?', chatStay.matched, 'tripId', chatStay.tripId);
    console.log('2027 flight leg matched?', flightLeg1.matched, 'tripId', flightLeg1.tripId);
    console.log('2027 email stay matched the 2027 flight trip?', emailStay.matched, emailStay.tripId === flightLeg1.tripId);
    console.log('2026 and 2027 landed on different trips?', chatStay.tripId !== emailStay.tripId);

    // OBSERVED, and a genuinely new finding: the 2026 vs 2027 trips
    // correctly stay apart (a year apart, nothing connects them — this
    // part is right). But the 2027 flight and its OWN hotel stay ALSO land
    // on two separate trips, because the flight's destination is "DEN"
    // (Denver airport) and the stay's city is "Vail" — real, different
    // metros (Vail's own airport is Eagle County/EGE, ~100mi from DEN),
    // so `sameMetro('DEN','Vail')` correctly says false. airport-metro.ts's
    // own comment calls out "fly into DEN or SLC, drive the rest of the
    // way" as the exact case this app tracks — but neither
    // `findTripForTraveler` nor `findTripForStay` has a gateway-airport
    // bridge for it. Not something the original ADR conversation
    // considered.
    expect(chatStay.tripId).not.toBe(emailStay.tripId);
    expect(emailStay.tripId).not.toBe(flightLeg1.tripId);
  });

  it('the "Complete" placeholder stays that appear on every safari leg', async () => {
    // A same-day, same-timestamp batch (2026-07-31T20:14:44Z) of
    // confirmation="N/A" stays — one per safari destination.
    const doh = await ingestLeg(db, {
      groupId: rdms, uploadedBy: john, passengerNameRaw: 'John', tripDestination: 'DOH',
      legs: [{ origin: 'JFK', destination: 'DOH', departAt: '2026-08-01T22:00:00-04:00', arriveAt: '2026-08-02T17:20:00+03:00', carrier: 'QATAR AIRWAYS', flightNo: 'QR 702' }],
    });
    const dohStay = await ingestStay(db, {
      groupId: rdms, uploadedBy: john, city: 'DOH',
      propertyName: 'Complete', checkinDate: '2026-08-01', checkoutDate: '2026-08-10',
    });
    console.log('=== "Complete" placeholder stay replay ===');
    console.log('DOH leg tripId', doh.tripId, '— placeholder stay landed on it?', dohStay.tripId === doh.tripId);
    expect(dohStay.matched).toBe(true);
  });
});
