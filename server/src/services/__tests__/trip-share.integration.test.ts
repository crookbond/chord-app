/**
 * ADR 0233 — a trip starts personal; sharing it with a group is an offer the
 * user answers, and the answer moves the whole trip (legs, stays, the flight's
 * calendar event) rather than half of it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { getPendingFanout } from '@/services/bot/pending-fanout.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal, confirmProposal } from '@/services/proposals.service.js';
import { addAccommodation, addTravelLeg, createTrip, shareTripWithGroup } from '@/services/trips.service.js';
import { suggestTripShareGroups } from '@/services/trips/share-suggestion.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;
const day = (n: number): string => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (n: number, hh: string): string => `${day(n)}T${hh}:00.000Z`;

describe('sharing a trip with a group (ADR 0233)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let personalId: string;
  let familyId: string;

  const tripWithLeg = async (opts: { groupId?: string; passenger?: string; name?: string; endDay?: number } = {}) => {
    const trip = await createTrip(db, {
      groupId: opts.groupId ?? personalId,
      createdBy: john,
      name: opts.name ?? 'Denver',
      destination: 'DEN',
      startDate: day(20),
      endDate: day(opts.endDay ?? 25),
      participantIds: [],
    });
    const leg = await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'JFK',
      destination: 'DEN',
      departAt: at(20, '14:00'),
      arriveAt: at(20, '18:00'),
      carrier: 'UA',
      flightNo: '512',
      passengerName: opts.passenger,
    });
    return { trip, leg };
  };

  const events = (groupId: string) =>
    db.selectFrom('events').select(['id', 'group_id', 'external_uid']).where('group_id', '=', groupId).execute();

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Rao');
    personalId = (await ensurePersonalGroup(db, john)).id;
    familyId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true })).id;
    await addMember(db, familyId, priya);
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  describe('shareTripWithGroup', () => {
    it('moves the trip, its legs and stays, and the flight\'s calendar event, together', async () => {
      const { trip } = await tripWithLeg();
      await addAccommodation(db, {
        tripId: trip.id,
        propertyName: 'Hotel Monaco',
        checkinDate: day(20),
        checkoutDate: day(25),
      } as never);
      expect(await events(personalId)).toHaveLength(1);

      const res = await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: familyId });
      expect(res).toMatchObject({ ok: true, previousGroupId: personalId, movedEvents: 1 });
      const row = await db.selectFrom('trips').select('group_id').where('id', '=', trip.id).executeTakeFirstOrThrow();
      expect(row.group_id).toBe(familyId);
      // The children follow by trip id, not by being touched.
      expect(await db.selectFrom('travel_legs').select('id').where('trip_id', '=', trip.id).execute()).toHaveLength(1);
      expect(await db.selectFrom('accommodations').select('id').where('trip_id', '=', trip.id).execute()).toHaveLength(1);
      // The event moved with the trip - the leg sync finds it by (group, uid).
      expect(await events(personalId)).toHaveLength(0);
      expect(await events(familyId)).toHaveLength(1);
    });

    it('a second leg added afterwards lands on the SAME flight event, not a duplicate', async () => {
      const { trip } = await tripWithLeg();
      await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: familyId });
      // Same flight, second passenger: must fold into the event that moved.
      await addTravelLeg(db, {
        tripId: trip.id,
        mode: 'flight',
        origin: 'JFK',
        destination: 'DEN',
        departAt: at(20, '14:00'),
        arriveAt: at(20, '18:00'),
        carrier: 'UA',
        flightNo: '512',
        passengerName: 'Aarav',
      });
      expect(await events(familyId)).toHaveLength(1);
      expect(await events(personalId)).toHaveLength(0);
    });

    it('the other members can now see it, and it is in their catch-up folders', async () => {
      const { trip } = await tripWithLeg();
      await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: familyId });
      const assigned = await db
        .selectFrom('catchup_assignments')
        .select('user_id')
        .where('entity_type', '=', 'trip')
        .where('entity_id', '=', trip.id)
        .execute();
      expect(assigned.map((a) => a.user_id).sort()).toEqual([priya, john].sort());
    });

    it('drops a participant who is not in the group — it could not see who they are', async () => {
      const outsider = await createUser(db, 'outsider', 'Olive Out');
      const { trip } = await tripWithLeg();
      await db.insertInto('trip_participants').values([
        { trip_id: trip.id, persona_id: outsider },
        { trip_id: trip.id, persona_id: priya },
      ]).execute();
      await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: familyId });
      const left = await db.selectFrom('trip_participants').select('persona_id').where('trip_id', '=', trip.id).execute();
      expect(left.map((p) => p.persona_id)).toEqual([priya]);
    });

    it('refuses what it should: a trip already in a group, someone else\'s trip, a group the asker is not in, a personal group, a deleted trip', async () => {
      const { trip: inGroup } = await tripWithLeg({ groupId: familyId });
      expect(await shareTripWithGroup(db, { tripId: inGroup.id, actorUserId: john, targetGroupId: familyId })).toEqual({
        ok: false,
        reason: 'not_personal',
      });

      const { trip } = await tripWithLeg();
      expect(await shareTripWithGroup(db, { tripId: trip.id, actorUserId: priya, targetGroupId: familyId })).toEqual({
        ok: false,
        reason: 'not_personal',
      });

      const stranger = await createUser(db, 'zed', 'Zed Quill');
      const theirs = (await createGroup(db, { name: 'Quill Club', kind: 'group', createdBy: stranger, nameIsCustom: true })).id;
      expect(await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: theirs })).toEqual({
        ok: false,
        reason: 'not_member',
      });
      expect(await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: personalId })).toEqual({
        ok: false,
        reason: 'not_shared_group',
      });

      await db.updateTable('trips').set({ deleted_at: new Date().toISOString() }).where('id', '=', trip.id).execute();
      expect(await shareTripWithGroup(db, { tripId: trip.id, actorUserId: john, targetGroupId: familyId })).toEqual({
        ok: false,
        reason: 'not_found',
      });
      // None of the refusals moved anything.
      const row = await db.selectFrom('trips').select('group_id').where('id', '=', trip.id).executeTakeFirstOrThrow();
      expect(row.group_id).toBe(personalId);
    });
  });

  describe('who a trip is offered to', () => {
    it('a person named on it picks the group', async () => {
      const friends = (await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      const quinn = await createUser(db, 'quinn', 'Quinn Ames');
      await addMember(db, friends, quinn);
      const { trip } = await tripWithLeg({ passenger: 'Priya Rao' });
      expect((await suggestTripShareGroups(db, john, trip.id)).map((g) => g.name)).toEqual(['Doe Family']);
    });

    it('a family member on a leg picks the group by their name too', async () => {
      const friends = (await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      const quinn = await createUser(db, 'quinn', 'Quinn Ames');
      await addMember(db, friends, quinn);
      const { trip, leg } = await tripWithLeg();
      // Matched to a member: stored as persona_id, passenger_name left NULL.
      await db.updateTable('travel_legs').set({ persona_id: priya, passenger_name: null }).where('id', '=', leg.id).execute();
      expect((await suggestTripShareGroups(db, john, trip.id)).map((g) => g.name)).toEqual(['Doe Family']);
    });

    it('with no name on it, the asker\'s ONE shared group is offered - that is their family', async () => {
      const { trip } = await tripWithLeg();
      expect((await suggestTripShareGroups(db, john, trip.id)).map((g) => g.name)).toEqual(['Doe Family']);
    });

    it('with several groups and no name to choose between them, nothing is offered', async () => {
      await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true });
      const { trip } = await tripWithLeg();
      expect(await suggestTripShareGroups(db, john, trip.id)).toEqual([]);
    });

    it('a group with nobody else in it is not a family to offer to', async () => {
      await db.deleteFrom('group_members').where('group_id', '=', familyId).where('user_id', '=', priya).execute();
      const { trip } = await tripWithLeg();
      expect(await suggestTripShareGroups(db, john, trip.id)).toEqual([]);
    });

    it('never for a trip already shared, a trip that is over, or a cancelled one', async () => {
      const { trip: shared } = await tripWithLeg({ groupId: familyId });
      expect(await suggestTripShareGroups(db, john, shared.id)).toEqual([]);

      // Adding a leg widens a trip's dates, so make it over AFTER the leg is on.
      const { trip: over } = await tripWithLeg({ name: 'Old' });
      await db.updateTable('trips').set({ start_date: day(-14), end_date: day(-10) }).where('id', '=', over.id).execute();
      expect(await suggestTripShareGroups(db, john, over.id)).toEqual([]);

      const { trip: cancelled } = await tripWithLeg({ name: 'Cancelled' });
      await db.updateTable('trips').set({ cancelled_at: new Date().toISOString() }).where('id', '=', cancelled.id).execute();
      expect(await suggestTripShareGroups(db, john, cancelled.id)).toEqual([]);
    });

    it('is the asker\'s alone: someone else\'s trip is never offered to them', async () => {
      const { trip } = await tripWithLeg();
      expect(await suggestTripShareGroups(db, priya, trip.id)).toEqual([]);
    });
  });

  describe('in the 1:1 chat', () => {
    const run = (name: string, args: Record<string, unknown>, groupId = personalId, live = true) =>
      applyToolCall(db, {
        groupId,
        actorUserId: john,
        provenance: null,
        ...(live ? { turnId: `t-${Math.random()}` } : {}),
        tzOffset: '-04:00',
        call: { name, args } as never,
      });
    const tripArgs = { name: 'Denver', destination: 'DEN', startDate: day(20), endDate: day(25) };

    it('create_trip OFFERS the group and shares nothing', async () => {
      const res = await run('create_trip', tripArgs);
      const data = res.data as { tripId: string; shareSuggestion?: { groups: string[]; instruction: string } };
      expect(data.shareSuggestion?.groups).toEqual(['Doe Family']);
      expect(data.shareSuggestion?.instruction).toMatch(/Do NOT share it unless they say yes/);
      const row = await db.selectFrom('trips').select('group_id').where('id', '=', data.tripId).executeTakeFirstOrThrow();
      expect(row.group_id).toBe(personalId);
      expect(await getPendingFanout(db, personalId, john)).toMatchObject({ kind: 'trip', entityId: data.tripId });
    });

    it('the offer is made once per trip, not again on every leg', async () => {
      const created = await run('create_trip', tripArgs);
      const tripId = (created.data as { tripId: string }).tripId;
      const leg = await run('add_travel_leg', {
        tripId,
        personaName: 'John',
        origin: 'JFK',
        destination: 'DEN',
        departAt: at(20, '14:00'),
        arriveAt: at(20, '18:00'),
      });
      expect((leg.data as { shareSuggestion?: unknown } | undefined)?.shareSuggestion).toBeUndefined();
    });

    it('add_travel_leg offers when it is what created the trip', async () => {
      const leg = await run('add_travel_leg', {
        personaName: 'John',
        origin: 'JFK',
        destination: 'DEN',
        departAt: at(20, '14:00'),
        arriveAt: at(20, '18:00'),
      });
      expect((leg.data as { shareSuggestion?: { groups: string[] } }).shareSuggestion?.groups).toEqual(['Doe Family']);
    });

    it('is not offered with no live turn (a proposal committing), nor inside a shared group chat', async () => {
      const noTurn = await run('create_trip', tripArgs, personalId, false);
      expect((noTurn.data as { shareSuggestion?: unknown }).shareSuggestion).toBeUndefined();
      expect(await getPendingFanout(db, personalId, john)).toBeNull();

      const inGroup = await run('create_trip', { ...tripArgs, name: 'Group trip' }, familyId);
      expect((inGroup.data as { shareSuggestion?: unknown }).shareSuggestion).toBeUndefined();
    });

    it('share_trip is the yes: the trip moves into the group and the offer is spent', async () => {
      const created = await run('create_trip', tripArgs);
      const tripId = (created.data as { tripId: string }).tripId;
      const res = await run('share_trip', {});
      expect(res.data).toMatchObject({ ok: true, group: 'Doe Family' });
      const row = await db.selectFrom('trips').select('group_id').where('id', '=', tripId).executeTakeFirstOrThrow();
      expect(row.group_id).toBe(familyId);
      expect((await run('share_trip', {})).data).toMatchObject({ ok: false, reason: 'nothing_pending' });
    });

    it('share_trip never shares on its own, never answers an event offer, and is personal-chat only', async () => {
      expect((await run('share_trip', {})).data).toMatchObject({ ok: false, reason: 'nothing_pending' });
      // A pending EVENT offer is not a trip offer.
      await run('create_event', { title: 'Dinner with Priya', startsAt: `${day(5)}T19:00:00-04:00` });
      expect((await run('share_trip', {})).data).toMatchObject({ ok: false, reason: 'nothing_pending' });
      expect((await run('share_trip', {}, familyId)).data).toMatchObject({ ok: false, reason: 'personal_only' });
    });

    it('with several groups named it asks which, and shares to the one chosen', async () => {
      const friends = (await createGroup(db, { name: 'Friends', kind: 'group', createdBy: john, nameIsCustom: true })).id;
      await addMember(db, friends, priya);
      const created = await run('create_trip', { ...tripArgs, name: 'Trip with Priya' });
      const tripId = (created.data as { tripId: string }).tripId;
      expect((created.data as { shareSuggestion: { groups: string[] } }).shareSuggestion.groups.sort()).toEqual(['Doe Family', 'Friends']);
      expect((await run('share_trip', {})).data).toMatchObject({ ok: false, reason: 'which_group' });
      expect((await run('share_trip', { withGroupName: 'Friends' })).data).toMatchObject({ ok: true, group: 'Friends' });
      const row = await db.selectFrom('trips').select('group_id').where('id', '=', tripId).executeTakeFirstOrThrow();
      expect(row.group_id).toBe(friends);
    });
  });

  describe('approving an emailed trip', () => {
    const stageBundle = async () => {
      const bundleId = `b_${Math.random().toString(36).slice(2)}`;
      const base = { groupId: personalId, proposedByUserId: john, proposedByMessageId: null, provenance: 'gmail:thread1', bundleId };
      const lead = await createProposal(db, {
        ...base,
        toolName: 'create_trip',
        args: { name: 'Denver', destination: 'DEN', startDate: day(20), endDate: day(25) },
      });
      await createProposal(db, {
        ...base,
        toolName: 'add_travel_leg',
        args: {
          personaName: 'John',
          origin: 'JFK',
          destination: 'DEN',
          departAt: at(20, '14:00'),
          arriveAt: at(20, '18:00'),
          carrier: 'UA',
          flightNo: '512',
        },
      });
      return lead;
    };

    it('by default the whole bundle stays personal', async () => {
      const lead = await stageBundle();
      const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: john });
      expect(res.ok).toBe(true);
      const trips = await db.selectFrom('trips').select(['group_id']).execute();
      expect(trips.map((t) => t.group_id)).toEqual([personalId]);
    });

    it('naming a group on the approval creates the trip, its legs and the flight event THERE', async () => {
      const lead = await stageBundle();
      const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: john, targetGroupId: familyId });
      expect(res.ok).toBe(true);
      const trips = await db.selectFrom('trips').select(['id', 'group_id']).execute();
      expect(trips.map((t) => t.group_id)).toEqual([familyId]);
      expect(await db.selectFrom('travel_legs').select('id').where('trip_id', '=', trips[0]!.id).execute()).toHaveLength(1);
      expect(await events(familyId)).toHaveLength(1);
      expect(await events(personalId)).toHaveLength(0);
    });

    it('a group the approver is not in is refused, and nothing is created', async () => {
      const stranger = await createUser(db, 'zed2', 'Zed Quill');
      const theirs = (await createGroup(db, { name: 'Quill Club', kind: 'group', createdBy: stranger, nameIsCustom: true })).id;
      const lead = await stageBundle();
      const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: john, targetGroupId: theirs });
      expect(res.ok).toBe(false);
      expect(await db.selectFrom('trips').select('id').execute()).toHaveLength(0);
    });

    it('a bundle with no trip in it (a screenshot bundle) still ignores a group on the approval', async () => {
      const bundleId = 'b_shot';
      const base = { groupId: personalId, proposedByUserId: john, proposedByMessageId: null, provenance: null, bundleId };
      const lead = await createProposal(db, {
        ...base,
        toolName: 'create_event',
        args: { title: 'Soccer', startsAt: `${day(6)}T10:00:00-04:00` },
      });
      await createProposal(db, { ...base, toolName: 'add_list_item', args: { listName: 'Gear', items: ['cleats'] } });
      const res = await confirmProposal(db, { id: lead.id, resolvedByUserId: john, targetGroupId: familyId });
      expect(res.ok).toBe(true);
      const ev = await db.selectFrom('events').select('group_id').where('title', '=', 'Soccer').execute();
      expect(new Set(ev.map((e) => e.group_id))).toEqual(new Set([personalId]));
    });
  });
});
