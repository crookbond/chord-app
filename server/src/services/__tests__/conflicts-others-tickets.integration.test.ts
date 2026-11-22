/**
 * A family member's ticket on the parent's calendar is not the parent's time.
 *
 * Failure being fixed: Ben's flight sits on his parent's calendar (the
 * parent booked it), and the busy check read it as the parent being busy -
 * so adding the parent's own dinner raised a conflict alert against Ben's
 * flight, and get_my_availability / the reply drafter offered no time there.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { busyIntervalsInWindow, computeConflicts } from '@/services/conflicts.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';

const DAY = '2026-11-12';
const at = (hhmm: string) => `${DAY}T${hhmm}:00-05:00`;

describe("someone else's ticket is not the user's busy time", () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john');
    await db.updateTable('users').set({ last_tz: 'America/New_York' }).where('id', '=', uid).execute();
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
    await db
      .insertInto('trips')
      .values({
        id: 'tr_mdw',
        group_id: gid,
        name: 'Chicago',
        destination: 'Chicago',
        start_date: DAY,
        end_date: '2026-11-20',
        created_by: uid,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: null,
        deleted_at: null,
      })
      .execute();
    await db
      .insertInto('travel_legs')
      .values({
        id: 'lg_adv',
        trip_id: 'tr_mdw',
        persona_id: null,
        passenger_name: 'DOE/BEN MSTR',
        mode: 'flight',
        origin: 'LGA',
        destination: 'MDW',
        depart_at: at('09:00'),
        arrive_at: at('11:00'),
        carrier: 'WN',
        flight_no: '1234',
        confirmation: null,
        notes: null,
        source_doc_id: null,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: null,
      })
      .execute();
    await createEvent(db, {
      groupId: gid,
      title: 'Flight WN 1234 LGA → MDW',
      startsAt: at('09:00'),
      endsAt: at('11:00'),
      createdBy: uid,
      externalUid: 'chord:travel_leg:lg_adv',
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it("Ben's flight does not conflict with the parent's own coffee", async () => {
    const conflicts = await computeConflicts(db, { userId: uid, startIso: at('10:00'), endIso: at('10:30') });
    expect(conflicts).toEqual([]);
  });

  it("Ben's flight leaves the parent's morning free", async () => {
    const { intervals } = await busyIntervalsInWindow(db, { userId: uid, startIso: at('00:00'), endIso: at('23:59') });
    expect(intervals).toEqual([]);
  });

  it("the parent's own ticket does take their time", async () => {
    await db.updateTable('travel_legs').set({ passenger_name: null, persona_id: uid }).where('id', '=', 'lg_adv').execute();
    const conflicts = await computeConflicts(db, { userId: uid, startIso: at('10:00'), endIso: at('10:30') });
    expect(conflicts.map((c) => c.title)).toEqual(['Flight WN 1234 LGA → MDW']);
  });
});
