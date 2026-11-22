/**
 * ADR 0040 contract phase (safe subset) — hardenCalendarIdentity: dedups the
 * Google link and enforces a partial UNIQUE(google_calendar_id, gcal_event_id).
 * Rows with no Google link stay unconstrained. Real DB; the migrated template
 * already has the index, so the dedup case drops it first to recreate a
 * pre-constraint state.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { hardenCalendarIdentity, scopeGcalIdentityPerOwner } from '@/db/migrate.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('hardenCalendarIdentity (ADR 0040 contract phase)', () => {
  let db: Kysely<DB>;
  let uid: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    groupId = g.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  function eventRow(over: Record<string, unknown>) {
    return {
      id: 'x',
      group_id: groupId,
      title: 'X',
      starts_at: '2026-06-10T10:00:00Z',
      created_by: uid,
      created_at: '2026-06-01T00:00:00Z',
      owner_user_id: uid,
      organizer_user_id: uid,
      role: 'organizer' as const,
      ical_uid: 'uid-x',
      group_ids: JSON.stringify([groupId]),
      status: 'confirmed' as const,
      all_day: 0,
      sequence: 0,
      transparency: 'opaque' as const,
      local_dirty: 0,
      updated_at: '2026-06-01T00:00:00Z',
      ...over,
    };
  }

  it('dedups colliding Google links and then enforces uniqueness', async () => {
    // Recreate a pre-constraint state so the duplicates can be seeded.
    await sql`DROP INDEX IF EXISTS uq_events_gcal_event`.execute(db);
    await sql`DROP INDEX IF EXISTS uq_events_owner_gcal_event`.execute(db);
    for (const id of ['e1', 'e2']) {
      await db
        .insertInto('events')
        .values(eventRow({ id, ical_uid: `uid-${id}`, google_calendar_id: 'cal-1', gcal_event_id: 'gev-1' }))
        .execute();
    }

    await hardenCalendarIdentity(db);

    const rows = await db.selectFrom('events').select(['id']).where('gcal_event_id', '=', 'gev-1').execute();
    expect(rows).toHaveLength(1);

    // A fresh colliding insert is now rejected by the index.
    await expect(
      db
        .insertInto('events')
        .values(eventRow({ id: 'e3', ical_uid: 'uid-e3', google_calendar_id: 'cal-1', gcal_event_id: 'gev-1' }))
        .execute(),
    ).rejects.toThrow();
  });

  it('leaves rows without a Google link unconstrained', async () => {
    await db.insertInto('events').values(eventRow({ id: 'n1', ical_uid: 'uid-n1' })).execute();
    await db.insertInto('events').values(eventRow({ id: 'n2', ical_uid: 'uid-n2' })).execute();
    // Both have null google_calendar_id/gcal_event_id → not in the partial index.
    const rows = await db.selectFrom('events').select(['id']).orderBy('id').execute();
    expect(rows.map((r) => r.id)).toEqual(['n1', 'n2']);
  });

  it('is idempotent', async () => {
    await hardenCalendarIdentity(db);
    await hardenCalendarIdentity(db);
    // Still usable: a linked row inserts, a duplicate is rejected.
    await db
      .insertInto('events')
      .values(eventRow({ id: 'k1', ical_uid: 'uid-k1', google_calendar_id: 'cal-9', gcal_event_id: 'gev-9' }))
      .execute();
    await expect(
      db
        .insertInto('events')
        .values(eventRow({ id: 'k2', ical_uid: 'uid-k2', google_calendar_id: 'cal-9', gcal_event_id: 'gev-9' }))
        .execute(),
    ).rejects.toThrow();
  });

  describe('scopeGcalIdentityPerOwner (ADR 0200)', () => {
    const HOLIDAYS = 'en.usa#holiday@group.v.calendar.google.com';
    const CHRISTMAS = '20261225_q1cjdk9utc6u8gie59mrlsh778';

    it('lets two owners hold the same Google event, still one per owner', async () => {
      // The pre-0200 state: the global index is back in force.
      await sql`DROP INDEX IF EXISTS uq_events_owner_gcal_event`.execute(db);
      await hardenCalendarIdentity(db);
      const bob = await createUser(db, 'bob');
      await db
        .insertInto('events')
        .values(eventRow({ id: 'a1', google_calendar_id: HOLIDAYS, gcal_event_id: CHRISTMAS }))
        .execute();
      const bobsCopy = eventRow({
        id: 'b1',
        owner_user_id: bob,
        google_calendar_id: HOLIDAYS,
        gcal_event_id: CHRISTMAS,
      });
      await expect(db.insertInto('events').values(bobsCopy).execute()).rejects.toThrow();

      await scopeGcalIdentityPerOwner(db);
      await scopeGcalIdentityPerOwner(db);

      await db.insertInto('events').values(bobsCopy).execute();
      await expect(
        db
          .insertInto('events')
          .values({ ...bobsCopy, id: 'b2', ical_uid: 'uid-b2' })
          .execute(),
      ).rejects.toThrow();
    });

    it('clears the cursor only on calendars more than one user subscribes to', async () => {
      const bob = await createUser(db, 'bob');
      for (const [u, cal] of [
        [uid, HOLIDAYS],
        [bob, HOLIDAYS],
        [uid, 'alice-only@x'],
      ] as const) {
        await upsertCalendarSource(db, u, {
          googleCalendarId: cal,
          summary: cal,
          accessRole: 'reader',
          isPrimary: false,
          selectedInGoogle: true,
          isChordTarget: false,
        });
      }
      await db.updateTable('calendar_sources').set({ sync_token: 'tok' }).execute();

      await scopeGcalIdentityPerOwner(db);

      const rows = await db
        .selectFrom('calendar_sources')
        .select(['user_id', 'google_calendar_id', 'sync_token'])
        .execute();
      const tok = (u: string, c: string) =>
        rows.find((r) => r.user_id === u && r.google_calendar_id === c)!.sync_token;
      expect(tok(uid, HOLIDAYS)).toBeNull();
      expect(tok(bob, HOLIDAYS)).toBeNull();
      expect(tok(uid, 'alice-only@x')).toBe('tok');
    });
  });
});
