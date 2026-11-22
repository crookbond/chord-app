/**
 * Someone else's ticket shows as FREE on your calendar.
 *
 * Request: John booked Ben's flight and it sits on John's calendar as
 * busy, hiding John's real clashes. When the trip names its
 * travellers and you are not one of them, your copy should be free; the
 * traveller's own copy, and any ticket on a trip that names nobody, stay busy.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent } from '@/services/events.service.js';
import { localRowToGoogleBody } from '@/services/google/two-way-sync.js';
import { createGroup } from '@/services/groups.service.js';
import { refreshTicketFreeBusy } from '@/services/trips/ticket-free-busy.js';

// A week ahead: the sweep skips tickets that began over a day ago, so a
// fixed date stops being swept once it passes.
const DAY = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
const TRIP_END = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${DAY}T${hhmm}:00-05:00`;
const UID = 'chord:travel_leg:lg_adv';

describe("someone else's ticket is free on your calendar", () => {
  let db: Kysely<DB>;
  let john: string;

  async function copies() {
    const rows = await db
      .selectFrom('events')
      .select(['owner_user_id', 'transparency', 'local_dirty'])
      .where('external_uid', '=', UID)
      .execute();
    return new Map(rows.map((r) => [r.owner_user_id, r]));
  }

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'john');
    const gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: john })).id;
    const now = new Date().toISOString();
    await db
      .insertInto('trips')
      .values({
        id: 'tr_mdw', group_id: gid, name: 'Chicago', destination: 'Chicago',
        start_date: DAY, end_date: TRIP_END, created_by: john, created_at: now,
        source_raw_context: null, cancelled_at: null, deleted_at: null,
      })
      .execute();
    await db
      .insertInto('travel_legs')
      .values({
        id: 'lg_adv', trip_id: 'tr_mdw', persona_id: null, passenger_name: 'DOE/BEN MSTR',
        mode: 'flight', origin: 'LGA', destination: 'MDW', depart_at: at('09:00'), arrive_at: at('11:00'),
        carrier: 'WN', flight_no: '1234', confirmation: null, notes: null, source_doc_id: null,
        created_at: now, source_raw_context: null, cancelled_at: null,
      })
      .execute();
    await createEvent(db, {
      groupId: gid, title: 'Flight WN 1234 LGA → MDW', startsAt: at('09:00'), endsAt: at('11:00'),
      createdBy: john, externalUid: UID,
    });
    await db.updateTable('events').set({ local_dirty: 0 }).where('external_uid', '=', UID).execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it("Ben's flight is free on the parent's calendar and queued for the push", async () => {
    await refreshTicketFreeBusy(db, { externalUids: [UID] });
    const c = await copies();
    expect(c.get(john)).toMatchObject({ transparency: 'transparent', local_dirty: 1 });
  });

  it("the traveller's own copy stays busy, and goes back to busy when they are added", async () => {
    await refreshTicketFreeBusy(db, { externalUids: [UID] });
    await db.updateTable('travel_legs').set({ passenger_name: null, persona_id: john }).where('id', '=', 'lg_adv').execute();
    await refreshTicketFreeBusy(db);
    const c = await copies();
    expect(c.get(john)?.transparency).toBe('opaque');
  });

  it('a ticket on a trip that names nobody stays busy', async () => {
    await db.updateTable('travel_legs').set({ passenger_name: null }).where('id', '=', 'lg_adv').execute();
    expect(await refreshTicketFreeBusy(db, { externalUids: [UID] })).toBe(0);
    const c = await copies();
    expect(c.get(john)?.transparency).toBe('opaque');
  });

  it('a free copy is pushed to Google as free', () => {
    const body = localRowToGoogleBody({
      title: 'Flight WN 1234 LGA → MDW', starts_at: at('09:00'), ends_at: at('11:00'), transparency: 'transparent',
    });
    expect(body.transparency).toBe('transparent');
  });
});
