/**
 * The twin lookups compare event starts as instants. They used to cast
 * `starts_at::timestamptz` directly, so ONE row whose stored start is not a
 * timestamp (an import that wrote "TBD") made every lookup in that group or
 * for that owner throw — the create or the proposal sweep failed instead of
 * finding the real twin. textInstant (ADR 0208) reads such a value as NULL.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { findEmailEventTwin } from '@/services/event-convergence.service.js';
import { createEvent, findSimilarEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addTravelLeg, createTrip } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('twin lookups with a malformed stored start', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;
  const at = new Date(Date.now() + 5 * 24 * 60 * 60_000);
  at.setUTCMinutes(0, 0, 0);
  const startsAt = at.toISOString();

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    gid = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid })).id;

    const bad = await createEvent(db, {
      groupId: gid,
      title: 'Bake sale',
      startsAt,
      createdBy: uid,
      sourceRawContext: 'gmail:t-bad',
    });
    await db.updateTable('events').set({ starts_at: 'TBD' }).where('id', '=', bad.id).execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('findSimilarEvent still finds the real twin', async () => {
    const real = await createEvent(db, {
      groupId: gid,
      title: 'Dentist',
      startsAt,
      createdBy: uid,
    });
    const hit = await findSimilarEvent(db, gid, 'dentist', startsAt);
    expect(hit?.id).toBe(real.id);
  });

  it('findEmailEventTwin does not fail on the bad row', async () => {
    await expect(findEmailEventTwin(db, uid, startsAt, 'Dentist')).resolves.toBeUndefined();
  });

  it('a second passenger on a flight still joins its calendar event', async () => {
    // trips.service findFlightEvent / findSameFlightLegs had the same raw cast,
    // over leg-made events and legs.
    const trip = await createTrip(db, {
      groupId: gid, createdBy: uid, name: 'Denver', destination: 'Denver',
      startDate: '2027-02-11', endDate: '2027-02-15', participantIds: [],
    });
    const leg = { tripId: trip.id, mode: 'flight' as const, origin: 'JFK', destination: 'DEN',
      departAt: '2027-02-11T20:55:00-05:00', arriveAt: '2027-02-11T23:30:00-07:00' };
    await addTravelLeg(db, { ...leg, passengerName: 'John' });
    await db
      .updateTable('events')
      .set({ starts_at: 'TBD' })
      .where('group_id', '=', gid)
      .where('title', '=', 'Bake sale')
      .execute();
    await db.updateTable('events').set({ external_uid: 'chord:travel_leg:old' }).where('starts_at', '=', 'TBD').execute();
    await expect(addTravelLeg(db, { ...leg, passengerName: 'Alice' })).resolves.toBeDefined();
    const flightEvents = await db
      .selectFrom('events')
      .select('id')
      .where('group_id', '=', gid)
      .where('external_uid', 'like', 'chord:travel_leg:%')
      .where('starts_at', '!=', 'TBD')
      .execute();
    expect(flightEvents).toHaveLength(1);
  });
});
