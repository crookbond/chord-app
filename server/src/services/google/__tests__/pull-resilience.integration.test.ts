/**
 * One calendar's pull must not be able to kill another's, and one bad event
 * must not be able to kill the pass.
 *
 * Prod, 2026-08-24: every single pull of the family calendar had been failing
 * with `duplicate key value violates unique constraint "uq_events_gcal_event"`,
 * so that calendar had silently stopped syncing altogether. `findLocalCopy`
 * matched on `ical_uid` with no calendar scope, and the same logical event
 * subscribed on two calendars (a school feed the family calendar also carries)
 * gives both copies one `ical_uid` — so pulling calendar B matched calendar A's
 * row and tried to move it onto a `(calendar, event)` pair A's sibling already
 * held. The violation escaped the per-item work and aborted the whole loop.
 *
 * Both halves are pinned: the match is calendar-scoped, and a throw on one item
 * is counted and stepped over rather than ending the pass.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
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

const SHARED_UID = '20260601T050000Z-242329@events.uchicago.edu';
const FEED = 'schoolfeed@group.calendar.google.com';
const FAMILY = 'family07746@group.calendar.google.com';
const start = new Date(Date.now() + 4 * 86_400_000).toISOString();

const remote = (id: string, uid: string, summary = 'Convocation') => ({
  id,
  status: 'confirmed',
  summary,
  iCalUID: uid,
  start: { dateTime: start },
  end: { dateTime: new Date(Date.parse(start) + 3_600_000).toISOString() },
  updated: new Date().toISOString(),
  sequence: 0,
});

describe('pull resilience', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'pull-resilience-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? gjson({ items, nextSyncToken: 'tok1' }) : gjson({}),
      ),
    );

  /** The same logical event already synced from the feed calendar. */
  const seedFeedCopy = async () => {
    const ev = await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Convocation',
      startsAt: start,
    });
    await db
      .updateTable('events')
      .set({
        ical_uid: SHARED_UID,
        gcal_event_id: 'FEEDCOPY',
        google_calendar_id: FEED,
        local_dirty: 0,
        gcal_sync_status: 'synced',
      })
      .where('id', '=', ev.id)
      .execute();
    return ev.id;
  };

  it('the family copy inserts instead of stealing the feed calendar row', async () => {
    const feedId = await seedFeedCopy();
    stubPull([remote('FAMILYCOPY', SHARED_UID)]);

    const result = await pullCalendarChanges(db, userId, FAMILY, 'fake-token');

    expect(result.failed).toBe(0);
    expect(result.inserted).toBe(1);

    const rows = await db
      .selectFrom('events')
      .select(['id', 'google_calendar_id', 'gcal_event_id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .orderBy('google_calendar_id')
      .execute();
    // Two calendars genuinely carry this event; the feed row keeps its own
    // identity rather than being dragged onto the family calendar.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === feedId)!.google_calendar_id).toBe(FEED);
    expect(rows.find((r) => r.id !== feedId)!.google_calendar_id).toBe(FAMILY);
  });

  it('a row already on THIS calendar is still matched, not duplicated', async () => {
    const feedId = await seedFeedCopy();
    stubPull([remote('FEEDCOPY', SHARED_UID, 'Convocation (moved)')]);

    const result = await pullCalendarChanges(db, userId, FEED, 'fake-token');

    expect(result.inserted).toBe(0);
    const rows = await db
      .selectFrom('events')
      .select(['id', 'title'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(feedId);
    expect(rows[0]!.title).toBe('Convocation (moved)');
  });

  it('one unreconcilable item is counted and the rest of the pass still lands', async () => {
    // Postgres refuses a NUL byte in text, so this item's write throws. (Until
    // ADR 0200 this test used a cross-user collision on the Google-link index;
    // that collision was itself the bug, and scoping the index by owner
    // removed it.)
    stubPull([
      remote('BADTEXT', 'bad-text@example.com', 'Nul\u0000byte'),
      remote('CLEAN', 'clean-uid@example.com', 'Arrives fine'),
    ]);

    const result = await pullCalendarChanges(db, userId, FAMILY, 'fake-token');

    // The first item cannot land, but it no longer takes the second with it.
    expect(result.failed).toBe(1);
    expect(result.inserted).toBe(1);
    const titles = (
      await db
        .selectFrom('events')
        .select('title')
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .execute()
    ).map((r) => r.title);
    expect(titles).toContain('Arrives fine');
  });
});
