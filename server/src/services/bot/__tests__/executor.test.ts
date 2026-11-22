import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { addItem, createList, setItemChecked } from '@/services/lists.service.js';
import { addTravelLeg, createTrip, getTripStatus } from '@/services/trips.service.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seed(db: Kysely<DB>): Promise<{ userId: string; groupId: string }> {
  const userId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({ id: userId, username: 'alice', display_name: 'Alice', created_at: now, shadow: 0 })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Fam',
      kind: 'group',
      invite_code: 'X0001',
      ingest_email: 'fam-x@chord.app',
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();
  return { userId, groupId };
}

describe('applyToolCall', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    ({ userId, groupId } = await seed(db));
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('creates a task attributed to the actor with provenance stored', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: '[12:00] Alice: remind me to buy milk\n[12:01] Bob: +1',
      call: { name: 'create_task', args: { title: 'Buy milk' } },
    });
    expect(result.summary).toMatch(/task .* "Buy milk"/);

    const row = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(row.title).toBe('Buy milk');
    expect(row.created_by).toBe(userId);
    expect(row.source_raw_context).toContain('buy milk');
  });

  it('creates a trip with provenance and actor', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: 'flight confirmation PDF p.1',
      call: {
        name: 'create_trip',
        args: {
          name: 'Rome 2026',
          destination: 'Rome',
          startDate: '2026-05-01',
          endDate: '2026-05-08',
          participantNames: [],
        },
      },
    });
    expect(result.summary).toMatch(/trip .* "Rome 2026"/);

    const row = await db
      .selectFrom('trips')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBe(userId);
    expect(row.source_raw_context).toBe('flight confirmation PDF p.1');
  });

  describe('merge_trips', () => {
    it('combines two trips by tripId — the chat equivalent of the drag-to-combine gesture', async () => {
      const keep = await createTrip(db, {
        groupId, createdBy: userId, name: 'Trip to Vail', destination: 'Vail',
        startDate: '2027-02-11', endDate: '2027-02-13', participantIds: [],
      });
      const fromTrip = await createTrip(db, {
        groupId, createdBy: userId, name: 'Vail - LGA', destination: 'Vail',
        startDate: '2027-02-13', endDate: '2027-02-15', participantIds: [],
      });
      await addTravelLeg(db, {
        tripId: fromTrip.id, mode: 'flight', origin: 'DEN', destination: 'LGA',
        departAt: '2027-02-15T14:00:00-07:00', arriveAt: '2027-02-15T20:00:00-05:00',
      });

      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'merge_trips', args: { intoTripId: keep.id, fromTripId: fromTrip.id } },
      });

      expect(result.summary).toMatch(/combined into "Trip to Vail"/);
      expect((result.data as { merged: boolean }).merged).toBe(true);

      const kept = await getTripStatus(db, keep.id);
      expect(kept!.legs).toHaveLength(1);
      const merged = await getTripStatus(db, fromTrip.id);
      expect(merged!.trip.deletedAt).toBeTruthy();
    });

    it('resolves both trips by name/destination query, same as get_trip_status', async () => {
      const keep = await createTrip(db, {
        groupId, createdBy: userId, name: 'Trip to Tokyo', destination: 'Tokyo',
        startDate: '2027-03-01', endDate: '2027-03-04', participantIds: [],
      });
      const fromTrip = await createTrip(db, {
        groupId, createdBy: userId, name: 'Tokyo return flight', destination: 'Tokyo',
        startDate: '2027-03-04', endDate: '2027-03-06', participantIds: [],
      });

      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: {
          name: 'merge_trips',
          args: { intoTripQuery: 'Trip to Tokyo', fromTripQuery: 'return flight' },
        },
      });

      expect((result.data as { merged: boolean; tripId: string }).merged).toBe(true);
      expect((result.data as { tripId: string }).tripId).toBe(keep.id);
      const merged = await getTripStatus(db, fromTrip.id);
      expect(merged!.trip.deletedAt).toBeTruthy();
    });

    it('asks rather than guessing when a query matches several trips', async () => {
      const keep = await createTrip(db, {
        groupId, createdBy: userId, name: 'Trip to Vail', destination: 'Vail',
        startDate: '2027-02-11', endDate: '2027-02-13', participantIds: [],
      });
      await createTrip(db, {
        groupId, createdBy: userId, name: 'Vail - LGA', destination: 'Vail',
        startDate: '2027-02-13', endDate: '2027-02-15', participantIds: [],
      });
      await createTrip(db, {
        groupId, createdBy: userId, name: 'Vail with the Chens', destination: 'Vail',
        startDate: '2027-02-20', endDate: '2027-02-22', participantIds: [],
      });

      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'merge_trips', args: { intoTripId: keep.id, fromTripQuery: 'Vail' } },
      });

      const data = result.data as { merged: boolean; candidates?: unknown[] };
      expect(data.merged).toBe(false);
      expect(data.candidates?.length).toBeGreaterThan(1);
    });
  });

  describe('rename_group', () => {
    it('renames the current group and broadcasts groupRenamed', async () => {
      const emitted: Array<{ ev: string; data: unknown }> = [];
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'rename_group', args: { name: '  Family Squad  ' } },
        emit: (_ch, ev, data) => emitted.push({ ev, data }),
      });
      expect(result.summary).toMatch(/rename_group.*"Family Squad"/);
      const row = await db
        .selectFrom('groups')
        .select('name')
        .where('id', '=', groupId)
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('Family Squad');
      expect(emitted.some((e) => e.ev === 'group.renamed')).toBe(true);
    });

    it('refuses to rename a personal group', async () => {
      const personalGroupId = newId('g');
      const now = new Date().toISOString();
      await db
        .insertInto('groups')
        .values({
          id: personalGroupId,
          name: 'Personal',
          kind: 'personal',
          invite_code: 'P0001',
          ingest_email: 'p-x@chord.app',
          created_by: userId,
          adults_only: 0,
          mirror_inbound: 0,
          created_at: now,
        })
        .execute();
      await db
        .insertInto('group_members')
        .values({
          group_id: personalGroupId,
          user_id: userId,
          role: 'owner',
          tier: 'verified',
          joined_at: now,
        })
        .execute();

      const result = await applyToolCall(db, {
        groupId: personalGroupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'rename_group', args: { name: 'My Stuff' } },
      });
      expect(result.summary).toMatch(/nothing to rename/);
      const row = await db
        .selectFrom('groups')
        .select('name')
        .where('id', '=', personalGroupId)
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('Personal');
    });
  });

  describe('rename_list', () => {
    it('renames an existing list matched case-insensitively', async () => {
      const list = await createList(db, { groupId, name: 'Costco', createdBy: userId });
      const emitted: Array<{ ev: string; data: unknown }> = [];
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'rename_list', args: { currentName: 'costco', newName: 'Whole Foods' } },
        emit: (_ch, ev, data) => emitted.push({ ev, data }),
      });
      expect(result.summary).toMatch(/Costco.*Whole Foods/);
      const row = await db
        .selectFrom('lists')
        .select('name')
        .where('id', '=', list.id)
        .executeTakeFirstOrThrow();
      expect(row.name).toBe('Whole Foods');
      expect(emitted.some((e) => e.ev === 'list.updated')).toBe(true);
    });

    it('returns not_found when no list in the group matches', async () => {
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'rename_list', args: { currentName: 'Mystery', newName: 'Whatever' } },
      });
      expect(result.summary).toMatch(/no list named/);
      expect((result.data as { reason: string }).reason).toBe('not_found');
    });
  });

  describe('complete_task', () => {
    async function createOpenTask(title: string): Promise<string> {
      const id = newId('t');
      await db
        .insertInto('tasks')
        .values({
          id,
          group_id: groupId,
          title,
          status: 'open',
          created_by: userId,
          created_at: new Date().toISOString(),
        })
        .execute();
      return id;
    }

    it('marks a task done when matched by id', async () => {
      const id = await createOpenTask('Pick up Sam');
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'complete_task', args: { taskId: id } },
      });
      expect(result.summary).toMatch(/→ done/);
      const row = await db
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('done');
    });

    it('resolves by titleContains when unique', async () => {
      const id = await createOpenTask('Call the dentist');
      await createOpenTask('Buy milk');
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'complete_task', args: { titleContains: 'dentist' } },
      });
      expect(result.summary).toMatch(/→ done/);
      const row = await db
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('done');
    });

    it('returns candidates without writing when title is ambiguous', async () => {
      const a = await createOpenTask('Call dentist for Sam');
      const b = await createOpenTask('Call dentist for Eli');
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'complete_task', args: { titleContains: 'dentist' } },
      });
      expect(result.summary).toMatch(/candidates/);
      const rows = await db
        .selectFrom('tasks')
        .select(['id', 'status'])
        .where('id', 'in', [a, b])
        .execute();
      for (const r of rows) expect(r.status).toBe('open');
    });

    it('reopens a done task when reopen=true', async () => {
      const id = await createOpenTask('Buy milk');
      await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', id).execute();
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'complete_task', args: { taskId: id, reopen: true } },
      });
      expect(result.summary).toMatch(/→ open/);
      const row = await db
        .selectFrom('tasks')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe('open');
    });
  });

  it('leaves created_by null and source_raw_context null when actor + provenance are null', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: null,
      provenance: null,
      call: {
        name: 'save_link',
        args: { title: 'Expedia', url: 'https://expedia.com' },
      },
    });
    const row = await db
      .selectFrom('saves')
      .selectAll()
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(row.created_by).toBeNull();
    expect(row.source_raw_context).toBeNull();
  });

  async function makeEvent(title: string, startsAt: string): Promise<string> {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        title,
        starts_at: startsAt,
        created_by: userId,
        created_at: new Date().toISOString(),
      })
      .execute();
    return id;
  }

  it('delete_event removes the event by id', async () => {
    const id = await makeEvent('Take train on 86th Street', '2026-05-22T17:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'delete_event', args: { eventId: id } },
    });
    expect(result.summary).toMatch(/removed "Take train on 86th Street"/);
    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('delete_event resolves by title when no id is given', async () => {
    const id = await makeEvent('Dentist', '2026-05-22T09:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'delete_event', args: { titleContains: 'dentist' } },
    });
    expect((result.data as { deleted: boolean }).deleted).toBe(true);
    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('delete_event does not delete when the title match is ambiguous', async () => {
    await makeEvent('Train', '2026-05-22T17:00:00-04:00');
    await makeEvent('Train', '2026-05-23T17:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'delete_event', args: { titleContains: 'train' } },
    });
    const data = result.data as { deleted: boolean; candidates?: unknown[] };
    expect(data.deleted).toBe(false);
    expect(data.candidates).toHaveLength(2);
    const remaining = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(remaining).toHaveLength(2);
  });

  // Prod, Sunday 2026-09-27: "what's on Monday" came back as "Monday,
  // September 29" with "US Assembly at 9:15 AM UTC" listed after a 9:00 AM
  // event and before a 6:00 AM flight. The tool handed the model raw stored
  // strings; it now hands each event its local time with the weekday.
  it('find_events gives each event its local time and weekday, in start order', async () => {
    const values = (id: string, title: string, startsAt: string) => ({
      id,
      group_id: groupId,
      title,
      starts_at: startsAt,
      owner_user_id: userId,
      created_by: userId,
      created_at: new Date().toISOString(),
    });
    await db
      .insertInto('events')
      .values([
        values(newId('e'), 'US Assembly', '2026-09-28T13:15:00Z'),
        values(newId('e'), 'Kapoor Birthday', '2026-09-28T09:00:00-04:00'),
        values(newId('e'), 'Flight to Los Angeles (UA 2434)', '2026-09-28T06:00:00-04:00'),
        values(newId('e'), 'Soccer - 7th Grade Game', '2026-09-28T19:30:00'),
      ])
      .execute();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      tz: 'America/New_York',
      call: { name: 'find_events', args: { startDate: '2026-09-28', endDate: '2026-09-28' } },
    });
    expect(result.summary).toContain('Monday 2026-09-28');
    const events = (result.data as { events: { title: string; when: string }[] }).events;
    expect(events.map((e) => [e.title, e.when])).toEqual([
      ['Flight to Los Angeles (UA 2434)', 'Monday 2026-09-28 06:00'],
      ['Kapoor Birthday', 'Monday 2026-09-28 09:00'],
      ['US Assembly', 'Monday 2026-09-28 09:15'],
      ['Soccer - 7th Grade Game', 'Monday 2026-09-28 19:30'],
    ]);
  });

  it('delete_event candidates carry their local time and weekday', async () => {
    await makeEvent('Train', '2026-05-22T21:00:00Z');
    await makeEvent('Train', '2026-05-23T17:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      tz: 'America/New_York',
      call: { name: 'delete_event', args: { titleContains: 'train' } },
    });
    const whens = (result.data as { candidates: { when: string }[] }).candidates.map((c) => c.when);
    expect(whens.sort()).toEqual(['Friday 2026-05-22 17:00', 'Saturday 2026-05-23 17:00']);
  });

  it('delete_event date disambiguates same-titled events', async () => {
    await makeEvent('Train', '2026-05-22T17:00:00-04:00');
    const keep = await makeEvent('Train', '2026-05-23T17:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'delete_event', args: { titleContains: 'train', date: '2026-05-22' } },
    });
    expect((result.data as { deleted: boolean }).deleted).toBe(true);
    const remaining = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(remaining.map((r) => r.id)).toEqual([keep]);
  });

  it('update_event changes duration in place (no duplicate) via durationMinutes', async () => {
    // Regression: a "make it 2.5 hrs" request used to create a NEW event
    // instead of editing the existing one (no update_event tool existed).
    const id = await makeEvent('Giant', '2026-06-25T19:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'update_event', args: { titleContains: 'giant', durationMinutes: 150 } },
    });
    expect((result.data as { updated: boolean }).updated).toBe(true);
    const rows = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    // Still exactly one event — edited, not duplicated.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    // endsAt = start + 150 min = 21:30 -04:00 == 01:30Z next day, and it keeps
    // the SAME offset as startsAt (not collapsed to Z) for display consistency.
    expect(rows[0]!.ends_at).toBe('2026-06-25T21:30:00-04:00');
    expect(new Date(rows[0]!.ends_at!).toISOString()).toBe('2026-06-26T01:30:00.000Z');
    expect(new Date(rows[0]!.starts_at).toISOString()).toBe('2026-06-25T23:00:00.000Z');
  });

  it('update_event can move start + retitle in place', async () => {
    const id = await makeEvent('Dentist', '2026-05-22T09:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'update_event',
        args: { eventId: id, title: 'Dentist (rescheduled)', startsAt: '2026-05-22T10:00:00-04:00' },
      },
    });
    expect((result.data as { updated: boolean }).updated).toBe(true);
    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.title).toBe('Dentist (rescheduled)');
    expect(new Date(row.starts_at).toISOString()).toBe('2026-05-22T14:00:00.000Z');
  });

  it('update_event does not edit when the title match is ambiguous', async () => {
    await makeEvent('Train', '2026-05-22T17:00:00-04:00');
    await makeEvent('Train', '2026-05-23T17:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'update_event', args: { titleContains: 'train', durationMinutes: 90 } },
    });
    const data = result.data as { updated: boolean; candidates?: unknown[] };
    expect(data.updated).toBe(false);
    expect(data.candidates).toHaveLength(2);
    const rows = await db.selectFrom('events').selectAll().where('group_id', '=', groupId).execute();
    expect(rows.every((r) => r.ends_at === null)).toBe(true);
  });

  it('update_event reports no match instead of creating an event', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'update_event', args: { titleContains: 'nonexistent', durationMinutes: 60 } },
    });
    expect((result.data as { updated: boolean }).updated).toBe(false);
    const rows = await db.selectFrom('events').selectAll().where('group_id', '=', groupId).execute();
    expect(rows).toHaveLength(0);
  });

  // Regression: prod (ownertest@gmail.com) had 1500+ live events in his
  // personal group — years of never-pruned history (ADR 0092 keeps
  // completed/history rows on purpose). update_event/delete_event's title
  // match used to go through `listEvents`/`listEventsForUser`, a bounded
  // ascending-by-starts_at window capped at 500 rows with no lower time
  // bound — so a near-term "Appointment at Lenox Hill Radiology" ranked
  // #640 chronologically among his events never made it into that window,
  // and the bot claimed it couldn't find an appointment that plainly
  // existed. findEventsByTitle (events.service.ts) matches in SQL instead,
  // so it can't be starved by older history no matter how much there is.
  it('update_event finds a title match buried behind 500+ older events', async () => {
    const base = new Date('2020-01-01T09:00:00-04:00').getTime();
    const old = Array.from({ length: 520 }, (_, i) => ({
      id: newId('e'),
      group_id: groupId,
      title: `Old event ${i}`,
      starts_at: new Date(base + i * 86_400_000).toISOString(),
      created_by: userId,
      created_at: new Date().toISOString(),
    }));
    await db.insertInto('events').values(old).execute();
    const targetId = await makeEvent('Appointment at Lenox Hill Radiology', '2026-09-22T11:00:00-04:00');

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'update_event',
        args: { titleContains: 'Lenox Hill Radiology', date: '2026-09-22', location: 'Columbus Circle Imaging' },
      },
    });
    expect((result.data as { updated: boolean }).updated).toBe(true);
    const row = await db.selectFrom('events').selectAll().where('id', '=', targetId).executeTakeFirstOrThrow();
    expect(row.location).toBe('Columbus Circle Imaging');
  });

  // Same root cause as above, for get_event_status's "no eventId given →
  // nearest upcoming event" default: it used to scan listEvents(db, groupId)
  // (oldest 500, no lower time bound) and filter for startsAt >= now in JS —
  // on this account every one of those 500 rows is from 2020, so the
  // "upcoming" filter found nothing and silently fell back to the LATEST OF
  // THE PAST 500, reporting a years-old event as the nearest upcoming one.
  it('get_event_status finds the real nearest-upcoming event behind 500+ older ones', async () => {
    const base = new Date('2020-01-01T09:00:00-04:00').getTime();
    const old = Array.from({ length: 520 }, (_, i) => ({
      id: newId('e'),
      group_id: groupId,
      title: `Old event ${i}`,
      starts_at: new Date(base + i * 86_400_000).toISOString(),
      created_by: userId,
      created_at: new Date().toISOString(),
    }));
    await db.insertInto('events').values(old).execute();
    const upcomingId = await makeEvent('Team Dinner', '2026-09-22T19:00:00-04:00');

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'get_event_status', args: {} },
    });
    const data = result.data as { event: { id: string; title: string } | null };
    expect(data.event?.id).toBe(upcomingId);
    expect(data.event?.title).toBe('Team Dinner');
  });

  // Same root cause, for record_rsvp's "no eventId given → the event"
  // default: it used to take listEvents(db, groupId).at(-1) — the latest of
  // only the oldest 500 rows, not the actual latest event in the group.
  it('record_rsvp resolves to the real latest event behind 500+ older ones', async () => {
    const base = new Date('2020-01-01T09:00:00-04:00').getTime();
    const old = Array.from({ length: 520 }, (_, i) => ({
      id: newId('e'),
      group_id: groupId,
      title: `Old event ${i}`,
      starts_at: new Date(base + i * 86_400_000).toISOString(),
      created_by: userId,
      created_at: new Date().toISOString(),
    }));
    await db.insertInto('events').values(old).execute();
    const latestId = await makeEvent('Game Night', '2026-10-10T20:00:00-04:00');

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'record_rsvp', args: { displayName: 'Alice', status: 'yes' } },
    });
    expect(result.summary).not.toMatch(/no event found/);
    const rsvps = await db.selectFrom('rsvps').selectAll().where('event_id', '=', latestId).execute();
    expect(rsvps).toHaveLength(1);
    expect(rsvps[0]!.status).toBe('yes');
  });

  async function makeLeg(destination: string, departAt: string): Promise<string> {
    const trip = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'T', destination, startDate: departAt.slice(0, 10), endDate: departAt.slice(0, 10) } },
    });
    const tripId = (trip.data as { tripId: string }).tripId;
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'add_travel_leg', args: { tripId, mode: 'flight', origin: 'JFK', destination, departAt, arriveAt: departAt } },
    });
    return tripId;
  }

  it('set_leg_passenger attaches a passenger to a matched leg', async () => {
    await makeLeg('LHR', '2026-06-15T14:30:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_leg_passenger', args: { passengerName: 'Nolan', destination: 'LHR' } },
    });
    expect((result.data as { updated: boolean }).updated).toBe(true);
    const leg = await db.selectFrom('travel_legs').selectAll().where('destination', '=', 'LHR').executeTakeFirstOrThrow();
    // No group member named Nolan → stored as the raw passenger name.
    expect(leg.passenger_name).toBe('Nolan');
  });

  it('set_leg_passenger returns candidates when the match is ambiguous', async () => {
    await makeLeg('LHR', '2026-06-15T14:30:00-04:00');
    await makeLeg('NRT', '2026-07-01T09:00:00-04:00');
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_leg_passenger', args: { passengerName: 'Nolan' } },
    });
    const data = result.data as { updated: boolean; candidates?: unknown[] };
    expect(data.updated).toBe(false);
    expect(data.candidates).toHaveLength(2);
    const named = await db.selectFrom('travel_legs').selectAll().where('passenger_name', 'is not', null).execute();
    expect(named).toHaveLength(0);
  });

  async function makeStay(
    tripName: string,
    propertyName: string,
    checkinDate: string,
    checkoutDate: string,
  ): Promise<string> {
    const trip = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'create_trip',
        args: { name: tripName, destination: tripName, startDate: checkinDate, endDate: checkoutDate },
      },
    });
    const tripId = (trip.data as { tripId: string }).tripId;
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'add_accommodation', args: { tripId, propertyName, checkinDate, checkoutDate } },
    });
    return tripId;
  }

  it('move_leg re-parents a matched leg onto a different, already-existing trip', async () => {
    const sourceTripId = await makeLeg('LHR', '2026-06-15T14:30:00-04:00');
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Onward', destination: 'Onward', startDate: '2026-06-16', endDate: '2026-06-16' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_leg', args: { destination: 'LHR', targetTripId } },
    });
    expect((result.data as { moved: boolean }).moved).toBe(true);

    const leg = await db.selectFrom('travel_legs').selectAll().where('destination', '=', 'LHR').executeTakeFirstOrThrow();
    expect(leg.trip_id).toBe(targetTripId);
    // The source trip had only this one leg, so moving it out folds the
    // source trip away (maybeDeleteEmptyTrip).
    const sourceTrip = await db.selectFrom('trips').selectAll().where('id', '=', sourceTripId).executeTakeFirstOrThrow();
    expect(sourceTrip.deleted_at).toBeTruthy();
  });

  it('move_leg resolves the target trip by name when targetTripId is not given', async () => {
    await makeLeg('LHR', '2026-06-15T14:30:00-04:00');
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Trip to Paris', destination: 'Paris', startDate: '2026-06-16', endDate: '2026-06-18' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_leg', args: { destination: 'LHR', targetTripQuery: 'Paris' } },
    });
    expect((result.data as { moved: boolean; tripId?: string }).moved).toBe(true);
    expect((result.data as { tripId?: string }).tripId).toBe(targetTripId);
  });

  it('move_leg returns candidates when the leg descriptor is ambiguous', async () => {
    await makeLeg('LHR', '2026-06-15T14:30:00-04:00');
    await makeLeg('NRT', '2026-07-01T09:00:00-04:00');
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Onward', destination: 'Onward', startDate: '2026-07-02', endDate: '2026-07-02' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_leg', args: { targetTripId } },
    });
    const data = result.data as { moved: boolean; candidates?: unknown[] };
    expect(data.moved).toBe(false);
    expect(data.candidates).toHaveLength(2);
  });

  it('move_leg reports no match instead of moving anything', async () => {
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Onward', destination: 'Onward', startDate: '2026-07-02', endDate: '2026-07-02' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_leg', args: { destination: 'nonexistent', targetTripId } },
    });
    expect((result.data as { moved: boolean }).moved).toBe(false);
  });

  it('move_accommodation re-parents a matched stay onto a different, already-existing trip', async () => {
    const sourceTripId = await makeStay('Trip to London', 'The Savoy', '2026-06-10', '2026-06-14');
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Trip to Paris', destination: 'Paris', startDate: '2026-06-14', endDate: '2026-06-16' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_accommodation', args: { propertyName: 'Savoy', targetTripId } },
    });
    expect((result.data as { moved: boolean }).moved).toBe(true);

    const stay = await db.selectFrom('accommodations').selectAll().where('property_name', '=', 'The Savoy').executeTakeFirstOrThrow();
    expect(stay.trip_id).toBe(targetTripId);
    const sourceTrip = await db.selectFrom('trips').selectAll().where('id', '=', sourceTripId).executeTakeFirstOrThrow();
    expect(sourceTrip.deleted_at).toBeTruthy();
  });

  it('move_accommodation returns candidates when the stay descriptor is ambiguous', async () => {
    await makeStay('Trip to London', 'The Savoy', '2026-06-10', '2026-06-14');
    await makeStay('Trip to Rome', 'Hotel Eden', '2026-07-01', '2026-07-04');
    const target = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'create_trip', args: { name: 'Onward', destination: 'Onward', startDate: '2026-07-05', endDate: '2026-07-05' } },
    });
    const targetTripId = (target.data as { tripId: string }).tripId;

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'move_accommodation', args: { targetTripId } },
    });
    const data = result.data as { moved: boolean; candidates?: unknown[] };
    expect(data.moved).toBe(false);
    expect(data.candidates).toHaveLength(2);
  });
});

