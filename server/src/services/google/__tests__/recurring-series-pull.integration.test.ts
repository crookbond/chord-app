/**
 * ADR 0217 — every instance of a repeating Google event arrives from
 * `events.list?singleEvents=true` as its own item, but they all share the
 * series' iCalUID (and, for a series Chord pushed, its chordUid stamp).
 * `findLocalCopy` matched on those, so the second instance found the first
 * instance's row and overwrote it: a weekly series landed in Chord as ONE
 * event, at whichever date was pulled last.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const CAL = 'primary';

/** A weekly Google series as `singleEvents=true` returns it: one item per
 *  occurrence, each with its own instance id and originalStartTime, all
 *  sharing the master's iCalUID and recurringEventId. */
function instance(master: string, day: string) {
  const compact = day.replace(/-/g, '');
  return {
    kind: 'calendar#event',
    id: `${master}_${compact}T193000Z`,
    status: 'confirmed',
    summary: 'Nolan Sci Oly',
    iCalUID: `${master}@google.com`,
    recurringEventId: master,
    originalStartTime: { dateTime: `${day}T15:30:00-04:00`, timeZone: 'America/New_York' },
    start: { dateTime: `${day}T15:30:00-04:00`, timeZone: 'America/New_York' },
    end: { dateTime: `${day}T17:30:00-04:00`, timeZone: 'America/New_York' },
    updated: '2026-09-28T22:10:00.000Z',
    sequence: 0,
  };
}

const inDays = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('pulling a repeating Google event', () => {
  let db: Kysely<DB>;
  let user: string;

  beforeEach(async () => {
    db = await openTestDb();
    user = await createUser(db, 'series-puller');
    await upsertCalendarSource(db, user, {
      googleCalendarId: CAL,
      summary: 'me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? gjson({ items, nextSyncToken: 'tok' }) : gjson({}),
      ),
    );

  it('keeps one row per occurrence', async () => {
    const master = 'sciolymaster01';
    const days = [inDays(2), inDays(9), inDays(16)];
    stubPull(days.map((d) => instance(master, d)));

    const result = await pullCalendarChanges(db, user, CAL, 'fake-token');
    expect(result.failed).toBe(0);

    const rows = await db
      .selectFrom('events')
      .select(['gcal_event_id', 'starts_at', 'recurring_event_id'])
      .where('owner_user_id', '=', user)
      .orderBy('starts_at')
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.starts_at.slice(0, 10))).toEqual(days);
    expect(rows.every((r) => r.recurring_event_id === master)).toBe(true);

    // A second pass changes nothing: each instance finds its own row.
    const again = await pullCalendarChanges(db, user, CAL, 'fake-token');
    expect(again.inserted).toBe(0);
    expect(
      await db.selectFrom('events').select('id').where('owner_user_id', '=', user).execute(),
    ).toHaveLength(3);
  });
});

/**
 * Prod: one monthly Google series ("Send Ben Money") held 729 rows, out to
 * 2086. The 365-day window is only sent on a full listing; a syncToken delta
 * is not limited to it, and an edit to an endless series returns every
 * occurrence Google expands (about 730). Each was inserted.
 */
describe('a repeating Google event past the pull window', () => {
  const MASTER = '_6cq32dpl8oq4cba66sr3eb9k75232b9p6gq3aba3752k8c1n88o3aci36s';
  const ICAL = '34175F4F-F767-49D1-9445-C9ED07B052C7';
  const CAL_ID = 'ownertest@gmail.com';
  let db: Kysely<DB>;
  let user: string;
  let urls: string[];

  /** The 10th of each month from 2025-11 for `count` months, as Google's
   *  `singleEvents` delta lists them. */
  function monthly(count: number) {
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.UTC(2025, 10 + i, 10));
      const day = d.toISOString().slice(0, 10);
      return {
        kind: 'calendar#event',
        id: `${MASTER}_${day.replace(/-/g, '')}`,
        status: 'confirmed',
        summary: 'Send Ben Money',
        iCalUID: ICAL,
        recurringEventId: MASTER,
        originalStartTime: { date: day },
        start: { date: day },
        end: { date: new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10) },
        updated: '2026-10-09T12:00:00.000Z',
        sequence: 1,
      };
    });
  }

  const stubPull = (items: unknown[]) => {
    urls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        urls.push(String(url));
        return String(url).includes('/events') ? gjson({ items, nextSyncToken: 'tok-next' }) : gjson({});
      }),
    );
  };

  const source = () =>
    db
      .selectFrom('calendar_sources')
      .select(['sync_token', 'full_synced_at'])
      .where('user_id', '=', user)
      .where('google_calendar_id', '=', CAL_ID)
      .executeTakeFirstOrThrow();

  const rows = () =>
    db
      .selectFrom('events')
      .select(['gcal_event_id', 'starts_at', 'title'])
      .where('owner_user_id', '=', user)
      .orderBy('starts_at')
      .execute();

  beforeEach(async () => {
    db = await openTestDb();
    user = await createUser(db, 'ben-money');
    await upsertCalendarSource(db, user, {
      googleCalendarId: CAL_ID,
      summary: CAL_ID,
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
    // A cursor from a full listing an hour ago: the next pass is a delta.
    await db
      .updateTable('calendar_sources')
      .set({ sync_token: 'tok-0', full_synced_at: new Date(Date.now() - 3_600_000).toISOString() })
      .where('user_id', '=', user)
      .execute();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  it('stores only the occurrences within a year when a delta returns the whole series', async () => {
    stubPull(monthly(730));

    const result = await pullCalendarChanges(db, user, CAL_ID, 'fake-token');
    expect(result.failed).toBe(0);
    expect(urls.some((u) => u.includes('syncToken=tok-0'))).toBe(true);

    const held = await rows();
    const limit = Date.now() + 365 * 86_400_000;
    expect(held.length).toBeGreaterThan(0);
    expect(held.length).toBeLessThan(30);
    expect(held.every((r) => Date.parse(`${r.starts_at.slice(0, 10)}T00:00:00Z`) <= limit)).toBe(true);
  });

  it('still updates an occurrence past the window that is already held', async () => {
    const [far] = monthly(730).slice(400, 401);
    stubPull([far]);
    // Held from before the fix.
    await db
      .insertInto('events')
      .values({
        id: 'e_far',
        group_id: (await ensurePersonalGroup(db, user)).id,
        group_ids: '[]',
        owner_user_id: user,
        created_by: user,
        created_at: '2026-10-09T12:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        title: 'Send Ben Money (old)',
        starts_at: far!.start.date,
        all_day: 1,
        ical_uid: ICAL,
        gcal_event_id: far!.id,
        google_calendar_id: CAL_ID,
        recurring_event_id: MASTER,
        sequence: 0,
        local_dirty: 0,
      })
      .execute();

    await pullCalendarChanges(db, user, CAL_ID, 'fake-token');
    const held = await rows();
    expect(held).toHaveLength(1);
    expect(held[0]!.title).toBe('Send Ben Money');
  });

  it('lists the whole window again once the cursor is a day old', async () => {
    await db
      .updateTable('calendar_sources')
      .set({ full_synced_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .where('user_id', '=', user)
      .execute();
    stubPull(monthly(3));

    await pullCalendarChanges(db, user, CAL_ID, 'fake-token');
    const listUrl = urls.find((u) => u.includes('/events'))!;
    expect(listUrl).not.toContain('syncToken');
    expect(listUrl).toContain('timeMax');
    const src = await source();
    expect(src.sync_token).toBe('tok-next');
    expect(Date.now() - Date.parse(src.full_synced_at!)).toBeLessThan(60_000);
  });
});
