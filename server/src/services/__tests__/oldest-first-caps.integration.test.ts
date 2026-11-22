/**
 * Reads that took the OLDEST N rows ever and silently dropped the rest.
 * Prod, 2026-09-25: ownertest@gmail.com had 1,669 live events going back to
 * 2021, and listEventsForUser (oldest first, LIMIT 500) returned only 2021 -
 * the calendar screen, morning briefing and proactive scan never saw today.
 * The same shape was in the group's bot context, list items, task lists and
 * title matching; and text-sorted times put legs across the date line out of
 * order.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import {
  createEvent,
  findEventsByTitle,
  listEvents,
  listEventsForUser,
  liveEventIdsForUser,
  deleteEvent,
} from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { addItem, createList, listLists } from '@/services/lists.service.js';
import { createTask, listTasks } from '@/services/tasks.service.js';
import { addTravelLeg, createTrip, getTripStatus } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

/** A fetched row minus its generated columns, ready to re-insert. */
function withoutGenerated<T extends object>(row: T): T {
  const { search_tsv: _drop, ...rest } = row as T & { search_tsv?: unknown };
  return rest as T;
}

function inOffset(ms: number, offsetHours: number): string {
  const sign = offsetHours < 0 ? '-' : '+';
  const hh = String(Math.abs(offsetHours)).padStart(2, '0');
  return new Date(ms + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, `${sign}${hh}:00`);
}

/** Clone `eventId` `n` times, one per day from `startDay` (floating all-day, as a 2021 Google sync stores them). */
async function cloneEvents(db: Kysely<DB>, eventId: string, n: number, startDay: string, prefix: string) {
  await sql`
    INSERT INTO events
    SELECT (jsonb_populate_record(null::events, to_jsonb(e) || jsonb_build_object(
      'id', ${prefix} || g,
      'ical_uid', ${prefix} || g,
      'starts_at', to_char(${startDay}::date + g, 'YYYY-MM-DD') || 'T00:00:00',
      'ends_at', null
    ))).*
    FROM events e, generate_series(1, ${n}) g
    WHERE e.id = ${eventId}
  `.execute(db);
}