describe('applyToolCall: relay', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let tg: MockConnector;
  let sl: MockConnector;

  beforeEach(async () => {
    db = await openTestDb();
    ({ userId, groupId } = await seed(db));

    // Two bridges on the same Chord group with distinct aliases.
    await bindChannel(db, 'telegram', '-1001', groupId, 'telegram');
    await bindChannel(db, 'slack', 'C_OPS', groupId, 'ops');

    tg = new MockConnector(db, 'telegram');
    sl = new MockConnector(db, 'slack');
    connectorRegistry.register(tg);
    connectorRegistry.register(sl);
  });

  afterEach(async () => {
    for (const c of connectorRegistry.list()) {
      await c.shutdown().catch(() => {});
    }
    await closeTestDb(db);
  });

  it('relays to a single bridge by alias with third-person attribution', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      sourceBinding: { platform: 'telegram', externalChannelId: '-1001', botUserId: null },
      call: { name: 'relay', args: { target: 'ops', text: 'on my way' } },
    });
    expect(result.summary).toMatch(/relay → ops/);
    expect(sl.sent).toHaveLength(1);
    expect(sl.sent[0]).toMatchObject({
      externalChannelId: 'C_OPS',
      text: 'Alice (from telegram) asked me to share: on my way',
    });
    expect(tg.sent).toHaveLength(0);
  });

  it("target='all' fans out to every bridge when no source is set", async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'relay', args: { target: 'all', text: 'heads up' } },
    });
    expect(tg.sent).toHaveLength(1);
    expect(sl.sent).toHaveLength(1);
  });

  it("target='all' excludes the source binding", async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      sourceBinding: { platform: 'telegram', externalChannelId: '-1001', botUserId: null },
      call: { name: 'relay', args: { target: 'all', text: 'fyi' } },
    });
    expect(tg.sent).toHaveLength(0);
    expect(sl.sent).toHaveLength(1);
    expect(sl.sent[0].text).toBe('Alice (from telegram) asked me to share: fyi');
  });

  it("target='chord' posts a bot-authored Chord message and skips bridges", async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      sourceBinding: { platform: 'telegram', externalChannelId: '-1001', botUserId: null },
      call: { name: 'relay', args: { target: 'chord', text: 'lunch at 5' } },
    });
    expect(result.summary).toBe('relay → chord');
    expect(tg.sent).toHaveLength(0);
    expect(sl.sent).toHaveLength(0);
    const rows = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('bot');
    expect(rows[0].body).toBe(
      'Alice (from telegram) asked me to share: lunch at 5',
    );
    expect(rows[0].chord_visible).toBe(1);
  });

  it('reports an error summary listing known aliases when target is unknown', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'relay',
        args: { target: 'discord', text: 'where are you' },
      },
    });
    expect(result.summary).toMatch(/relay: unknown target "discord"/);
    expect(result.summary).toMatch(/telegram/);
    expect(result.summary).toMatch(/ops/);
    expect(tg.sent).toHaveLength(0);
    expect(sl.sent).toHaveLength(0);
  });

  it('falls back to a generic speaker label when actor is null', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: null,
      provenance: null,
      call: { name: 'relay', args: { target: 'telegram', text: 'system note' } },
    });
    expect(tg.sent[0].text).toBe(
      'someone (in Chord) asked me to share: system note',
    );
  });

  it('suggest_external_action returns an action card with the built URL (no DB writes)', async () => {
    // PR-F. The tool is read-only — it produces a tappable card and doesn't
    // persist anything. Confirms the executor wires the URL builder result
    // through to the BotCard shape the mobile renderer expects. ADR 0153: a
    // NAMED restaurant links to its Google Maps place page (whose "Reserve a
    // table" button routes to the restaurant's real booking system).
    const before = await db.selectFrom('tasks').selectAll().execute();
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: {
          kind: 'restaurant',
          label: 'Reserve a table',
          query: { restaurantName: "Joe's Pizza", partySize: 2 },
        },
      },
    });
    expect(result.card?.kind).toBe('action');
    expect(result.card?.title).toBe('Reserve a table');
    expect(result.card?.subtitle).toBe('Google Maps');
    expect(result.card?.url).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?/);
    expect(result.card?.meta).toContain("Joe's Pizza");
    expect(result.summary).toMatch(/external_action restaurant /);

    const after = await db.selectFrom('tasks').selectAll().execute();
    expect(after).toHaveLength(before.length); // no side effects
  });

  it('suggest_external_action for an UNNAMED restaurant opens a Google Maps search (ADR 0153)', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: {
          kind: 'restaurant',
          label: 'Find a table',
          query: { city: 'Brooklyn', partySize: 4 },
        },
      },
    });
    expect(result.card?.subtitle).toBe('Google Maps');
    expect(result.card?.url).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?/);
    expect(new URL(result.card!.url!).searchParams.get('query')).toBe('restaurants in Brooklyn');
  });

  it('suggest_external_action kind=search gives an image search card (ADR 0262)', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: { kind: 'search', label: 'Search images', query: { q: 'boy running', searchType: 'images' } },
      },
    });
    expect(result.card?.subtitle).toBe('Google Images');
    expect(result.card?.url).toBe('https://www.google.com/search?q=boy+running&udm=2');
  });

  it('suggest_external_action kind=search with no terms refuses instead of carding (ADR 0262)', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'suggest_external_action', args: { kind: 'search', label: 'Search', query: {} } },
    });
    expect(result.card).toBeUndefined();
    expect((result.data as { reason?: string }).reason).toBe('no_query');
  });

  it('suggest_external_action with empty query still produces a valid card', async () => {
    const result = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: {
        name: 'suggest_external_action',
        args: { kind: 'flight', label: 'Find flights' },
      },
    });
    expect(result.card?.kind).toBe('action');
    expect(result.card?.url).toMatch(/google\.com\/travel\/flights/);
    expect(result.card?.meta).toBeUndefined();
  });

  describe('get_list', () => {
    async function seedGroceries(): Promise<void> {
      const list = await createList(db, { groupId, name: 'Groceries', createdBy: userId });
      await addItem(db, list.id, 'milk');
      await addItem(db, list.id, 'bread');
      const eggs = await addItem(db, list.id, 'eggs');
      await setItemChecked(db, eggs.item.id, true);
    }

    it('returns a named list\'s full current contents from the DB, by fuzzy name', async () => {
      await seedGroceries();
      // "grocery" is a substring of "Groceries" — fuzzy match resolves it.
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'get_list', args: { listName: 'grocery' } },
      });
      const data = result.data as {
        list: { listName: string; items: { text: string; checked: boolean }[] } | null;
      };
      expect(data.list?.listName).toBe('Groceries');
      expect(data.list?.items.map((i) => i.text)).toEqual(['milk', 'bread', 'eggs']);
      // Checked state comes straight from the DB, not the chat log.
      expect(data.list?.items.find((i) => i.text === 'eggs')?.checked).toBe(true);
      expect(data.list?.items.find((i) => i.text === 'milk')?.checked).toBe(false);
    });

    it('returns candidates (not a guess) when the name is missing', async () => {
      await seedGroceries();
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'get_list', args: { listName: 'pantry' } },
      });
      const data = result.data as { list: null; candidates: string[] };
      expect(data.list).toBeNull();
      expect(data.candidates).toContain('Groceries');
    });

    it('lists every list name + counts when no listName is given', async () => {
      await seedGroceries();
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'get_list', args: {} },
      });
      const data = result.data as {
        lists: { listName: string; itemCount: number; uncheckedCount: number }[];
      };
      const groceries = data.lists.find((l) => l.listName === 'Groceries');
      expect(groceries?.itemCount).toBe(3);
      expect(groceries?.uncheckedCount).toBe(2);
    });

    it('returns candidates when several lists match and none is exact', async () => {
      await createList(db, { groupId, name: 'Costco run', createdBy: userId });
      await createList(db, { groupId, name: 'Costco pharmacy', createdBy: userId });
      const result = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'get_list', args: { listName: 'costco' } },
      });
      const data = result.data as {
        list: null;
        candidates: { listName: string }[];
      };
      expect(data.list).toBeNull();
      expect(data.candidates.map((c) => c.listName).sort()).toEqual([
        'Costco pharmacy',
        'Costco run',
      ]);
    });
  });
});
