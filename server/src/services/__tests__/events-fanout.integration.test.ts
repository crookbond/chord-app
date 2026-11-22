/**
 * ADR 0040 §7–9 — eager-copy fan-out, the owner-scoped read primitive, and
 * organizer-authoritative edit/delete propagation. Real DB; Google push is a
 * no-op here (no write scope), so we only assert on local copies.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  createEvent,
  deleteEvent,
  findEventsByTitle,
  getEvent,
  listEventsForUser,
  listEventsForUserInGroup,
  updateEvent,
} from '@/services/events.service.js';
import { backfillCalendarFanout } from '@/db/migrate.js';
import { createGroup } from '@/services/groups.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function rawCopies(db: Kysely<DB>, icalUid: string) {
  return db
    .selectFrom('events')
    .select(['id', 'owner_user_id', 'organizer_user_id', 'role', 'title', 'starts_at', 'group_id'])
    .where('ical_uid', '=', icalUid)
    .orderBy('role', 'asc')
    .execute();
}

describe('createEvent fan-out (ADR 0040 §7)', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;
  let carol: string;
  let group: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
    bob = await createUser(db, 'bob');
    carol = await createUser(db, 'carol');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: alice });
    group = g.id;
    await addMember(db, group, bob);
    await addMember(db, group, carol);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a no-assignee group event fans out to one copy per member', async () => {
    const ev = await createEvent(db, {
      groupId: group,
      title: 'Family dinner',
      startsAt: '2026-06-10T18:00:00Z',
      endsAt: '2026-06-10T19:00:00Z',
      createdBy: alice,
    });
    // Caller gets their own (organizer) copy back.
    const mine = await getEvent(db, ev.id);
    expect(mine?.createdBy).toBe(alice);

    const row = await db
      .selectFrom('events')
      .select(['ical_uid'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const copies = await rawCopies(db, row.ical_uid!);
    expect(copies).toHaveLength(3);

    const byOwner = new Map(copies.map((c) => [c.owner_user_id, c]));
    expect(byOwner.get(alice)?.role).toBe('organizer');
    expect(byOwner.get(bob)?.role).toBe('attendee');
    expect(byOwner.get(carol)?.role).toBe('attendee');
    // Organizer is the creator on every copy.
    expect(copies.every((c) => c.organizer_user_id === alice)).toBe(true);

    // Each member sees it on their own calendar (owner-scoped read).
    for (const m of [alice, bob, carol]) {
      const list = await listEventsForUser(db, m, { pastDays: 3650, futureDays: 3650 });
      expect(list.map((e) => e.title)).toContain('Family dinner');
      const inGroup = await listEventsForUserInGroup(db, m, group, { pastDays: 3650, futureDays: 3650 });
      expect(inGroup.map((e) => e.title)).toContain('Family dinner');
    }
  });

  it('fanned-out copies resolve their target calendar: their own user default, else primary', async () => {
    // bob has a personal default calendar; carol has none.
    await db.updateTable('users').set({ default_calendar_id: 'bob-cal' }).where('id', '=', bob).execute();

    const ev = await createEvent(db, {
      groupId: group,
      title: 'Picnic',
      startsAt: '2026-07-01T16:00:00Z',
      createdBy: alice,
      googleCalendarId: 'alice-requested-cal', // caller-resolved creator copy
    });
    const row = await db
      .selectFrom('events')
      .select(['ical_uid'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const copies = await db
      .selectFrom('events')
      .select(['owner_user_id', 'google_calendar_id'])
      .where('ical_uid', '=', row.ical_uid!)
      .execute();
    const calByOwner = new Map(copies.map((c) => [c.owner_user_id, c.google_calendar_id]));
    expect(calByOwner.get(alice)).toBe('alice-requested-cal'); // creator: caller-provided
    expect(calByOwner.get(bob)).toBe('bob-cal'); // non-creator: their user default
    expect(calByOwner.get(carol)).toBe('primary'); // non-creator, no default: primary

    // A default stored on the group by the old behaviour (ADR 0232) must not
    // send everyone's copy to one calendar id: each member still gets their own.
    await db.updateTable('groups').set({ default_calendar_id: 'fam-cal' }).where('id', '=', group).execute();
    const ev2 = await createEvent(db, {
      groupId: group,
      title: 'Beach day',
      startsAt: '2026-07-02T16:00:00Z',
      createdBy: alice,
      googleCalendarId: 'alice-requested-cal',
    });
    const row2 = await db
      .selectFrom('events')
      .select(['ical_uid'])
      .where('id', '=', ev2.id)
      .executeTakeFirstOrThrow();
    const copies2 = await db
      .selectFrom('events')
      .select(['owner_user_id', 'google_calendar_id'])
      .where('ical_uid', '=', row2.ical_uid!)
      .execute();
    const cal2 = new Map(copies2.map((c) => [c.owner_user_id, c.google_calendar_id]));
    expect(cal2.get(bob)).toBe('bob-cal');
    expect(cal2.get(carol)).toBe('primary');
    expect([...cal2.values()]).not.toContain('fam-cal');
  });

  it('a named single assignee stays a single copy (no fan-out)', async () => {
    // alice trusts nobody here; assign to herself ("add to MY calendar").
    const ev = await createEvent(db, {
      groupId: group,
      title: 'Alice dentist',
      startsAt: '2026-06-11T09:00:00Z',
      createdBy: alice,
      assigneeId: alice,
    });
    const row = await db
      .selectFrom('events')
      .select(['ical_uid'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const copies = await rawCopies(db, row.ical_uid!);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.owner_user_id).toBe(alice);

    // Bob and Carol do NOT get a copy.
    expect((await listEventsForUser(db, bob, { pastDays: 3650, futureDays: 3650 })).map((e) => e.title)).not.toContain('Alice dentist');
    expect((await listEventsForUser(db, carol, { pastDays: 3650, futureDays: 3650 })).map((e) => e.title)).not.toContain('Alice dentist');
  });

  it('group filter only returns copies tagged for that group', async () => {
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: alice });
    await createEvent(db, {
      groupId: group,
      title: 'In Fam',
      startsAt: '2026-06-12T10:00:00Z',
      createdBy: alice,
    });
    await createEvent(db, {
      groupId: other.id,
      title: 'In Other',
      startsAt: '2026-06-12T11:00:00Z',
      createdBy: alice,
    });
    const fam = await listEventsForUserInGroup(db, alice, group, { pastDays: 3650, futureDays: 3650 });
    expect(fam.map((e) => e.title)).toEqual(['In Fam']);
  });

  // Regression: findEventsByTitle (events.service.ts) is the direct-SQL
  // title match update_event/delete_event use. It matches every row in the
  // group, and a no-assignee group event fans out to one row PER MEMBER
  // (alice/bob/carol above), all sharing the same title and starts_at —
  // without deduping by ical_uid the same event would look like three
  // "ambiguous" candidates instead of the one logical event listEvents has
  // always collapsed it to.
  it('findEventsByTitle collapses a fanned-out event to one candidate, not one per member', async () => {
    await createEvent(db, {
      groupId: group,
      title: 'Family Dinner',
      startsAt: '2026-06-10T18:00:00Z',
      createdBy: alice,
    });
    const matches = await findEventsByTitle(db, { groupId: group }, 'family dinner');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.title).toBe('Family Dinner');
  });
});

describe('organizer edit/delete propagation (ADR 0040 §9)', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;
  let group: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
    bob = await createUser(db, 'bob');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: alice });
    group = g.id;
    await addMember(db, group, bob);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function fanOut() {
    const ev = await createEvent(db, {
      groupId: group,
      title: 'Picnic',
      startsAt: '2026-07-01T12:00:00Z',
      endsAt: '2026-07-01T13:00:00Z',
      createdBy: alice,
    });
    const aliceCopy = await db
      .selectFrom('events')
      .select(['id', 'ical_uid', 'sequence'])
      .where('id', '=', ev.id)
      .executeTakeFirstOrThrow();
    const bobCopy = await db
      .selectFrom('events')
      .select(['id', 'sequence'])
      .where('ical_uid', '=', aliceCopy.ical_uid!)
      .where('owner_user_id', '=', bob)
      .executeTakeFirstOrThrow();
    return { aliceCopy, bobCopy };
  }

  it('an organizer edit moves every copy and bumps sequence on all', async () => {
    const { aliceCopy, bobCopy } = await fanOut();
    await updateEvent(db, aliceCopy.id, { startsAt: '2026-07-01T15:00:00Z', title: 'Picnic (moved)' });

    const bobAfter = await getEvent(db, bobCopy.id);
    expect(bobAfter?.startsAt).toBe('2026-07-01T15:00:00Z');
    expect(bobAfter?.title).toBe('Picnic (moved)');
    const bobSeq = await db
      .selectFrom('events')
      .select(['sequence'])
      .where('id', '=', bobCopy.id)
      .executeTakeFirstOrThrow();
    expect(bobSeq.sequence).toBe(bobCopy.sequence + 1);
  });

  it('an attendee edit touches only their own copy', async () => {
    const { aliceCopy, bobCopy } = await fanOut();
    await updateEvent(db, bobCopy.id, { title: 'Picnic (bob note)' });

    expect((await getEvent(db, bobCopy.id))?.title).toBe('Picnic (bob note)');
    expect((await getEvent(db, aliceCopy.id))?.title).toBe('Picnic');
  });

  it('an organizer delete removes every copy', async () => {
    const { aliceCopy, bobCopy } = await fanOut();
    await deleteEvent(db, aliceCopy.id);
    expect(await getEvent(db, aliceCopy.id)).toBeNull();
    expect(await getEvent(db, bobCopy.id)).toBeNull();
  });

  it('an attendee delete removes only their own copy', async () => {
    const { aliceCopy, bobCopy } = await fanOut();
    await deleteEvent(db, bobCopy.id);
    expect(await getEvent(db, bobCopy.id)).toBeNull();
    expect(await getEvent(db, aliceCopy.id)).not.toBeNull();
  });
});

describe('backfillCalendarFanout (legacy → per-member copies)', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;
  let group: string;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
    bob = await createUser(db, 'bob');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: alice });
    group = g.id;
    await addMember(db, group, bob);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedLegacy(over: Partial<Record<string, unknown>> = {}) {
    const now = '2026-05-01T00:00:00.000Z';
    await db
      .insertInto('events')
      .values({
        id: 'legacy1',
        group_id: group,
        title: 'Legacy group event',
        starts_at: '2026-06-20T18:00:00Z',
        ends_at: '2026-06-20T19:00:00Z',
        created_by: alice,
        created_at: now,
        owner_user_id: alice,
        organizer_user_id: alice,
        role: 'organizer',
        ical_uid: 'legacy-uid-1',
        group_ids: JSON.stringify([group]),
        status: 'confirmed',
        all_day: 0,
        sequence: 0,
        transparency: 'opaque',
        local_dirty: 0,
        updated_at: now,
        ...(over as object),
      })
      .execute();
  }

  it('creates a per-member copy and is idempotent', async () => {
    await seedLegacy();
    await backfillCalendarFanout(db);

    const copies = await rawCopies(db, 'legacy-uid-1');
    expect(copies).toHaveLength(2);
    const bobCopy = copies.find((c) => c.owner_user_id === bob);
    expect(bobCopy?.role).toBe('attendee');
    expect(bobCopy?.organizer_user_id).toBe(alice);

    // Re-running adds nothing.
    await backfillCalendarFanout(db);
    expect(await rawCopies(db, 'legacy-uid-1')).toHaveLength(2);

    // Bob now sees it.
    expect((await listEventsForUser(db, bob, { pastDays: 3650, futureDays: 3650 })).map((e) => e.title)).toContain('Legacy group event');
  });

  it('skips delegated (assigned) events — they stay single-owner', async () => {
    await seedLegacy({ id: 'legacy2', ical_uid: 'legacy-uid-2', assignee_id: alice });
    await backfillCalendarFanout(db);
    expect(await rawCopies(db, 'legacy-uid-2')).toHaveLength(1);
  });
});
