/**
 * Briefing TRIPS lines name who is travelling, so the morning message can say
 * whose trip is starting rather than only "Vail trip Thursday".
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { loadScanContext } from '@/services/proactive.service.js';
import { displayTravelerName, tripTravelerNames } from '@/services/trips/chain.js';

const DAY = 24 * 60 * 60_000;
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const instantAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString();

function tripLine(ctx: string, name: string): string {
  return ctx.split('\n').find((l) => l.startsWith('  - ') && l.includes(`"${name}"`)) ?? '';
}

describe('tripTravelerNames', () => {
  it('turns ticket spellings into names and keeps one entry per person', () => {
    expect(displayTravelerName('DOE/JOHN MR')).toBe('John Doe');
    expect(displayTravelerName('STONE SIMON MR')).toBe('Stone Simon');
    expect(displayTravelerName('Ada')).toBe('Ada');
    expect(tripTravelerNames(['Ada', 'ADA DOE', null, 'DOE/JOHN MR', 'John Doe', ''])).toEqual([
      'Ada',
      'John Doe',
    ]);
  });
});

describe('loadScanContext — TRIPS travelers', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function trip(id: string, name: string, destination: string): Promise<void> {
    await db
      .insertInto('trips')
      .values({
        id,
        group_id: gid,
        name,
        destination,
        start_date: dayAhead(3),
        end_date: dayAhead(8),
        created_by: uid,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: null,
        deleted_at: null,
      })
      .execute();
  }

  async function leg(id: string, tripId: string, passenger: string | null, cancelled = false): Promise<void> {
    await db
      .insertInto('travel_legs')
      .values({
        id,
        trip_id: tripId,
        persona_id: null,
        passenger_name: passenger,
        mode: 'flight',
        origin: 'JFK',
        destination: 'EGE',
        depart_at: instantAhead(3),
        arrive_at: instantAhead(3.2),
        carrier: 'UA',
        flight_no: '1234',
        confirmation: null,
        notes: null,
        source_doc_id: null,
        created_at: new Date().toISOString(),
        source_raw_context: null,
        cancelled_at: cancelled ? new Date().toISOString() : null,
      })
      .execute();
  }

  it('lists household travelers first, then ticket names, without cancelled ones', async () => {
    await trip('tr_vail', 'Vail', 'Vail, CO');
    // trip_participants.persona_id holds a USER id; the first version of this
    // joined `personas` and found no one.
    const ada = await createUser(db, 'ada');
    await db.updateTable('users').set({ display_name: 'Ada' }).where('id', '=', ada).execute();
    await db.insertInto('trip_participants').values({ trip_id: 'tr_vail', persona_id: ada }).execute();
    await leg('lg_1', 'tr_vail', 'DOE/ADA MRS');
    await leg('lg_2', 'tr_vail', 'DOE/BEN MSTR');
    await leg('lg_3', 'tr_vail', 'DOE/JOHN MR', true);

    const line = tripLine(await loadScanContext(db, uid), 'Vail');
    expect(line).toContain('travelers: Ada, Ben Doe');
    expect(line).not.toContain('John');
  });

  it('names who booked it when no traveller is named, without calling them a traveller', async () => {
    // It used to name no one, and the briefing said "Toronto trip Thursday".
    await db.updateTable('users').set({ display_name: 'Alice Doe' }).where('id', '=', uid).execute();
    await trip('tr_toronto', 'Toronto', 'Toronto');
    await leg('lg_t', 'tr_toronto', null);

    const line = tripLine(await loadScanContext(db, uid), 'Toronto');
    expect(line).toContain('"Toronto" → Toronto');
    expect(line).toContain('booked by: Alice Doe');
    expect(line).not.toContain('travelers');
  });

  it('leaves out cancelled and deleted trips', async () => {
    await trip('tr_live', 'Live', 'Boston');
    await trip('tr_cancelled', 'Cancelled', 'Denver');
    await trip('tr_deleted', 'Deleted', 'Austin');
    const at = new Date().toISOString();
    await db.updateTable('trips').set({ cancelled_at: at }).where('id', '=', 'tr_cancelled').execute();
    await db.updateTable('trips').set({ deleted_at: at }).where('id', '=', 'tr_deleted').execute();

    const ctx = await loadScanContext(db, uid);
    expect(tripLine(ctx, 'Live')).not.toBe('');
    expect(ctx).not.toContain('"Cancelled"');
    expect(ctx).not.toContain('"Deleted"');
  });
});
