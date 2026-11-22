/**
 * ADR 0040 §7 fan-out copies after they reach Google (addendum 2026-10-23).
 *
 * A group event gives every member their own row, linked by one shared
 * `ical_uid`. Three ways that link broke once the copies were pushed:
 *
 * 1. `markPushed` (and the pull of our own event) wrote Google's per-event
 *    iCalUID over `ical_uid`. Each copy is a different Google event, so each
 *    got a different UID: the bot saw the event once per member, an organizer
 *    edit stopped reaching the other copies, and the guest list (keyed on the
 *    shared value) was lost for later pushes.
 * 2. Two members whose default calendar is the same shared Google calendar
 *    each inserted their copy into it: two events on the family calendar.
 * 3. A member subscribed to another member's calendar pulled that member's
 *    copy as a new row beside their own.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { createEvent, deleteEvent, listEvents, updateEvent } from '@/services/events.service.js';
import { deleteSeries } from '@/services/events/series.service.js';
import { createGroup } from '@/services/groups.service.js';
import { googleCalendarTransport } from '@/services/google/calendar-transport.js';
import { pullCalendarChanges, pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface FakeEvent {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
  etag: string;
}

/** A minimal Google Calendar: insert / patch / get / delete, ids per insert. */
function fakeGoogle() {
  const events = new Map<string, FakeEvent>();
  const calls: Array<{ method: string; calendarId: string; eventId?: string }> = [];
  let n = 0;
  const resource = (e: FakeEvent) => ({
    ...e.body,
    id: e.id,
    etag: e.etag,
    iCalUID: `${e.id}@google.com`,
    status: 'confirmed',
    sequence: 0,
    updated: new Date().toISOString(),
  });
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m) return res({});
    const calendarId = decodeURIComponent(m[1]!);
    const eventId = m[2] ? decodeURIComponent(m[2]) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, calendarId, eventId });
    if (method === 'POST') {
      n++;
      const e: FakeEvent = {
        id: `g_${n}`,
        calendarId,
        body: JSON.parse(init!.body as string),
        etag: `"e${n}"`,
      };
      events.set(e.id, e);
      return res(resource(e));
    }
    const e = eventId ? events.get(eventId) : undefined;
    if (method === 'PATCH') {
      if (!e) return res({}, 404);
      e.body = { ...e.body, ...JSON.parse(init!.body as string) };
      e.etag = `${e.etag}+`;
      return res(resource(e));
    }
    if (method === 'DELETE') {
      if (e) events.delete(e.id);
      return res({}, e ? 204 : 404);
    }
    return e ? res(resource(e)) : res({}, 404);
  });
  return { events, calls, fetchMock, resource };
}

const CAL_WRITE = 'https://www.googleapis.com/auth/calendar';
const startsAt = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

