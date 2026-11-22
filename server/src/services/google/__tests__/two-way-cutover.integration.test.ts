/**
 * ADR 0040 pull cutover: syncTwoWay discovers calendars, pulls changes, and
 * heals rows left by the legacy read sync (external_uid `gcal:<id>`, no
 * gcal_event_id) instead of inserting duplicates. Google mocked at the fetch +
 * access-token seam.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { syncTwoWay } from '@/services/google/two-way-sync.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function res(body: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
const now = new Date().toISOString();

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'cut');
  await db
    .updateTable('users')
    .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
    .where('id', '=', userId)
    .execute();
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

/** Mock calendarList (one owned primary) + an events list with the given items. */
function stubGoogle(eventItems: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/users/me/calendarList')) {
        return res({ items: [{ id: 'primary@cal', primary: true, accessRole: 'owner', selected: true }] });
      }
      if (u.includes('/events')) {
        return res({ items: eventItems, nextSyncToken: 'tok-1' });
      }
      return res({});
    }),
  );
}

describe('syncTwoWay — discovery + pull', () => {
  it('discovers the calendar, refreshes calendar_sources, pulls a new event, stamps synced_at', async () => {
    stubGoogle([
      {
        id: 'g-new',
        iCalUID: 'uid-new@g',
        status: 'confirmed',
        summary: 'Pulled',
        start: { dateTime: future },
        end: { dateTime: future },
        sequence: 0,
        updated: now,
      },
    ]);

    await syncTwoWay(db, userId);

    const src = await db
      .selectFrom('calendar_sources')
      .selectAll()
      .where('user_id', '=', userId)
      .where('google_calendar_id', '=', 'primary@cal')
      .executeTakeFirstOrThrow();
    expect(src.access_role).toBe('owner');
    expect(src.is_primary).toBe(1);
    expect(src.sync_token).toBe('tok-1');

    const ev = await db.selectFrom('events').selectAll().where('gcal_event_id', '=', 'g-new').executeTakeFirstOrThrow();
    expect(ev.owner_user_id).toBe(userId);
    expect(ev.title).toBe('Pulled');

    const user = await db.selectFrom('users').select('google_calendar_synced_at').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(user.google_calendar_synced_at).not.toBeNull();
  });

  it('heals a legacy-synced row instead of inserting a duplicate', async () => {
    // Row as the legacy read sync + migration 005 would leave it: identity only
    // in external_uid, gcal_event_id null, ical_uid on the old scheme.
    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: groupId,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Legacy event',
        starts_at: future,
        created_at: now,
        updated_at: now,
        created_by: userId,
        status: 'confirmed',
        sequence: 0,
        local_dirty: 0,
        external_uid: 'gcal:evt-legacy',
        ical_uid: 'gcal:evt-legacy',
      })
      .execute();

    stubGoogle([
      {
        id: 'evt-legacy',
        iCalUID: 'real-uid@g',
        status: 'confirmed',
        summary: 'Legacy event',
        start: { dateTime: future },
        end: { dateTime: future },
        sequence: 0,
        updated: now,
      },
    ]);

    await syncTwoWay(db, userId);

    const rows = await db
      .selectFrom('events')
      .selectAll()
      .where('owner_user_id', '=', userId)
      .where('title', '=', 'Legacy event')
      .execute();
    expect(rows).toHaveLength(1); // not duplicated
    expect(rows[0]!.gcal_event_id).toBe('evt-legacy'); // adopted Google event id
    expect(rows[0]!.ical_uid).toBe('real-uid@g'); // adopted real iCalUID
    expect(rows[0]!.google_calendar_id).toBe('primary@cal');
  });
});
