/**
 * Prod, 2026-11-11: a family trip "Trip to Ann Arbor" had nobody recorded as
 * travelling, so the new-trip check flagged John's own "John and Yash" and
 * "Get skis" as clashes and could not say whose trip it was. John answered in
 * his personal chat, "Trip to Ann Arbor is Ben Doe", and the bot came back
 * with "need disambiguation": the trip lives in the family group, the answer
 * was looked up among his personal trips only, and Ben (a family member with
 * no Chord account) had nowhere to be stored on a trip with no tickets.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { listPendingTripTravelers } from '@/services/bot/pending-trip-travelers.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { __testing } from '@/services/proactive.service.js';
import { createTrip } from '@/services/trips.service.js';
import { loadTripTravelers } from '@/services/trips/trip-conflict.js';
import { resolveTripTraveler } from '@/services/trips/travelers.js';
import { whoseTrips } from '@/services/trips/whose-trip.js';

const DAY = 24 * 60 * 60_000;
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('a family member without an account can be on a trip', () => {
  let db: Kysely<DB>;
  let john: string;
  let family: string;
  let personal: string;
  let ben: string;
  let tripId: string;

  beforeEach(async () => {
    db = await openTestDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    john = await createUser(db, 'john', 'John Doe');
    family = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john })).id;
    personal = (await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: john })).id;
    ben = (
      await createPersona(db, { groupId: family, name: 'Ben Doe', householdRole: 'child', managedBy: john })
    ).id;
    // Two personal trips: enough to make "every trip" ambiguous.
    for (const name of ['Trip to Denver', 'Trip to Vail']) {
      await createTrip(db, {
        groupId: personal, createdBy: john, name, destination: name.slice(8),
        startDate: dayAhead(20), endDate: dayAhead(24), participantIds: [],
      });
    }
    tripId = (
      await createTrip(db, {
        groupId: family, createdBy: john, name: 'Trip to Ann Arbor', destination: 'Ann Arbor',
        startDate: dayAhead(2), endDate: dayAhead(4), participantIds: [],
      })
    ).id;
    for (const [title, day, hours] of [['John and Yash', 2, 0.5], ['Get skis', 3, 1]] as const) {
      const startsAt = new Date(Date.parse(`${dayAhead(day)}T14:00:00Z`)).toISOString();
      await createEvent(db, {
        groupId: personal,
        title,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + hours * 3600_000).toISOString(),
        createdBy: john,
      });
    }
  });

  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const nudge = () =>
    __testing.renderEventCreatedNudge(
      db,
      JSON.stringify({
        kind: 'trip',
        title: 'Trip to Ann Arbor',
        when: `${dayAhead(2)} → ${dayAhead(4)} (Ann Arbor)`,
        sourceGroupId: family,
        sourceGroupName: 'Doe Family',
        actorUserId: john,
        tripId,
      }),
    );

  const context = () =>
    __testing.loadNudgeContext(db, {
      kind: 'trip',
      title: 'Trip to Ann Arbor',
      when: `${dayAhead(2)} → ${dayAhead(4)} (Ann Arbor)`,
      sourceGroupId: family,
      sourceGroupName: 'Doe Family',
      actorUserId: john,
      tripId,
    });

  it('asks who is going instead of guessing a conflict', async () => {
    const body = await nudge();
    expect(body).toContain('Who is going on "Trip to Ann Arbor"');
    expect(body).not.toContain('Conflict');
    expect((await listPendingTripTravelers(db, john)).map((p) => p.tripId)).toEqual([tripId]);
  });

  it('the answer in the personal chat finds the family trip and stores Ben', async () => {
    await nudge();
    const res = await applyToolCall(db, {
      groupId: personal,
      actorUserId: john,
      provenance: 'test',
      call: { name: 'set_trip_passengers', args: { passengerNames: ['Ben Doe'], tripQuery: 'Trip to Ann Arbor is Ben Doe' } },
    });
    expect(res.summary).not.toContain('need disambiguation');
    expect(res.data).toMatchObject({ updated: true, tripId, byNameOnly: [] });
    expect((await loadTripTravelers(db, [tripId], null)).get(tripId)).toEqual([{ userId: null, name: 'Ben Doe' }]);
    expect((await whoseTrips(db, [{ id: tripId, created_by: john }], null)).get(tripId)).toBe('travelers: Ben Doe');

    // The question is answered and the conflict check queued to run again.
    expect(await listPendingTripTravelers(db, john)).toEqual([]);
    const queued = await db.selectFrom('proactive_messages').select('payload').where('kind', '=', 'event_created_nudge').execute();
    expect(queued.some((q) => q.payload.includes(tripId))).toBe(true);

    // Now John's own events are not Ben's trip's clashes.
    const ctx = await context();
    expect(ctx).not.toContain('John and Yash');
    expect(ctx).not.toContain('Get skis');
    expect(await nudge()).not.toContain('Who is going');
  });

  it('a first name finds the family member', async () => {
    expect(await resolveTripTraveler(db, family, 'Ben')).toEqual({ userId: null, personaId: ben, name: 'Ben Doe' });
    expect(await resolveTripTraveler(db, family, 'John')).toMatchObject({ userId: john, personaId: null });
    expect(await resolveTripTraveler(db, family, 'Yash')).toBeNull();
  });

  it('a friend Chord knows nothing about is a traveller too', async () => {
    const res = await applyToolCall(db, {
      groupId: family,
      actorUserId: john,
      provenance: 'test',
      call: { name: 'set_trip_passengers', args: { passengerNames: ['Yash Mehta', 'Ben'], tripId } },
    });
    expect(res.data).toMatchObject({ updated: true, tripId, byNameOnly: ['Yash Mehta'] });
    expect(res.summary).toContain('saved by name');
    const travelers = (await loadTripTravelers(db, [tripId], null)).get(tripId) ?? [];
    expect(travelers.map((t) => t.name).sort()).toEqual(['Ben Doe', 'Yash Mehta']);

    // Said again (another spelling of the case) it is still one person.
    await applyToolCall(db, {
      groupId: family,
      actorUserId: john,
      provenance: 'test',
      call: { name: 'set_trip_passengers', args: { passengerNames: ['yash  mehta'], tripId } },
    });
    expect((await loadTripTravelers(db, [tripId], null)).get(tripId)).toHaveLength(2);
  });

  it('a family member taken off the roster stays on the trip by name', async () => {
    await applyToolCall(db, {
      groupId: family,
      actorUserId: john,
      provenance: 'test',
      call: { name: 'set_trip_passengers', args: { passengerNames: ['Ben'], tripId } },
    });
    await db.deleteFrom('personas').where('id', '=', ben).execute();
    expect((await loadTripTravelers(db, [tripId], null)).get(tripId)).toEqual([{ userId: null, name: 'Ben Doe' }]);
  });
});