describe('fan-out copies keep one identity after they reach Google', () => {
  let db: Kysely<DB>;
  let alice: string;
  let bob: string;
  let groupId: string;
  let google: ReturnType<typeof fakeGoogle>;

  beforeEach(async () => {
    db = await openTestDb();
    alice = await createUser(db, 'alice');
    bob = await createUser(db, 'bob');
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: CAL_WRITE })
      .where('id', 'in', [alice, bob])
      .execute();
    const g = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    groupId = g.id;
    await addMember(db, groupId, bob);
    google = fakeGoogle();
    vi.stubGlobal('fetch', google.fetchMock);
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  async function copies() {
    return db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('deleted_at', 'is', null)
      .orderBy('role', 'desc')
      .execute();
  }

  it('1. pushed copies still share ical_uid: one event for the bot, edits fan out', async () => {
    const ev = await createEvent(db, {
      groupId,
      title: 'Soccer practice',
      startsAt: startsAt(),
      createdBy: alice,
    });
    await settleBackgroundWork();

    const pushed = await copies();
    expect(pushed).toHaveLength(2);
    expect(pushed.every((r) => r.gcal_event_id)).toBe(true);
    // Two different Google events (each in its owner's own primary) ...
    expect(new Set(pushed.map((r) => r.gcal_event_id)).size).toBe(2);
    // ... but still one logical event in Chord.
    expect(new Set(pushed.map((r) => r.ical_uid)).size).toBe(1);
    expect(await listEvents(db, groupId)).toHaveLength(1);

    await updateEvent(db, ev.id, { title: 'Soccer practice (moved to field 2)' });
    await settleBackgroundWork();
    const after = await copies();
    expect(after.map((r) => r.title)).toEqual([
      'Soccer practice (moved to field 2)',
      'Soccer practice (moved to field 2)',
    ]);
  });

  it('1. pulling our own event back does not replace the shared ical_uid', async () => {
    await createEvent(db, { groupId, title: 'Dinner', startsAt: startsAt(), createdBy: alice });
    await settleBackgroundWork();
    const mine = (await copies()).find((r) => r.owner_user_id === alice)!;
    const shared = mine.ical_uid;

    // Alice renames it in Google; her next pull applies it.
    const remote = google.events.get(mine.gcal_event_id!)!;
    remote.body.summary = 'Dinner at Nonna’s';
    const transport = googleCalendarTransport('fake-token');
    await pullCalendarChanges(db, alice, 'primary', undefined, {
      ...transport,
      listChanges: async () => ({
        items: [{ ...google.resource(remote), updated: new Date(Date.now() + 60_000).toISOString() }],
        nextSyncToken: 't1',
        wasFullSync: false,
      }),
    } as typeof transport);

    const row = await db.selectFrom('events').selectAll().where('id', '=', mine.id).executeTakeFirstOrThrow();
    expect(row.title).toBe('Dinner at Nonna’s');
    expect(row.ical_uid).toBe(shared);
  });

  it('2. two members whose default is one shared calendar put ONE event there', async () => {
    const FAMILY = 'family123@group.calendar.google.com';
    await db.updateTable('users').set({ default_calendar_id: FAMILY }).where('id', 'in', [alice, bob]).execute();

    await createEvent(db, {
      groupId,
      title: 'Piano recital',
      startsAt: startsAt(),
      createdBy: alice,
      googleCalendarId: FAMILY,
    });
    await settleBackgroundWork();
    // Whichever push ran first, a second pass settles any copy left waiting.
    await pushDirtyEvents(db, bob);
    await pushDirtyEvents(db, alice);

    const inserts = google.calls.filter((c) => c.method === 'POST' && c.calendarId === FAMILY);
    expect(inserts).toHaveLength(1);
    const rows = await copies();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.gcal_event_id)).size).toBe(1);
    expect(rows.every((r) => r.local_dirty === 0)).toBe(true);
  });

  it('2. the attendee push running first waits, it does not insert a twin', async () => {
    const FAMILY = 'family123@group.calendar.google.com';
    await db.updateTable('users').set({ default_calendar_id: FAMILY }).where('id', 'in', [alice, bob]).execute();
    // Copies written without the fire-and-forget push, so the order is ours.
    await createEvent(db, {
      groupId,
      title: 'Bake sale',
      startsAt: startsAt(),
      createdBy: alice,
      googleCalendarId: FAMILY,
    });
    await settleBackgroundWork();
    google.calls.length = 0;
    google.events.clear();
    await db.updateTable('events').set({ gcal_event_id: null, etag: null, local_dirty: 1 }).execute();

    await pushDirtyEvents(db, bob);
    expect(google.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await pushDirtyEvents(db, alice);
    expect(google.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const rows = await copies();
    expect(new Set(rows.map((r) => r.gcal_event_id)).size).toBe(1);
    expect(rows.every((r) => r.gcal_event_id)).toBe(true);
  });

  it('2. an attendee dropping their copy leaves the shared calendar event alone', async () => {
    const FAMILY = 'family123@group.calendar.google.com';
    await db.updateTable('users').set({ default_calendar_id: FAMILY }).where('id', 'in', [alice, bob]).execute();
    await createEvent(db, {
      groupId,
      title: 'Parent night',
      startsAt: startsAt(),
      createdBy: alice,
      googleCalendarId: FAMILY,
    });
    await settleBackgroundWork();
    await pushDirtyEvents(db, bob);
    const bobs = (await copies()).find((r) => r.owner_user_id === bob)!;

    await deleteEvent(db, bobs.id);
    await settleBackgroundWork();
    expect(google.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect(google.events.size).toBe(1);
  });

  describe('a repeating group event on one shared calendar', () => {
    const FAMILY = 'family123@group.calendar.google.com';
    const weekly = { rrule: 'FREQ=WEEKLY;COUNT=4', tz: 'America/New_York' };

    async function series() {
      return db.selectFrom('event_series').selectAll().where('group_id', '=', groupId).execute();
    }
    const masterInserts = () =>
      google.calls.filter((c) => c.method === 'POST' && c.calendarId === FAMILY);

    beforeEach(async () => {
      await db.updateTable('users').set({ default_calendar_id: FAMILY }).where('id', 'in', [alice, bob]).execute();
    });

    it('gets ONE series master there', async () => {
      await createEvent(db, {
        groupId,
        title: 'Choir',
        startsAt: startsAt(),
        createdBy: alice,
        googleCalendarId: FAMILY,
        repeat: weekly,
      });
      await settleBackgroundWork();
      await pushDirtyEvents(db, bob);
      await pushDirtyEvents(db, alice);

      expect(masterInserts()).toHaveLength(1);
      const rows = await series();
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((s) => s.gcal_event_id)).size).toBe(1);
      expect(rows.every((s) => s.gcal_event_id && s.local_dirty === 0)).toBe(true);
      // Bob's occurrences point at the shared master, so his pull adopts its instances.
      const bobsSeries = rows.find((s) => s.owner_user_id === bob)!;
      const bobsOccurrences = await db
        .selectFrom('events')
        .select('recurring_event_id')
        .where('series_id', '=', bobsSeries.id)
        .execute();
      expect(bobsOccurrences.length).toBeGreaterThan(0);
      expect(bobsOccurrences.every((o) => o.recurring_event_id === bobsSeries.gcal_event_id)).toBe(true);
    });

    it('the attendee series pushing first waits instead of inserting a twin', async () => {
      await createEvent(db, {
        groupId,
        title: 'Choir',
        startsAt: startsAt(),
        createdBy: alice,
        googleCalendarId: FAMILY,
        repeat: weekly,
      });
      await settleBackgroundWork();
      google.calls.length = 0;
      google.events.clear();
      await db.updateTable('event_series').set({ gcal_event_id: null, etag: null, local_dirty: 1 }).execute();

      await pushDirtyEvents(db, bob);
      expect(masterInserts()).toHaveLength(0);
      await pushDirtyEvents(db, alice);
      expect(masterInserts()).toHaveLength(1);
      const rows = await series();
      expect(new Set(rows.map((s) => s.gcal_event_id)).size).toBe(1);
      expect(rows.every((s) => s.gcal_event_id)).toBe(true);
    });

    it('an attendee dropping their series leaves the shared master alone', async () => {
      await createEvent(db, {
        groupId,
        title: 'Choir',
        startsAt: startsAt(),
        createdBy: alice,
        googleCalendarId: FAMILY,
        repeat: weekly,
      });
      await settleBackgroundWork();
      await pushDirtyEvents(db, bob);
      const bobsSeries = (await series()).find((s) => s.owner_user_id === bob)!;
      const occurrence = await db
        .selectFrom('events')
        .selectAll()
        .where('series_id', '=', bobsSeries.id)
        .executeTakeFirstOrThrow();

      await deleteSeries(db, occurrence);
      await settleBackgroundWork();
      expect(google.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
      expect(google.events.size).toBe(1);
    });
  });

  it('3. a member subscribed to another member’s calendar does not pull a second copy', async () => {
    await createEvent(db, { groupId, title: 'Swim meet', startsAt: startsAt(), createdBy: alice });
    await settleBackgroundWork();
    const alices = (await copies()).find((r) => r.owner_user_id === alice)!;
    const remote = google.events.get(alices.gcal_event_id!)!;

    // Bob subscribes to Alice's primary calendar.
    const transport = googleCalendarTransport('fake-token');
    await pullCalendarChanges(db, bob, 'alice@example.com', undefined, {
      ...transport,
      listChanges: async () => ({ items: [google.resource(remote)], nextSyncToken: 't1', wasFullSync: true }),
    } as typeof transport);

    const bobsRows = await db
      .selectFrom('events')
      .select('id')
      .where('owner_user_id', '=', bob)
      .where('deleted_at', 'is', null)
      .execute();
    expect(bobsRows).toHaveLength(1);
  });
});
