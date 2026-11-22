/**
 * The conflict check that runs when an event is added lists the trips it
 * lands during. It said only "Vail to Vail, CO", so the warning could not say
 * whose trip it was, and it listed cancelled and deleted trips too.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { __testing } from '@/services/proactive.service.js';

const DAY = 24 * 60 * 60_000;
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

describe('new-event conflict check — overlapping trips', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'ada');
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function trip(id: string, name: string, extra: { cancelled?: boolean; deleted?: boolean } = {}) {
    const at = new Date().toISOString();
    await db
      .insertInto('trips')
      .values({
        id,
        group_id: gid,
        name,
        destination: `${name}, CO`,
        start_date: dayAhead(1),
        end_date: dayAhead(5),
        created_by: uid,
        created_at: at,
        source_raw_context: null,
        cancelled_at: extra.cancelled ? at : null,
        deleted_at: extra.deleted ? at : null,
      })
      .execute();
  }

  function context(): Promise<string> {
    return __testing.loadNudgeContext(db, {
      kind: 'event',
      title: 'Dentist',
      when: new Date(Date.now() + 2 * DAY).toISOString(),
      sourceGroupId: gid,
      sourceGroupName: 'Family',
      actorUserId: uid,
    });
  }

  it('says whose trip it is', async () => {
    await trip('tr_vail', 'Vail');
    await db
      .insertInto('travel_legs')
      .values({
        id: 'lg_1',
        trip_id: 'tr_vail',
        persona_id: null,
        passenger_name: 'DOE/BEN MSTR',
        mode: 'flight',
        origin: 'JFK',
        destination: 'EGE',
        depart_at: new Date(Date.now() + DAY).toISOString(),
        arrive_at: new Date(Date.now() + DAY + 5 * 3600_000).toISOString(),
        carrier: 'UA',
        flight_no: '1234',
        confirmation: null,
        notes: null,
        source_doc_id: null,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: null,
      })
      .execute();

    const line = (await context()).split('\n').find((l) => l.includes('"Vail"')) ?? '';
    expect(line).toContain('travelers: Ben Doe');
  });

  // ADR 0289 addendum: Ben's flight on Ada's calendar is not Ada's time,
  // so her new dentist appointment is not checked against it.
  it("leaves out someone else's ticket as a neighbour", async () => {
    await trip('tr_vail', 'Vail');
    await db
      .insertInto('travel_legs')
      .values({
        id: 'lg_adv',
        trip_id: 'tr_vail',
        persona_id: null,
        passenger_name: 'DOE/BEN MSTR',
        mode: 'flight',
        origin: 'JFK',
        destination: 'EGE',
        depart_at: new Date(Date.now() + 2 * DAY).toISOString(),
        arrive_at: new Date(Date.now() + 2 * DAY + 5 * 3600_000).toISOString(),
        carrier: 'UA',
        flight_no: '1234',
        confirmation: null,
        notes: null,
        source_doc_id: null,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: null,
      })
      .execute();
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    await createEvent(db, {
      groupId: gid,
      title: 'Flight UA 1234 JFK → EGE',
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 5 * 3600_000).toISOString(),
      createdBy: uid,
      externalUid: 'chord:travel_leg:lg_adv',
    });
    const ctx = await context();
    const neighbors = ctx.slice(ctx.indexOf('NEIGHBORS'));
    expect(neighbors).not.toContain('Flight UA 1234');
  });

  it('leaves out cancelled and deleted trips', async () => {
    await trip('tr_gone', 'Aspen', { cancelled: true });
    await trip('tr_deleted', 'Telluride', { deleted: true });
    const ctx = await context();
    expect(ctx).not.toContain('Aspen');
    expect(ctx).not.toContain('Telluride');
  });
});

// ADR 0289 — when a trip is added, an event or another trip during it is a
// clash only if someone on it is travelling; a trip naming nobody, time alone.
describe('new-trip conflict check — travellers', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'ada');
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function trip(id: string, name: string, passenger: string | null) {
    const at = new Date().toISOString();
    await db
      .insertInto('trips')
      .values({
        id,
        group_id: gid,
        name,
        destination: `${name}, CO`,
        start_date: dayAhead(1),
        end_date: dayAhead(5),
        created_by: uid,
        created_at: at,
        source_raw_context: null,
        cancelled_at: null,
        deleted_at: null,
      })
      .execute();
    if (!passenger) return;
    await db
      .insertInto('travel_legs')
      .values({
        id: `lg_${id}`,
        trip_id: id,
        persona_id: null,
        passenger_name: passenger,
        mode: 'flight',
        origin: 'JFK',
        destination: 'EGE',
        depart_at: new Date(Date.now() + DAY).toISOString(),
        arrive_at: new Date(Date.now() + DAY + 5 * 3600_000).toISOString(),
        carrier: 'UA',
        flight_no: '1234',
        confirmation: null,
        notes: null,
        source_doc_id: null,
        created_at: at,
        source_raw_context: null,
        cancelled_at: null,
      })
      .execute();
  }

  async function event(title: string) {
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    await createEvent(db, {
      groupId: gid,
      title,
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 3600_000).toISOString(),
      createdBy: uid,
    });
  }

  function context(tripId: string): Promise<string> {
    return __testing.loadNudgeContext(db, {
      kind: 'trip',
      title: 'Vail',
      when: `${dayAhead(1)} → ${dayAhead(5)}`,
      sourceGroupId: gid,
      sourceGroupName: 'Family',
      actorUserId: uid,
      tripId,
    });
  }

  it('leaves out an event for someone not travelling', async () => {
    await trip('tr_vail', 'Vail', 'DOE/BEN MSTR');
    await event('Dentist');
    expect(await context('tr_vail')).not.toContain('Dentist');
  });

  it('keeps an event for a traveller', async () => {
    await trip('tr_vail', 'Vail', 'DOE/ADA MS');
    await event('Dentist');
    expect(await context('tr_vail')).toContain('Dentist');
  });

  it('keeps every event when the trip names nobody', async () => {
    await trip('tr_vail', 'Vail', null);
    await event('Dentist');
    expect(await context('tr_vail')).toContain('Dentist');
  });

  // ADR 0289 addendum: a ticket on the calendar belongs to its trip's
  // travellers, not to the calendar's owner.
  it("another traveller's ticket is not a clash with the new trip", async () => {
    await trip('tr_vail', 'Vail', 'DOE/ADA MS');
    await trip('tr_yyz', 'Toronto', 'STONE/SIMON MR');
    const startsAt = new Date(Date.now() + 2 * DAY).toISOString();
    await createEvent(db, {
      groupId: gid,
      title: 'Amtrak 63 NYP → TWO',
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 5 * 3600_000).toISOString(),
      createdBy: uid,
      externalUid: 'chord:travel_leg:lg_tr_yyz',
    });
    expect(await context('tr_vail')).not.toContain('Amtrak 63');
  });

  it('another trip clashes only when someone is on both', async () => {
    await trip('tr_vail', 'Vail', 'DOE/BEN MSTR');
    await trip('tr_aspen', 'Aspen', 'DOE/ADA MS');
    expect(await context('tr_vail')).not.toContain('Aspen');
    await trip('tr_breck', 'Breck', 'DOE/BEN MSTR');
    expect(await context('tr_vail')).toContain('Breck');
    await trip('tr_keystone', 'Keystone', null);
    expect(await context('tr_vail')).toContain('Keystone');
  });
});
