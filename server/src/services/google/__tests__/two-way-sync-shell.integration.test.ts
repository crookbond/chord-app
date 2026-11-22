/**
 * Two-way sync I/O shell (ADR 0040). Google is mocked at the fetch +
 * access-token boundary (the same seam the reverse-delete test uses);
 * everything below — reconcile core, DB writes, syncToken persistence — is real.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  pullCalendarChanges,
  pushDirtyEvents,
} from '@/services/google/two-way-sync.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
const later = new Date(Date.now() + 60_000).toISOString();

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'syncer');
  // Write scope so pushDirtyEvents is not a no-op.
  await db
    .updateTable('users')
    .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
    .where('id', '=', userId)
    .execute();
  const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId });
  groupId = g.id;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

async function seedEvent(over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? newId('e');
  await db
    .insertInto('events')
    .values({
      id,
      group_id: groupId,
      group_ids: JSON.stringify([groupId]),
      owner_user_id: userId,
      organizer_user_id: userId,
      role: 'organizer',
      title: 'Seed',
      starts_at: future,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: userId,
      status: 'confirmed',
      sequence: 0,
      local_dirty: 0,
      ...over,
    })
    .execute();
  return id;
}

async function seedCalendarSource(googleCalendarId: string, syncToken?: string): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('calendar_sources')
    .values({
      id: newId('cs'),
      user_id: userId,
      google_calendar_id: googleCalendarId,
      summary: 'Cal',
      access_role: 'owner',
      is_primary: 1,
      selected_in_google: 1,
      first_seen_at: now,
      last_seen_at: now,
      ...(syncToken ? { sync_token: syncToken, full_synced_at: now } : {}),
    })
    .execute();
}

describe('pushDirtyEvents', () => {
  it('creates a dirty event on Google and stamps the row', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && String(url).includes('/events')) {
        return res({ id: 'g_new', etag: '"e1"', iCalUID: 'uid-new', sequence: 0 });
      }
      return res({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedEvent({ title: 'Picnic', local_dirty: 1, chord_uid: null });
    const result = await pushDirtyEvents(db, userId);

    expect(result.created).toBe(1);
    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.gcal_event_id).toBe('g_new');
    expect(row.etag).toBe('"e1"');
    expect(row.local_dirty).toBe(0);
    expect(row.gcal_sync_status).toBe('synced');
    expect(row.chord_uid).toMatch(/^ce_/); // stamped so the pull-back recognizes it

    // The POST body carried the chord_uid stamp.
    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    const body = JSON.parse(post[1]?.body as string);
    expect(body.extendedProperties.private.chordUid).toBe(row.chord_uid);
  });

  it('deletes a cancelled dirty event from Google and drops the row', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({}, 204));
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedEvent({ status: 'cancelled', local_dirty: 1, gcal_event_id: 'g_del', etag: '"x"' });
    const result = await pushDirtyEvents(db, userId);

    expect(result.deleted).toBe(1);
    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
    expect(row).toBeUndefined();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true);
  });
});

describe('pullCalendarChanges', () => {
  it('inserts a new remote event and persists the syncToken', async () => {
    await seedCalendarSource('cal-1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [
            {
              id: 'g_pull',
              iCalUID: 'uid-pull',
              status: 'confirmed',
              summary: 'Pulled',
              start: { dateTime: future },
              end: { dateTime: future },
              sequence: 0,
              updated: later,
            },
          ],
          nextSyncToken: 'tok-1',
        }),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'cal-1');
    expect(result.inserted).toBe(1);

    const row = await db.selectFrom('events').selectAll().where('gcal_event_id', '=', 'g_pull').executeTakeFirstOrThrow();
    expect(row.owner_user_id).toBe(userId);
    expect(row.role).toBe('attendee'); // no chord stamp -> foreign-origin
    expect(row.group_ids).toEqual([]); // calendar-only, not surfaced in a chat

    const src = await db.selectFrom('calendar_sources').select('sync_token').where('google_calendar_id', '=', 'cal-1').executeTakeFirstOrThrow();
    expect(src.sync_token).toBe('tok-1');
  });

  it('applies a higher-sequence remote edit to a clean local copy', async () => {
    await seedCalendarSource('cal-1');
    await seedEvent({ title: 'Old', gcal_event_id: 'g_up', ical_uid: 'uid-up', sequence: 0, local_dirty: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [
            {
              id: 'g_up',
              iCalUID: 'uid-up',
              status: 'confirmed',
              summary: 'New',
              start: { dateTime: future },
              end: { dateTime: future },
              sequence: 1,
              updated: later,
            },
          ],
          nextSyncToken: 'tok-2',
        }),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'cal-1');
    expect(result.applied).toBe(1);
    const row = await db.selectFrom('events').selectAll().where('gcal_event_id', '=', 'g_up').executeTakeFirstOrThrow();
    expect(row.title).toBe('New');
    expect(row.sequence).toBe(1);
  });

  it('deletes a local copy when Google reports it cancelled', async () => {
    await seedCalendarSource('cal-1');
    const id = await seedEvent({ gcal_event_id: 'g_del', ical_uid: 'uid-del' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({ items: [{ id: 'g_del', iCalUID: 'uid-del', status: 'cancelled' }], nextSyncToken: 'tok-3' }),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'cal-1');
    expect(result.deleted).toBe(1);
    expect(await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst()).toBeUndefined();
  });

  it('reverse-deletes a synced event absent from a full-sync snapshot (deleted in Google)', async () => {
    // No sync_token → full window sync, where Google omits deleted events. The
    // absent one must converge; the present one and a pending local create stay.
    await seedCalendarSource('cal-1');
    const gone = await seedEvent({ gcal_event_id: 'g_gone', ical_uid: 'uid-gone', google_calendar_id: 'cal-1' });
    const kept = await seedEvent({ gcal_event_id: 'g_kept', ical_uid: 'uid-kept', google_calendar_id: 'cal-1' });
    const dirtyNew = await seedEvent({ google_calendar_id: 'cal-1', gcal_event_id: null, local_dirty: 1 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [
            {
              id: 'g_kept',
              iCalUID: 'uid-kept',
              status: 'confirmed',
              summary: 'Kept',
              start: { dateTime: future },
              end: { dateTime: future },
              sequence: 0,
              updated: later,
            },
          ],
          nextSyncToken: 'tok-4',
        }),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'cal-1');
    expect(result.deleted).toBe(1);
    expect(await db.selectFrom('events').selectAll().where('id', '=', gone).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('events').selectAll().where('id', '=', kept).executeTakeFirst()).toBeDefined();
    // A pending local create (not yet pushed) must never be reverse-deleted.
    expect(await db.selectFrom('events').selectAll().where('id', '=', dirtyNew).executeTakeFirst()).toBeDefined();
  });

  it('does NOT reverse-delete on an incremental (token) sync — absence means unchanged', async () => {
    await seedCalendarSource('cal-1', 'existing-tok');
    const stillThere = await seedEvent({ gcal_event_id: 'g_inc', ical_uid: 'uid-inc', google_calendar_id: 'cal-1' });
    // A delta that carries no changes — g_inc is absent, but on a token sync
    // absence just means "unchanged", not "deleted".
    vi.stubGlobal('fetch', vi.fn(async () => res({ items: [], nextSyncToken: 'tok-5' })));

    const result = await pullCalendarChanges(db, userId, 'cal-1');
    expect(result.deleted).toBe(0);
    expect(await db.selectFrom('events').selectAll().where('id', '=', stillThere).executeTakeFirst()).toBeDefined();
  });
});
