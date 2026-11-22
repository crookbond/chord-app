/**
 * The morning scan's `find_events` tool must not resurrect events the user
 * deleted or moved. Prod: a "water shutdown" event moved a week out still
 * showed up in the daily briefing at its original date.
 *
 * Two ways a stale row reached the model, both because this tool (unlike the
 * bot's own find_events and `listEventsForUser`) filtered neither by owner nor
 * by tombstone:
 *   - a delete waiting on its Google push is status='cancelled' + deleted_at;
 *   - a shared event fans out one copy per member, and an attendee editing
 *     their own copy leaves every sibling on the old date.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent, updateEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { __testing } from '@/services/proactive.service.js';

const { executeScanTool } = __testing;

function daysFromNow(days: number): { iso: string; day: string } {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(14, 0, 0, 0);
  const iso = d.toISOString();
  return { iso, day: iso.slice(0, 10) };
}

async function findOn(db: Kysely<DB>, userId: string, day: string): Promise<string[]> {
  const res = await executeScanTool(db, userId, {
    name: 'find_events',
    args: { startDate: day, endDate: day },
  });
  return (res.events as Array<{ title: string }>).map((e) => e.title);
}

describe('morning scan find_events — deleted and moved events', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('does not return an event that was deleted (tombstoned, push pending)', async () => {
    const alice = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    const original = daysFromNow(2);

    const ev = await createEvent(db, {
      groupId: group.id,
      title: 'Water shutdown',
      startsAt: original.iso,
      createdBy: alice,
    });
    expect(await findOn(db, alice, original.day)).toEqual(['Water shutdown']);

    // The state deleteEvent leaves while the Google delete is still pending
    // (or after it gave up): tombstoned, not yet dropped.
    await db
      .updateTable('events')
      .set({ status: 'cancelled', deleted_at: new Date().toISOString(), local_dirty: 1 })
      .where('id', '=', ev.id)
      .execute();

    expect(await findOn(db, alice, original.day)).toEqual([]);
  });

  it("does not return a sibling member's stale copy of an event the user moved", async () => {
    const alice = await createUser(db, 'alice', 'Alice');
    const bob = await createUser(db, 'bob', 'Bob');
    const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    await addMember(db, group.id, bob);
    const original = daysFromNow(2);
    const moved = daysFromNow(9);

    await createEvent(db, {
      groupId: group.id,
      title: 'Water shutdown',
      startsAt: original.iso,
      createdBy: alice,
    });
    const bobCopy = await db
      .selectFrom('events')
      .select(['id'])
      .where('owner_user_id', '=', bob)
      .where('title', '=', 'Water shutdown')
      .executeTakeFirstOrThrow();
    // An attendee's edit touches only their own row (ADR 0040 §9), so mark
    // Alice's copy an attendee copy and move it: Bob's copy stays behind.
    const aliceCopy = await db
      .selectFrom('events')
      .select(['id', 'role'])
      .where('owner_user_id', '=', alice)
      .where('title', '=', 'Water shutdown')
      .executeTakeFirstOrThrow();
    expect(bobCopy.id).not.toBe(aliceCopy.id);
    await db
      .updateTable('events')
      .set({ role: 'attendee' })
      .where('id', '=', aliceCopy.id)
      .execute();
    await updateEvent(db, aliceCopy.id, { startsAt: moved.iso });

    // Alice's own copy moved — the old date must be empty for her.
    expect(await findOn(db, alice, original.day)).toEqual([]);
    expect(await findOn(db, alice, moved.day)).toEqual(['Water shutdown']);
    // Bob never moved his; his own view is unchanged.
    expect(await findOn(db, bob, original.day)).toEqual(['Water shutdown']);
  });
});
