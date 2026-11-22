/**
 * ADR 0200 — two Chord users subscribed to the same Google calendar each get
 * their own copy of its events.
 *
 * Prod, 2026-09-20..23: ~7,900 warnings a day of
 * `two-way pull item failed cal=en.usa#holiday@group.v.calendar.google.com
 * user=u_N5ow9zZGwsyC event=20261225_q1cjdk9utc6u8gie59mrlsh778: duplicate key
 * value violates unique constraint "uq_events_gcal_event"`. The public US
 * holidays calendar hands every subscriber the same event ids, another user
 * already owned (holiday calendar, 20261225_…) and the index was global, so
 * the owner-scoped pull's insert failed on every pass, forever. Two other
 * subscribers had it worse: their first pull failed the same way but saved
 * its sync cursor, so later deltas never re-sent the holidays and they had
 * none, with nothing in the logs.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
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

const HOLIDAYS = 'en.usa#holiday@group.v.calendar.google.com';

const holiday = (id: string, date: string, next: string, summary: string) => ({
  kind: 'calendar#event',
  id,
  status: 'confirmed',
  summary,
  description: 'Public holiday',
  iCalUID: `${id}@google.com`,
  start: { date },
  end: { date: next },
  transparency: 'transparent',
  visibility: 'public',
  eventType: 'default',
  updated: '2026-06-02T16:00:00.000Z',
  sequence: 0,
});

const CHRISTMAS = holiday('20261225_q1cjdk9utc6u8gie59mrlsh778', '2026-12-25', '2026-12-26', 'Christmas Day');
const BLACK_FRIDAY = holiday('20261127_sqgeamknoire9j3326eu506ais', '2026-11-27', '2026-11-28', 'Black Friday');

describe('a calendar several users subscribe to', () => {
  let db: Kysely<DB>;
  let first: string;
  let second: string;

  beforeEach(async () => {
    db = await openTestDb();
    first = await createUser(db, 'holiday-subscriber-1');
    second = await createUser(db, 'holiday-subscriber-2');
    for (const u of [first, second]) {
      await upsertCalendarSource(db, u, {
        googleCalendarId: HOLIDAYS,
        summary: 'Holidays in United States',
        accessRole: 'reader',
        isPrimary: false,
        selectedInGoogle: true,
        isChordTarget: false,
      });
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stubPull = (items: unknown[], nextSyncToken = 'tok-next') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? gjson({ items, nextSyncToken }) : gjson({}),
      ),
    );

  const syncToken = async (userId: string) =>
    (
      await db
        .selectFrom('calendar_sources')
        .select('sync_token')
        .where('user_id', '=', userId)
        .where('google_calendar_id', '=', HOLIDAYS)
        .executeTakeFirstOrThrow()
    ).sync_token;

  it('the second subscriber gets their own holiday rows', async () => {
    stubPull([CHRISTMAS, BLACK_FRIDAY]);
    const a = await pullCalendarChanges(db, first, HOLIDAYS, 'fake-token');
    expect(a.inserted).toBe(2);

    const b = await pullCalendarChanges(db, second, HOLIDAYS, 'fake-token');
    expect(b.failed).toBe(0);
    expect(b.inserted).toBe(2);

    const rows = await db
      .selectFrom('events')
      .select(['owner_user_id', 'gcal_event_id', 'title', 'all_day'])
      .where('google_calendar_id', '=', HOLIDAYS)
      .orderBy('owner_user_id')
      .orderBy('gcal_event_id')
      .execute();
    expect(rows).toHaveLength(4);
    for (const u of [first, second]) {
      const mine = rows.filter((r) => r.owner_user_id === u);
      expect(mine.map((r) => r.title).sort()).toEqual(['Black Friday', 'Christmas Day']);
    }

    // And the next pass converges instead of failing again.
    const again = await pullCalendarChanges(db, second, HOLIDAYS, 'fake-token');
    expect(again.failed).toBe(0);
    expect(again.inserted).toBe(0);
  });

  it('a pass with a failed item keeps its cursor, so the item is retried', async () => {
    await db
      .updateTable('calendar_sources')
      .set({ sync_token: 'tok-before' })
      .where('user_id', '=', second)
      .execute();
    // Postgres refuses a NUL byte in text, so this item cannot be stored.
    stubPull([{ ...CHRISTMAS, summary: 'Christmas\u0000Day' }, BLACK_FRIDAY]);

    const result = await pullCalendarChanges(db, second, HOLIDAYS, 'fake-token');
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(1);
    expect(await syncToken(second)).toBe('tok-before');

    stubPull([CHRISTMAS, BLACK_FRIDAY]);
    const retry = await pullCalendarChanges(db, second, HOLIDAYS, 'fake-token');
    expect(retry.failed).toBe(0);
    expect(retry.inserted).toBe(1);
    expect(await syncToken(second)).toBe('tok-next');
  });
});
