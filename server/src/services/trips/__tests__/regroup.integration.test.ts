/**
 * ADR 0190 — the one-time regroup, run against a copy of ownertest@gmail.com's
 * REAL prod trips as they stand today (filed under the old date-overlap
 * rule): real ids, real names and spellings, real creation order, the
 * cancelled row, and the real group split — "My Chord" (John alone) and
 * "RDMS" (John + Alice). Nothing here is invented; it is what the script
 * will actually meet on prod.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import {
  applyRegroupPlan,
  loadRegroupInput,
  planGroupRegroup,
  undoRegroup,
} from '../regroup.service.js';

describe('trip regroup — prod state of ownertest@gmail.com', () => {
  let db: Kysely<DB>;
  let john: string;
  let alice: string;
  let myChord: string;
  let rdms: string;

  const trip = (id: string, groupId: string, name: string, destination: string, start: string, end: string, createdAt: string, deletedAt: string | null = null) =>
    db
      .insertInto('trips')
      .values({
        id, group_id: groupId, name, destination, start_date: start, end_date: end,
        created_by: john, created_at: createdAt, source_raw_context: null, cancelled_at: null, deleted_at: deletedAt,
      })
      .execute();

  const leg = (
    id: string, tripId: string,
    who: { persona?: string; name?: string },
    origin: string, destination: string, departAt: string, arriveAt: string, createdAt: string,
    extra: { mode?: 'flight' | 'train'; cancelledAt?: string; confirmation?: string } = {},
  ) =>
    db
      .insertInto('travel_legs')
      .values({
        id, trip_id: tripId, persona_id: who.persona ?? null, passenger_name: who.name ?? null,
        mode: extra.mode ?? 'flight', origin, destination, depart_at: departAt, arrive_at: arriveAt,
        carrier: null, flight_no: null, confirmation: extra.confirmation ?? null, notes: null, source_doc_id: null,
        created_at: createdAt, source_raw_context: null, cancelled_at: extra.cancelledAt ?? null,
      })
      .execute();

  const stay = (id: string, tripId: string, name: string, checkin: string, checkout: string, createdAt: string) =>
    db
      .insertInto('accommodations')
      .values({
        id, trip_id: tripId, property_name: name, address: null, checkin_date: checkin, checkout_date: checkout,
        room_count: null, confirmation: null, notes: null, source_doc_id: null, created_at: createdAt,
        source_raw_context: null, cancelled_at: null,
      })
      .execute();

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'ownertest', 'John Doe');
    alice = await createUser(db, 'alice.dr.stone', 'Alice stone');
    myChord = (await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: john })).id;
    rdms = (await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: john })).id;
    await db
      .insertInto('group_members')
      .values({ group_id: rdms, user_id: alice, role: 'member', tier: 'verified', joined_at: new Date().toISOString() })
      .execute();

    // ── My Chord ────────────────────────────────────────────────────────
    // Alice's Amtrak weekend — the trip prod names "Trip to Washington, DC" —
    // which then absorbed her in-laws' Delhi tickets because the dates overlapped.
    await trip('tr_dc', myChord, 'Trip to Washington, DC', 'New York, NY', '2026-10-12', '2026-11-26', '2026-08-14T16:08:52.140Z');
    await leg('l_m_out', 'tr_dc', { name: 'STONE, ALICE' }, 'New York, NY', 'Washington, DC', '2026-10-21T08:05:00-04:00', '2026-10-21T11:33:00-04:00', '2026-08-14T16:08:52.169Z', { mode: 'train' });
    await leg('l_m_back', 'tr_dc', { name: 'STONE, ALICE' }, 'Washington, DC', 'New York, NY', '2026-10-23T17:15:00-04:00', '2026-10-23T20:35:00-04:00', '2026-08-14T16:08:52.178Z', { mode: 'train' });
    await leg('l_s_del_cancelled', 'tr_dc', { name: 'STONE SIMON MR' }, 'DEL', 'EWR', '2026-10-12T01:50:00+05:30', '2026-10-12T09:00:00-04:00', '2026-09-18T14:27:01.018Z', { cancelledAt: '2026-09-18T14:27:11.938Z' });
    await leg('l_s_jfk', 'tr_dc', { name: 'STONE SIMON MR' }, 'JFK', 'DEL', '2026-11-25T10:00:00-05:00', '2026-11-26T11:40:00+05:30', '2026-09-18T14:27:01.055Z');
    await leg('l_k_del', 'tr_dc', { name: 'STONE KATE MRS' }, 'DEL', 'EWR', '2026-10-12T01:50:00+05:30', '2026-10-12T09:00:00-04:00', '2026-09-18T14:27:10.253Z');
    await leg('l_k_jfk', 'tr_dc', { name: 'STONE KATE MRS' }, 'JFK', 'DEL', '2026-11-25T10:00:00-05:00', '2026-11-26T11:40:00+05:30', '2026-09-18T14:27:10.284Z');

    // Simon's own Toronto round trip.
    await trip('tr_yyz', myChord, 'Trip to YYZ', 'LGA', '2026-10-24', '2026-11-15', '2026-09-14T19:59:13.106Z');
    await leg('l_y_out', 'tr_yyz', { name: 'SIMON STONE' }, 'LGA', 'YYZ', '2026-10-24T08:45:00-04:00', '2026-10-24T10:20:00-04:00', '2026-09-14T19:59:13.119Z');
    await leg('l_y_back', 'tr_yyz', { name: 'SIMON STONE' }, 'YYZ', 'LGA', '2026-11-15T14:00:00-05:00', '2026-11-15T15:38:00-05:00', '2026-09-14T19:59:13.144Z');

    // Ben to Chicago — plus the restated duplicate of the return leg.
    await trip('tr_chi', myChord, 'Ben to Chicago', 'MDW', '2026-09-24', '2026-11-20', '2026-06-06T03:19:19.694Z');
    await leg('l_a_out', 'tr_chi', { name: 'Ben Doe' }, 'LGA', 'MDW', '2026-09-24T15:25:00-04:00', '2026-09-24T16:55:00-05:00', '2026-06-06T03:19:19.711Z');
    await leg('l_a_back', 'tr_chi', {}, 'ORD', 'LGA', '2026-11-20T20:20:00-06:00', '2026-11-20T23:40:00-05:00', '2026-06-06T03:19:28.951Z');
    await leg('l_a_back_chat', 'tr_chi', { name: 'Ben' }, 'ORD', 'LGA', '2026-11-20T21:20:00-05:00', '2026-11-20T23:41:00-05:00', '2026-09-15T23:53:22.117Z');
    await stay('s_chi_1', 'tr_chi', 'unspecified', '2026-09-24', '2026-09-24', '2026-09-15T23:52:30.619Z');
    await stay('s_chi_2', 'tr_chi', 'home', '2026-11-20', '2026-11-21', '2026-09-15T23:53:22.153Z');
    await trip('tr_phl', myChord, 'Trip to PHL', 'NYP', '2026-09-18', '2026-09-20', '2026-09-18T02:03:15.160Z');
    await leg('l_p_out', 'tr_phl', { name: 'DOE, BEN' }, 'NYP', 'PHL', '2026-09-18T14:02:00-04:00', '2026-09-18T15:24:00-04:00', '2026-09-18T02:03:15.183Z', { mode: 'train' });
    await leg('l_p_back', 'tr_phl', { name: 'DOE, BEN' }, 'PHL', 'NYP', '2026-09-20T09:30:00-04:00', '2026-09-20T10:55:00-04:00', '2026-09-18T02:03:15.218Z', { mode: 'train' });

    // Correct today, and must stay that way.
    await trip('tr_bzn', myChord, 'Trip to BZN', 'EWR', '2026-07-12', '2026-07-24', '2026-05-16T22:14:56.548Z');
    await leg('l_b_out', 'tr_bzn', { name: 'Nolan Doe' }, 'EWR', 'BZN', '2026-07-12T07:39:00-04:00', '2026-07-12T10:26:00-06:00', '2026-05-16T22:14:56.550Z');
    await leg('l_b_back', 'tr_bzn', { name: 'Nolan Doe' }, 'BZN', 'EWR', '2026-07-24T11:38:00-06:00', '2026-07-24T18:00:00-04:00', '2026-05-16T22:14:56.550Z');
    await trip('tr_vail', myChord, 'Vail', 'LGA', '2027-02-11', '2027-02-15', '2026-09-15T17:16:48.956Z');
    await leg('l_v_out', 'tr_vail', { persona: john }, 'LGA', 'DEN', '2027-02-11T20:55:00-05:00', '2027-02-11T23:30:00-07:00', '2026-09-15T17:16:48.983Z');
    await leg('l_v_back', 'tr_vail', { persona: john }, 'DEN', 'LGA', '2027-02-15T17:50:00-07:00', '2027-02-15T23:25:00-05:00', '2026-09-15T17:16:49.021Z');
    await stay('s_vail', 'tr_vail', 'Evergreen Lodge at Vail', '2027-02-11', '2027-02-15', '2026-09-15T20:14:20.904Z');
    // The Lisbon trip: none of its legs names a passenger.
    await trip('tr_lis', myChord, 'Trip to LIS', 'EWR', '2026-09-01', '2026-09-08', '2026-05-22T16:46:18.691Z');
    await leg('l_l_1', 'tr_lis', {}, 'EWR', 'LIS', '2026-09-01T20:25:00-04:00', '2026-09-02T08:20:00+01:00', '2026-05-22T16:46:18.693Z');
    await leg('l_l_2', 'tr_lis', {}, 'LIS', 'SVQ', '2026-09-04T07:25:00+01:00', '2026-09-04T09:25:00+02:00', '2026-06-04T20:22:11.620Z');
    await leg('l_l_3', 'tr_lis', {}, 'SVQ', 'BCN', '2026-09-06T13:20:00+02:00', '2026-09-06T15:05:00+02:00', '2026-06-04T20:22:11.630Z');
    await leg('l_l_4', 'tr_lis', {}, 'BCN', 'EWR', '2026-09-08T12:15:00+02:00', '2026-09-08T17:59:00-04:00', '2026-05-22T16:46:18.693Z');
    await stay('s_lis_1', 'tr_lis', 'Hotel Convento do Salvador', '2026-09-02', '2026-09-04', '2026-05-28T00:06:03.653Z');
    // Shells with no legs, and a deleted trip.
    await trip('tr_unspec', myChord, 'unspecified', 'unspecified', '2026-04-24', '2026-04-27', '2026-09-15T23:52:05.396Z');
    await stay('s_unspec', 'tr_unspec', 'unspecified', '2026-04-24', '2026-04-27', '2026-09-15T23:52:05.418Z');
    await trip('tr_deleted', myChord, 'Trip to LGA', 'LGA', '2026-11-20', '2026-11-20', '2026-06-06T03:19:28.940Z', '2026-09-18T22:07:43.989Z');

    // ── RDMS: the Kenya safari and the family's flight to Doha ─────────────
    await trip('tr_doh', rdms, 'Trip to DOH', 'DOH', '2026-08-01', '2026-08-02', '2026-05-22T20:52:22.109Z');
    await leg('l_d_john', 'tr_doh', { persona: john }, 'JFK', 'DOH', '2026-08-01T22:00:00-04:00', '2026-08-02T17:20:00+03:00', '2026-05-22T20:52:22.117Z');
    await leg('l_d_ben', 'tr_doh', { name: 'Ben' }, 'JFK', 'DOH', '2026-08-01T22:00:00-04:00', '2026-08-02T17:20:00+03:00', '2026-05-22T20:57:39.852Z');
    await leg('l_d_nolan', 'tr_doh', { name: 'Nolan' }, 'JFK', 'DOH', '2026-08-01T22:00:00-04:00', '2026-08-02T17:20:00+03:00', '2026-05-22T20:57:39.853Z');
    await leg('l_d_alice', 'tr_doh', { persona: alice }, 'JFK', 'DOH', '2026-08-01T22:00:00-04:00', '2026-08-02T17:20:00+03:00', '2026-05-22T20:57:39.853Z');
    await leg('l_d_nbo', 'tr_doh', {}, 'DOH', 'NBO', '2026-08-02T18:45:00+03:00', '2026-08-02T23:50:00+03:00', '2026-05-22T21:01:43.245Z');
    await trip('tr_mara', rdms, 'Trip to Mara-Keekorok', 'Mara-Keekorok', '2026-08-03', '2026-08-03', '2026-05-19T21:47:15.044Z');
    await leg('l_mara', 'tr_mara', { name: 'MR. DOE JOHN' }, 'Nairobi-Wilson', 'Mara-Keekorok', '2026-08-03T10:30:00+03:00', '2026-08-03T11:10:00+03:00', '2026-05-19T21:47:15.046Z');
    await trip('tr_ambo', rdms, 'Trip to Amboseli', 'Amboseli', '2026-08-06', '2026-08-06', '2026-05-19T21:47:24.075Z');
    await leg('l_ambo', 'tr_ambo', {}, 'Masai Mara - Keekorok', 'Amboseli', '2026-08-06T11:30:00+03:00', '2026-08-06T12:30:00+03:00', '2026-05-19T21:47:24.077Z');
    await trip('tr_diani', rdms, 'Trip to Diani Ukunda', 'Diani Ukunda', '2026-08-08', '2026-08-08', '2026-05-19T21:48:19.508Z');
    await leg('l_diani', 'tr_diani', {}, 'Amboseli', 'Diani Ukunda', '2026-08-08T12:45:00+03:00', '2026-08-08T13:45:00+03:00', '2026-05-19T21:48:19.509Z');
    await trip('tr_wilson', rdms, 'Trip to Nairobi Wilson', 'Nairobi Wilson', '2026-08-10', '2026-08-10', '2026-05-19T21:48:53.652Z');
    await leg('l_wilson', 'tr_wilson', {}, 'Ukunda', 'Nairobi Wilson', '2026-08-10T16:00:00+03:00', '2026-08-10T17:15:00+03:00', '2026-05-19T21:48:53.654Z');
    await trip('tr_home', rdms, 'Trip to JFK', 'JFK', '2026-08-11', '2026-08-11', '2026-05-22T21:02:03.808Z');
    await leg('l_home', 'tr_home', {}, 'DOH', 'JFK', '2026-08-11T08:15:00+03:00', '2026-08-11T15:10:00-04:00', '2026-05-22T21:02:03.812Z');
    // Ben's own arrival home in May — two months before the Doha flight.
    await trip('tr_may', rdms, 'Trip to New York La Guardia', 'New York La Guardia', '2026-05-30', '2026-05-30', '2026-05-19T21:35:03.604Z');
    await leg('l_may', 'tr_may', { name: 'BEN DOE' }, "Chicago O'Hare International", 'New York La Guardia', '2026-05-30T14:40:00-05:00', '2026-05-30T18:01:00-04:00', '2026-05-19T21:35:03.612Z');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const legTrips = async () =>
    Object.fromEntries((await db.selectFrom('travel_legs').select(['id', 'trip_id']).execute()).map((r) => [r.id, r.trip_id]));

  it('My Chord: Alice keeps her weekend; the in-laws\' Delhi tickets get a trip of their own', async () => {
    const input = await loadRegroupInput(db, { groupId: myChord });
    const plan = planGroupRegroup(myChord, input.get(myChord)!);

    const created = plan.ops.filter((o) => o.kind === 'new_trip');
    expect(created).toHaveLength(1);
    const moved = plan.ops.filter((o) => o.kind === 'move_leg').map((o) => (o.kind === 'move_leg' ? o.legId : ''));
    // Kate's two legs and Simon's return — the same flights, one itinerary.
    expect(moved.sort()).toEqual(['l_k_del', 'l_k_jfk', 'l_s_jfk']);
    // Nothing else in the group moves: Toronto, Chicago, Philadelphia, Bozeman,
    // Vail and Lisbon are all already right.
    expect(plan.ops).toHaveLength(4);

    await applyRegroupPlan(db, plan);
    const where = await legTrips();
    const newTrip = (created[0] as { tripId: string }).tripId;
    expect(where.l_m_out).toBe('tr_dc');
    expect(where.l_m_back).toBe('tr_dc');
    expect(where.l_k_del).toBe(newTrip);
    expect(where.l_k_jfk).toBe(newTrip);
    expect(where.l_s_jfk).toBe(newTrip);
    expect(where.l_y_out).toBe('tr_yyz');

    // The weekend's window is hers again, not the visit's; the new trip's is the visit's.
    const dc = await db.selectFrom('trips').selectAll().where('id', '=', 'tr_dc').executeTakeFirstOrThrow();
    expect([dc.start_date, dc.end_date]).toEqual(['2026-10-21', '2026-10-23']);
    const nt = await db.selectFrom('trips').selectAll().where('id', '=', newTrip).executeTakeFirstOrThrow();
    expect([nt.start_date, nt.end_date]).toEqual(['2026-10-12', '2026-11-26']);
    expect(nt.deleted_at).toBeNull();
  });

  it('leaves legs it cannot name where they are, and reports them', async () => {
    const input = await loadRegroupInput(db, { groupId: myChord });
    const plan = planGroupRegroup(myChord, input.get(myChord)!);
    // The four Lisbon legs name nobody; the cancelled Delhi row did not happen.
    expect(plan.pinnedLegIds.sort()).toEqual(['l_l_1', 'l_l_2', 'l_l_3', 'l_l_4', 'l_s_del_cancelled'].sort());
  });

  it('reports the restated Ben return leg as a duplicate, and does not delete it', async () => {
    const input = await loadRegroupInput(db, { groupId: myChord });
    const plan = planGroupRegroup(myChord, input.get(myChord)!);
    expect(plan.duplicates.map((g) => [...g].sort())).toContainEqual(['l_a_back', 'l_a_back_chat']);
    await applyRegroupPlan(db, plan);
    const remaining = await db.selectFrom('travel_legs').select('id').where('id', 'in', ['l_a_back', 'l_a_back_chat']).execute();
    expect(remaining).toHaveLength(2);
  });

  it('RDMS: the family stays together on the Doha flight and the safari is untouched', async () => {
    const input = await loadRegroupInput(db, { groupId: rdms });
    const plan = planGroupRegroup(rdms, input.get(rdms)!);
    // John, Ben, Nolan and Alice share one flight, so they are ONE trip —
    // a strictly per-person regroup would have split them into four.
    expect(plan.ops).toEqual([]);
    // The internal safari hops name no passenger, so they are left alone.
    expect(plan.pinnedLegIds.sort()).toEqual(['l_ambo', 'l_d_nbo', 'l_diani', 'l_home', 'l_wilson']);
  });

  it('RDMS: Ben landing home in May is not "in transit" until the August flight', async () => {
    const input = await loadRegroupInput(db, { groupId: rdms });
    const plan = planGroupRegroup(rdms, input.get(rdms)!);
    expect(plan.ops.some((o) => o.kind === 'fold_trip' && o.fromTripId === 'tr_may')).toBe(false);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const first = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    await applyRegroupPlan(db, first);
    const second = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    expect(second.ops).toEqual([]);
  });

  it('undo puts every leg, date and trip back exactly as it was', async () => {
    const before = await legTrips();
    const tripsBefore = await db.selectFrom('trips').selectAll().orderBy('id').execute();

    const plan = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    const undo = await applyRegroupPlan(db, plan);
    expect(await legTrips()).not.toEqual(before);

    await undoRegroup(db, undo);
    expect(await legTrips()).toEqual(before);
    const tripsAfter = await db.selectFrom('trips').selectAll().orderBy('id').execute();
    // Every original trip is back to its dates and live state; the one the
    // script created is soft-deleted, not gone.
    for (const t of tripsBefore) {
      const now = tripsAfter.find((x) => x.id === t.id)!;
      expect([now.start_date, now.end_date, now.deleted_at]).toEqual([t.start_date, t.end_date, t.deleted_at]);
    }
    const createdNow = tripsAfter.filter((x) => !tripsBefore.some((t) => t.id === x.id));
    expect(createdNow.every((x) => x.deleted_at !== null)).toBe(true);
  });

  it('legs sharing a booking reference are one trip: an unnamed safari hop rides with the booking it belongs to', async () => {
    // Today the unnamed internal hops are pinned wherever they landed (five
    // separate trips in RDMS). Give the DOH leg and one hop a shared reference
    // and the hop is placed with its booking instead of pinned.
    await db.updateTable('travel_legs').set({ confirmation: 'QR7702' }).where('id', 'in', ['l_d_john', 'l_d_nbo']).execute();
    const plan = planGroupRegroup(rdms, (await loadRegroupInput(db, { groupId: rdms })).get(rdms)!);
    expect(plan.pinnedLegIds).not.toContain('l_d_nbo');
    expect(plan.ops.some((o) => o.kind === 'move_leg' && o.legId === 'l_d_nbo')).toBe(false); // already on that trip
    // ...and the other unnamed hops, with no shared reference, are still pinned.
    expect(plan.pinnedLegIds).toEqual(expect.arrayContaining(['l_ambo', 'l_diani', 'l_wilson', 'l_home']));
  });

  it('a booking reference joins legs whatever their routes and whoever is named', async () => {
    // One booking, two travelers, routes that never connect — nothing but the
    // reference says they are one itinerary. Filed on two trips today.
    await trip('tr_bk_a', myChord, 'Trip to SFO', 'SFO', '2027-03-01', '2027-03-05', '2026-09-01T00:00:00.000Z');
    await leg('l_bk_a', 'tr_bk_a', { name: 'John Doe' }, 'JFK', 'SFO', '2027-03-01T08:00:00-05:00', '2027-03-01T11:00:00-08:00', '2026-09-01T00:00:01.000Z', { confirmation: 'KX8QP2' });
    await trip('tr_bk_b', myChord, 'Trip to LAX', 'LAX', '2027-03-04', '2027-03-08', '2026-09-02T00:00:00.000Z');
    await leg('l_bk_b', 'tr_bk_b', { name: 'Alice Stone' }, 'BOS', 'LAX', '2027-03-04T09:00:00-05:00', '2027-03-04T12:00:00-08:00', '2026-09-02T00:00:01.000Z', { confirmation: 'kx8qp2' });

    const plan = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    expect(plan.ops).toContainEqual({ kind: 'fold_trip', fromTripId: 'tr_bk_b', intoTripId: 'tr_bk_a' });
    await applyRegroupPlan(db, plan);
    expect((await legTrips()).l_bk_b).toBe('tr_bk_a');
  });

  it('a placeholder reference ("N/A") never joins anything', async () => {
    await trip('tr_na_a', myChord, 'Trip to SFO', 'SFO', '2027-04-01', '2027-04-05', '2026-09-01T00:00:00.000Z');
    await leg('l_na_a', 'tr_na_a', { name: 'John Doe' }, 'JFK', 'SFO', '2027-04-01T08:00:00-05:00', '2027-04-01T11:00:00-08:00', '2026-09-01T00:00:01.000Z', { confirmation: 'N/A' });
    await trip('tr_na_b', myChord, 'Trip to LAX', 'LAX', '2027-04-04', '2027-04-08', '2026-09-02T00:00:00.000Z');
    await leg('l_na_b', 'tr_na_b', { name: 'Alice Stone' }, 'BOS', 'LAX', '2027-04-04T09:00:00-05:00', '2027-04-04T12:00:00-08:00', '2026-09-02T00:00:01.000Z', { confirmation: 'N/A' });
    const plan = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    expect(plan.ops.some((o) => o.kind === 'fold_trip' && (o.fromTripId === 'tr_na_b' || o.fromTripId === 'tr_na_a'))).toBe(false);
  });

  it('folds a trip that was split in two into one, carrying its stays with it', async () => {
    // Two trips holding one traveler's outbound and return.
    await trip('tr_split_a', myChord, 'Trip to PDX', 'PDX', '2027-05-01', '2027-05-01', '2026-09-01T00:00:00.000Z');
    await leg('l_sp_out', 'tr_split_a', { name: 'Nolan Doe' }, 'LGA', 'PDX', '2027-05-01T08:00:00-04:00', '2027-05-01T11:00:00-07:00', '2026-09-01T00:00:01.000Z');
    await trip('tr_split_b', myChord, 'Trip to LGA', 'LGA', '2027-05-09', '2027-05-09', '2026-09-02T00:00:00.000Z');
    await leg('l_sp_back', 'tr_split_b', { name: 'NOLAN DOE' }, 'PDX', 'LGA', '2027-05-09T09:00:00-07:00', '2027-05-09T17:00:00-04:00', '2026-09-02T00:00:01.000Z');
    await stay('s_sp', 'tr_split_b', 'Hotel Portland', '2027-05-01', '2027-05-09', '2026-09-02T00:00:02.000Z');

    const plan = planGroupRegroup(myChord, (await loadRegroupInput(db, { groupId: myChord })).get(myChord)!);
    expect(plan.ops).toContainEqual({ kind: 'fold_trip', fromTripId: 'tr_split_b', intoTripId: 'tr_split_a' });
    await applyRegroupPlan(db, plan);

    expect((await legTrips()).l_sp_back).toBe('tr_split_a');
    const s = await db.selectFrom('accommodations').select('trip_id').where('id', '=', 's_sp').executeTakeFirstOrThrow();
    expect(s.trip_id).toBe('tr_split_a');
    const b = await db.selectFrom('trips').select('deleted_at').where('id', '=', 'tr_split_b').executeTakeFirstOrThrow();
    expect(b.deleted_at).not.toBeNull();
    const a = await db.selectFrom('trips').select(['start_date', 'end_date']).where('id', '=', 'tr_split_a').executeTakeFirstOrThrow();
    expect([a.start_date, a.end_date]).toEqual(['2027-05-01', '2027-05-09']);
  });
});