describe('reads that kept the oldest N', () => {
  let db: Kysely<DB>;
  let uid: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'john');
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('listEventsForUser returns today, not the first 500 since 2021', async () => {
    const seed = await createEvent(db, { groupId, createdBy: uid, title: 'Old sync', startsAt: '2021-04-14T00:00:00' });
    await cloneEvents(db, seed.id, 600, '2021-04-14', 'e_old_');
    await createEvent(db, { groupId, createdBy: uid, title: 'Dentist today', startsAt: new Date(Date.now() + 3_600_000).toISOString() });

    const titles = (await listEventsForUser(db, uid)).map((e) => e.title);
    expect(titles).toContain('Dentist today');
    expect(titles).not.toContain('Old sync');

    const group = (await listEvents(db, groupId)).map((e) => e.title);
    expect(group).toContain('Dentist today');
  });

  it('keeps an all-day event under way, and the calendar can look two years ahead', async () => {
    await createEvent(db, {
      groupId, createdBy: uid, title: 'Grandma visiting',
      startsAt: new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10) + 'T00:00:00',
      endsAt: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) + 'T00:00:00',
    });
    await createEvent(db, { groupId, createdBy: uid, title: 'Far off', startsAt: new Date(Date.now() + 700 * DAY).toISOString() });

    expect((await listEventsForUser(db, uid)).map((e) => e.title)).toEqual(['Grandma visiting']);
    const calendar = await listEventsForUser(db, uid, { pastDays: 45, futureDays: 730 });
    expect(calendar.map((e) => e.title)).toEqual(['Grandma visiting', 'Far off']);
  });

  it('keeps an event at the far edge whose stored date is a day later than its instant', async () => {
    // +14:00 puts the written date up to a day after the UTC one; the
    // index-usable text bound beside the instant test must not drop it.
    await createEvent(db, {
      groupId, createdBy: uid, title: 'Edge in Kiritimati',
      startsAt: inOffset(Date.now() + 30 * DAY - 3_600_000, 14),
    });
    await createEvent(db, { groupId, createdBy: uid, title: 'Past the window', startsAt: new Date(Date.now() + 32 * DAY).toISOString() });
    expect((await listEventsForUser(db, uid)).map((e) => e.title)).toEqual(['Edge in Kiritimati']);
    expect((await listEvents(db, groupId)).map((e) => e.title)).toEqual(['Edge in Kiritimati']);
  });

  it('orders a day of mixed-format times by the real time', async () => {
    const base = Date.now() + 2 * DAY;
    // Stored in UTC, one hour after base. Stored with -04:00, two hours after
    // base - later in real time, but its wall clock reads four hours earlier,
    // so as text it sorts first.
    await createEvent(db, { groupId, createdBy: uid, title: 'First (UTC)', startsAt: new Date(base + 3_600_000).toISOString() });
    await createEvent(db, { groupId, createdBy: uid, title: 'Second (offset)', startsAt: inOffset(base + 2 * 3_600_000, -4) });

    expect((await listEventsForUser(db, uid)).map((e) => e.title)).toEqual(['First (UTC)', 'Second (offset)']);
  });

  it('live-id lookup ignores the date window but not a delete', async () => {
    const far = await createEvent(db, { groupId, createdBy: uid, title: 'Far', startsAt: new Date(Date.now() + 400 * DAY).toISOString() });
    const gone = await createEvent(db, { groupId, createdBy: uid, title: 'Gone', startsAt: new Date(Date.now() + DAY).toISOString() });
    await deleteEvent(db, gone.id);

    expect(await liveEventIdsForUser(db, uid, [far.id, gone.id])).toEqual([far.id]);
  });

  it('title matching offers the upcoming "Soccer practice", not the 50 oldest', async () => {
    const seed = await createEvent(db, { groupId, createdBy: uid, title: 'Soccer practice', startsAt: '2021-01-01T00:00:00' });
    await cloneEvents(db, seed.id, 250, '2021-01-01', 'e_soccer_');
    const next = await createEvent(db, { groupId, createdBy: uid, title: 'Soccer practice', startsAt: new Date(Date.now() + 2 * DAY).toISOString() });

    const ids = (await findEventsByTitle(db, { groupId }, 'soccer')).map((e) => e.id);
    expect(ids).toContain(next.id);
  });

  it('record_rsvp with no event picks the one coming up, not next year’s', async () => {
    const soon = await createEvent(db, { groupId, createdBy: uid, title: 'Potluck', startsAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await createEvent(db, { groupId, createdBy: uid, title: 'Birthday 2027', startsAt: new Date(Date.now() + 300 * DAY).toISOString() });

    await applyToolCall(db, {
      groupId, actorUserId: uid, provenance: null,
      call: { name: 'record_rsvp', args: { displayName: 'john', status: 'yes' } },
    });
    const rsvp = await db.selectFrom('rsvps').select('event_id').executeTakeFirstOrThrow();
    expect(rsvp.event_id).toBe(soon.id);
  });

  it('an open task is not pushed out by 200 newer finished ones', async () => {
    const open = await createTask(db, { groupId, createdBy: uid, title: 'Renew passport' });
    const done = await createTask(db, { groupId, createdBy: uid, title: 'done' });
    await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', done.id).execute();
    const doneRow = await db.selectFrom('tasks').selectAll().where('id', '=', done.id).executeTakeFirstOrThrow();
    await db
      .insertInto('tasks')
      .values(
        Array.from({ length: 210 }, (_, g) => ({
          ...withoutGenerated(doneRow),
          id: `t_done_${g}`,
          created_at: new Date(Date.now() + (g + 1) * 1000).toISOString(),
        })),
      )
      .execute();

    expect((await listTasks(db, groupId)).map((t) => t.id)).toContain(open.id);
  });

  it('a long-used list still shows what was just added', async () => {
    const list = await createList(db, { groupId, createdBy: uid, name: 'Groceries' });
    const old = await addItem(db, list.id, 'old milk');
    await db.updateTable('list_items').set({ checked: 1 }).where('id', '=', old.item.id).execute();
    const oldRow = await db.selectFrom('list_items').selectAll().where('id', '=', old.item.id).executeTakeFirstOrThrow();
    await db
      .insertInto('list_items')
      .values(
        Array.from({ length: 5000 }, (_, g) => ({
          ...withoutGenerated(oldRow),
          id: `li_old_${g}`,
          text: `old ${g}`,
          created_at: new Date(Date.now() - 400 * DAY + g * 1000).toISOString(),
        })),
      )
      .execute();
    await addItem(db, list.id, 'eggs');

    const items = (await listLists(db, groupId))[0]!.items.map((i) => i.text);
    expect(items).toContain('eggs');
    expect(items.at(-1)).toBe('eggs');
  });

  it('legs across the date line connect in real-time order (no false gap)', async () => {
    const trip = await createTrip(db, {
      groupId, createdBy: uid, name: 'Tokyo home', destination: 'Los Angeles',
      startDate: '2027-03-10', endDate: '2027-03-10', participantIds: [],
    });
    // NRT 21:00 +09:00 (12:00Z) → HNL; HNL 11:00 -10:00 (21:00Z) → LAX, same date.
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'NRT', destination: 'HNL', passengerName: 'John',
      departAt: '2027-03-10T21:00:00+09:00', arriveAt: '2027-03-10T09:00:00-10:00',
    });
    await addTravelLeg(db, {
      tripId: trip.id, mode: 'flight', origin: 'HNL', destination: 'LAX', passengerName: 'John',
      departAt: '2027-03-10T11:00:00-10:00', arriveAt: '2027-03-10T19:00:00-07:00',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legGaps).toEqual([]);
    expect(status!.legs.map((l) => l.origin)).toEqual(['NRT', 'HNL']);
  });
});
