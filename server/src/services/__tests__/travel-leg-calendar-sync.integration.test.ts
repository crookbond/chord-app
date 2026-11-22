/**
 * Adding a flight leg mirrors it as a calendar event in the same group,
 * keyed by chord:travel_leg:<legId> so repeat ingests dedup.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { createTrip, addTravelLeg } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function waitForFlightEvent(db: Kysely<DB>, groupId: string): Promise<string | null> {
  // createEvent fires pushEventCreate in a background promise; the event
  // row itself is written synchronously inside addTravelLeg's catch-then-
  // log promise chain. Poll briefly so the assertion isn't racy.
  for (let i = 0; i < 50; i++) {
    const row = await db
      .selectFrom('events')
      .select(['id', 'title'])
      .where('group_id', '=', groupId)
      .executeTakeFirst();
    if (row) return row.title;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe('travel leg → calendar event mirror', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    // Quiet "pushEventCreate background failure" noise — these tests don't
    // exercise the Google push path.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  it('creates one event per flight leg with carrier+flight# in the title', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: g.id,
      createdBy: uid,
      name: 'Lisbon',
      destination: 'LIS',
      startDate: '2026-08-01',
      endDate: '2026-08-10', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'SFO',
      destination: 'LIS',
      departAt: '2026-08-01T18:00:00.000Z',
      arriveAt: '2026-08-02T08:00:00.000Z',
      carrier: 'UA',
      flightNo: '123',
    });

    const title = await waitForFlightEvent(db, g.id);
    expect(title).toBe('UA 123 SFO→LIS');
  });

  it("a flight lands on the creator's OWN calendar, not a group-wide one (ADR 0232)", async () => {
    // Prod: a calendar named once was remembered for the whole group, so every
    // flight in it went to that "Family" calendar. A flight is personal by
    // default; sharing a trip with the family is a suggestion, not a given.
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    await db.updateTable('users').set({ default_calendar_id: 'alice-cal-id' }).where('id', '=', uid).execute();
    // A default stored on the group by the old behaviour must be ignored.
    await db.updateTable('groups').set({ default_calendar_id: 'family-cal-id' }).where('id', '=', g.id).execute();
    const trip = await createTrip(db, {
      groupId: g.id,
      createdBy: uid,
      name: 'Lisbon',
      destination: 'LIS',
      startDate: '2026-08-01',
      endDate: '2026-08-10', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'SFO',
      destination: 'LIS',
      departAt: '2026-08-01T18:00:00.000Z',
      arriveAt: '2026-08-02T08:00:00.000Z',
      carrier: 'UA',
      flightNo: '123',
    });
    await waitForFlightEvent(db, g.id);

    const row = await db
      .selectFrom('events')
      .select(['google_calendar_id', 'local_dirty'])
      .where('group_id', '=', g.id)
      .executeTakeFirstOrThrow();
    expect(row.google_calendar_id).toBe('alice-cal-id');
    expect(row.local_dirty).toBe(1);
  });

  it('with no default of their own, a flight goes to primary', async () => {
    const uid = await createUser(db, 'bob');
    const g = await createGroup(db, { name: 'Fam2', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: g.id,
      createdBy: uid,
      name: 'Oslo',
      destination: 'OSL',
      startDate: '2026-09-01',
      endDate: '2026-09-05', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'SFO',
      destination: 'OSL',
      departAt: '2026-09-01T18:00:00.000Z',
      arriveAt: '2026-09-02T08:00:00.000Z',
      carrier: 'SK',
      flightNo: '904',
    });
    await waitForFlightEvent(db, g.id);
    const row = await db
      .selectFrom('events')
      .select('google_calendar_id')
      .where('group_id', '=', g.id)
      .executeTakeFirstOrThrow();
    expect(row.google_calendar_id).toBe('primary');
  });

  it('does NOT mirror non-flight legs', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: g.id,
      createdBy: uid,
      name: 'Road trip',
      destination: 'Tahoe',
      startDate: '2026-07-01',
      endDate: '2026-07-05', participantIds: [],
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'car',
      origin: 'SF',
      destination: 'Tahoe',
      departAt: '2026-07-01T15:00:00.000Z',
      arriveAt: '2026-07-01T20:00:00.000Z',
    });

    // Give any background promise a moment, then assert no event was written.
    await new Promise((r) => setTimeout(r, 100));
    const row = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', g.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('dedups when the same flight leg is added twice', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const trip = await createTrip(db, {
      groupId: g.id,
      createdBy: uid,
      name: 'Lisbon',
      destination: 'LIS',
      startDate: '2026-08-01',
      endDate: '2026-08-10', participantIds: [],
    });
    const input = {
      tripId: trip.id,
      mode: 'flight' as const,
      origin: 'SFO',
      destination: 'LIS',
      departAt: '2026-08-01T18:00:00.000Z',
      arriveAt: '2026-08-02T08:00:00.000Z',
      carrier: 'UA',
      flightNo: '123',
    };
    await addTravelLeg(db, input);
    await waitForFlightEvent(db, g.id);
    await addTravelLeg(db, input);
    await new Promise((r) => setTimeout(r, 100));

    const rows = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', g.id)
      .execute();
    expect(rows.length).toBe(1);
  });
});
