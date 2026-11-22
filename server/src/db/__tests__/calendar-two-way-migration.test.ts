/**
 * Migration 005 (ADR 0040 expand phase). Two halves:
 *   1. Schema shape — the new columns / table / index exist on the migrated
 *      template (every per-test DB is a clone of it).
 *   2. Backfill behaviour — seed legacy-shaped rows (new columns at their
 *      ADD-COLUMN defaults, exactly the pre-UPDATE state) and run the real,
 *      idempotent `backfillCalendarTwoWaySync` helper the migration uses, so
 *      we test the actual backfill SQL rather than a copy of it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';

import { backfillCalendarTwoWaySync } from '@/db/migrate.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function columnsOf(table: string): Promise<Set<string>> {
  const res = await sql<{ column_name: string }>`
    SELECT column_name FROM information_schema.columns WHERE table_name = ${table}
  `.execute(db);
  return new Set(res.rows.map((r) => r.column_name));
}

describe('migration 005 — schema shape', () => {
  it('adds the ADR 0040 columns to events', async () => {
    const cols = await columnsOf('events');
    for (const c of [
      'chord_uid',
      'ical_uid',
      'sequence',
      'etag',
      'owner_user_id',
      'organizer_user_id',
      'role',
      'group_ids',
      'start_tz',
      'end_tz',
      'all_day',
      'status',
      'response_status',
      'recurrence',
      'recurring_event_id',
      'original_start',
      'local_dirty',
      'updated_at',
      'deleted_at',
    ]) {
      expect(cols.has(c), `events.${c}`).toBe(true);
    }
  });

  it('creates event_attendees with the expected columns', async () => {
    const cols = await columnsOf('event_attendees');
    expect(cols.size).toBeGreaterThan(0);
    for (const c of [
      'id',
      'ical_uid',
      'user_id',
      'email',
      'display_name',
      'role',
      'response_status',
      'is_organizer',
      'solo',
      'dish',
      'notes',
      'updated_at',
    ]) {
      expect(cols.has(c), `event_attendees.${c}`).toBe(true);
    }
  });

  it('adds the target-calendar selection columns', async () => {
    expect((await columnsOf('groups')).has('default_calendar_id')).toBe(true);
    const users = await columnsOf('users');
    expect(users.has('default_calendar_id')).toBe(true);
    expect(users.has('default_invite_calendar_id')).toBe(true);
    expect((await columnsOf('calendar_sources')).has('is_default_write')).toBe(true);
  });

  it('creates the group_ids GIN index', async () => {
    const res = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'events'
    `.execute(db);
    expect(res.rows.map((r) => r.indexname)).toContain('idx_events_group_ids');
  });
});

describe('migration 005 — backfill', () => {
  it('backfills identity / ownership / group_ids / all_day on events', async () => {
    const owner = await createUser(db, 'owner');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: owner });

    // Legacy-shaped rows: omit every ADR 0040 column so they take the
    // ADD-COLUMN defaults (group_ids '[]', ical_uid/owner NULL, all_day 0).
    await db
      .insertInto('events')
      .values([
        {
          id: 'e_native',
          group_id: group.id,
          title: 'Picnic',
          starts_at: '2026-07-04T12:00:00-04:00',
          created_at: '2026-06-01T09:00:00.000Z',
          created_by: owner,
        },
        {
          id: 'e_gcal',
          group_id: group.id,
          title: 'Synced',
          starts_at: '2026-07-05T15:00:00-04:00',
          created_at: '2026-06-01T09:00:00.000Z',
          created_by: owner,
          external_uid: 'gcal:abc123',
        },
        {
          id: 'e_allday',
          group_id: group.id,
          title: 'Holiday',
          // Floating-midnight convention the read pipeline uses for all-day.
          starts_at: '2026-07-01T00:00:00',
          created_at: '2026-06-01T09:00:00.000Z',
          created_by: owner,
        },
      ])
      .execute();

    await backfillCalendarTwoWaySync(db);

    const native = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', 'e_native')
      .executeTakeFirstOrThrow();
    expect(native.ical_uid).toBe('e_native'); // no external id -> row id
    expect(native.chord_uid).toBe('e_native'); // Chord-authored -> stamped
    expect(native.owner_user_id).toBe(owner);
    expect(native.organizer_user_id).toBe(owner);
    expect(native.group_ids).toEqual([group.id]); // jsonb -> string[]
    expect(native.updated_at).toBe('2026-06-01T09:00:00.000Z'); // <- created_at
    expect(native.all_day).toBe(0);

    const gcal = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', 'e_gcal')
      .executeTakeFirstOrThrow();
    expect(gcal.ical_uid).toBe('gcal:abc123'); // external_uid wins
    expect(gcal.chord_uid).toBeNull(); // foreign-origin -> no stamp
    expect(gcal.group_ids).toEqual([group.id]);

    const allday = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', 'e_allday')
      .executeTakeFirstOrThrow();
    expect(allday.all_day).toBe(1);
  });

  it('backfills event_attendees from rsvps with the RFC5545 mapping', async () => {
    const owner = await createUser(db, 'owner2');
    const friend = await createUser(db, 'friend2');
    await db.updateTable('users').set({ email: 'org@x.com' }).where('id', '=', owner).execute();
    const group = await createGroup(db, { name: 'Fam2', kind: 'group', createdBy: owner });

    await db
      .insertInto('events')
      .values({
        id: 'e_party',
        group_id: group.id,
        title: 'Potluck',
        starts_at: '2026-07-04T18:00:00-04:00',
        created_at: '2026-06-01T09:00:00.000Z',
        created_by: owner,
      })
      .execute();

    await db
      .insertInto('rsvps')
      .values([
        { id: 'r_org', event_id: 'e_party', user_id: owner, display_name: 'Org', status: 'yes', solo: 0, updated_at: '2026-06-02T00:00:00.000Z' },
        { id: 'r_spouse', event_id: 'e_party', user_id: null, display_name: 'Spouse', status: 'maybe', solo: 1, dish: 'Dal makhani', notes: 'for 8', updated_at: '2026-06-02T00:00:00.000Z' },
        { id: 'r_friend', event_id: 'e_party', user_id: friend, display_name: 'Friend', status: 'no', solo: 0, updated_at: '2026-06-02T00:00:00.000Z' },
      ])
      .execute();

    await backfillCalendarTwoWaySync(db);

    const org = await db
      .selectFrom('event_attendees')
      .selectAll()
      .where('id', '=', 'ea_r_org') // id reuses the rsvp id with an ea_ prefix
      .executeTakeFirstOrThrow();
    expect(org.ical_uid).toBe('e_party');
    expect(org.response_status).toBe('accepted'); // yes -> accepted
    expect(org.is_organizer).toBe(1); // user matches event creator
    expect(org.email).toBe('org@x.com'); // pulled from users
    expect(org.role).toBe('editor');

    const spouse = await db
      .selectFrom('event_attendees')
      .selectAll()
      .where('id', '=', 'ea_r_spouse')
      .executeTakeFirstOrThrow();
    expect(spouse.response_status).toBe('tentative'); // maybe -> tentative
    expect(spouse.is_organizer).toBe(0);
    expect(spouse.email).toBeNull();
    expect(spouse.solo).toBe(1);
    expect(spouse.dish).toBe('Dal makhani'); // potluck extras carried over
    expect(spouse.notes).toBe('for 8');

    const fr = await db
      .selectFrom('event_attendees')
      .selectAll()
      .where('id', '=', 'ea_r_friend')
      .executeTakeFirstOrThrow();
    expect(fr.response_status).toBe('declined'); // no -> declined
    expect(fr.is_organizer).toBe(0);
  });

  it('is idempotent — a second run changes nothing', async () => {
    const owner = await createUser(db, 'owner3');
    const group = await createGroup(db, { name: 'Fam3', kind: 'group', createdBy: owner });
    await db
      .insertInto('events')
      .values({
        id: 'e_idem',
        group_id: group.id,
        title: 'Once',
        starts_at: '2026-07-04T18:00:00-04:00',
        created_at: '2026-06-01T09:00:00.000Z',
        created_by: owner,
      })
      .execute();
    await db
      .insertInto('rsvps')
      .values({ id: 'r_idem', event_id: 'e_idem', user_id: owner, display_name: 'Org', status: 'yes', solo: 0, updated_at: '2026-06-02T00:00:00.000Z' })
      .execute();

    await backfillCalendarTwoWaySync(db);
    await backfillCalendarTwoWaySync(db); // must not throw or duplicate

    const attendees = await db
      .selectFrom('event_attendees')
      .selectAll()
      .where('ical_uid', '=', 'e_idem')
      .execute();
    expect(attendees).toHaveLength(1);

    const ev = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', 'e_idem')
      .executeTakeFirstOrThrow();
    expect(ev.group_ids).toEqual([group.id]); // not double-appended
    expect(ev.ical_uid).toBe('e_idem');
  });
});
