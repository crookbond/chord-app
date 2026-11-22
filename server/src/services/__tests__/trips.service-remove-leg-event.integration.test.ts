/**
 * Reported 2026-11-19: Southwest WN2909 LGA→DEN and WN4501 DEN→LGA each sat
 * on the Family calendar three times. Two of the three were the events of legs
 * removed with the Trips tab's X: `removeTravelLeg` deleted the leg and left
 * its calendar event behind for a flight nobody was booked on. Removing a leg
 * now takes its event with it, or, when someone else is still on that flight,
 * takes only this passenger off the event.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { addTravelLeg, createTrip, removeTravelLeg } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const isoDay = (offsetDays: number): string => new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const OUT = isoDay(80);

describe('removing a trip flight removes its calendar event', () => {
  let db: Kysely<DB>;
  let uid: string;
  let tripId: string;

  beforeEach(async () => {
    db = await openTestDb();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    uid = await createUser(db, 'john', 'John Doe');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const t = await createTrip(db, {
      groupId: g.id, createdBy: uid, name: 'Denver', destination: 'DEN',
      startDate: OUT, endDate: isoDay(84), participantIds: [],
    });
    tripId = t.id;
  });
  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  const wn2909 = (passengerName?: string) => ({
    tripId,
    mode: 'flight' as const,
    origin: 'LGA',
    destination: 'DEN',
    departAt: `${OUT}T20:55:00-05:00`,
    arriveAt: `${OUT}T23:40:00-07:00`,
    carrier: 'Southwest Airlines',
    flightNo: 'WN2909',
    confirmation: 'CJCGMG',
    ...(passengerName ? { passengerName } : {}),
  });

  const flightEvents = () =>
    db
      .selectFrom('events')
      .select(['id', 'external_uid', 'description'])
      .where('deleted_at', 'is', null)
      .where('external_uid', 'like', 'chord:travel_leg:%')
      .execute();

  it('the only passenger removed: the event goes too', async () => {
    const leg = await addTravelLeg(db, wn2909('John'));
    expect(await flightEvents()).toHaveLength(1);
    expect(await removeTravelLeg(db, leg.id)).toBe(true);
    expect(await flightEvents()).toEqual([]);
  });

  it('one of two passengers removed: the event stays, without them, keyed to the other', async () => {
    const john = await addTravelLeg(db, wn2909('John'));
    const alice = await addTravelLeg(db, wn2909('Alice'));
    const [before] = await flightEvents();
    expect(before!.external_uid).toBe(`chord:travel_leg:${john.id}`);
    expect(before!.description).toContain('John');

    await removeTravelLeg(db, john.id);
    const after = await flightEvents();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.external_uid).toBe(`chord:travel_leg:${alice.id}`);
    expect(after[0]!.description).toContain('Alice');
    expect(after[0]!.description).not.toContain('John');
  });
});
