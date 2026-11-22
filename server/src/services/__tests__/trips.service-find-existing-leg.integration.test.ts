/**
 * findExistingLeg compared departure DATES as string prefixes, so one flight
 * written with two offsets fell on two "dates": a late-evening New York
 * departure restated in UTC (a minute or two of rounding apart) was not
 * matched and the leg was filed twice (ADR 0208: compare instants).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { addTravelLeg, createTrip, findExistingLeg } from '@/services/trips.service.js';

let db: Kysely<DB>;
beforeEach(async () => { db = await openTestDb(); });
afterEach(async () => { await closeTestDb(db); });

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function tripWithLeg() {
  const uid = await createUser(db, 'john', 'John Doe');
  const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
  const trip = await createTrip(db, {
    groupId: group.id,
    createdBy: uid,
    name: 'Trip to Delhi',
    destination: 'DEL',
    startDate: day(30),
    endDate: day(31),
    participantIds: [],
  });
  // 23:30 in New York on day 30 is 04:30Z on day 31.
  await addTravelLeg(db, {
    tripId: trip.id,
    mode: 'flight',
    origin: 'JFK',
    destination: 'DEL',
    departAt: `${day(30)}T23:30:00-05:00`,
    arriveAt: `${day(32)}T00:15:00+05:30`,
    carrier: 'AIR INDIA',
    flightNo: 'AI102',
    passengerName: 'John Doe',
  });
  return trip.id;
}

describe('findExistingLeg', () => {
  it('matches the same flight restated in UTC with a rounded time', async () => {
    const tripId = await tripWithLeg();
    const match = await findExistingLeg(db, {
      tripId,
      mode: 'flight',
      origin: 'JFK',
      destination: 'DEL',
      departAt: `${day(31)}T04:32:00Z`,
      arriveAt: `${day(31)}T18:45:00Z`,
      flightNo: 'AI102',
      passengerName: 'John Doe',
    });
    expect(match).not.toBeNull();
  });

  it('still treats a different departure time as a different leg', async () => {
    const tripId = await tripWithLeg();
    const match = await findExistingLeg(db, {
      tripId,
      mode: 'flight',
      origin: 'JFK',
      destination: 'DEL',
      departAt: `${day(31)}T09:30:00Z`,
      arriveAt: `${day(31)}T23:45:00Z`,
      flightNo: 'AI102',
      passengerName: 'John Doe',
    });
    expect(match).toBeNull();
  });
});
