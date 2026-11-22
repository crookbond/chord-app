/**
 * ADR 0040 — create / edit / delete are wired to the two-way sync shell.
 * Google is mocked at the fetch + access-token seam; the reconcile core, DB
 * writes, and loop-prevention are real.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { createEvent, deleteEvent, updateEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { settleBackgroundWork } from '@/utils/background.js';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const future = new Date(Date.now() + 2 * 86_400_000).toISOString();

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'syncer');
  // Grant calendar write scope so the two-way push is not a no-op.
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

/** Poll until `ok(value)` or the timeout; returns the last value either way so a
 *  failing assertion shows the real state. The push paths are fire-and-forget. */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 1500): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() - start > ms) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function row(id: string) {
  return db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
}

async function seedSyncedEvent(over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? newId('e');
  const now = new Date().toISOString();
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
      created_at: now,
      updated_at: now,
      created_by: userId,
      status: 'confirmed',
      sequence: 0,
      local_dirty: 0,
      ...over,
    })
    .execute();
  return id;
}

describe('createEvent → two-way push', () => {
  it('creates a genuine event on Google and stamps the row', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && String(url).includes('/events')) {
        return res({ id: 'g1', etag: '"e1"', iCalUID: 'uid1', sequence: 0 });
      }
      return res({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const ev = await createEvent(db, {
      groupId,
      title: 'Picnic',
      startsAt: future,
      createdBy: userId,
    });

    const synced = await until(() => row(ev.id), (r) => r?.gcal_event_id === 'g1');
    expect(synced?.gcal_event_id).toBe('g1');
    expect(synced?.local_dirty).toBe(0);
    expect(synced?.gcal_sync_status).toBe('synced');
    expect(synced?.chord_uid).toBe(ev.id); // chord_uid = row id for our creates
    // Chord's key survives the push; Google's iCalUID names only this copy's
    // Google event (ADR 0040 addendum 2026-10-23).
    expect(synced?.ical_uid).not.toBe('uid1');
    expect(synced?.ical_uid).toBeTruthy();

    const post = fetchMock.mock.calls.find(([, i]) => i?.method === 'POST')!;
    const body = JSON.parse(post[1]?.body as string);
    expect(body.summary).toBe('Picnic');
    expect(body.extendedProperties.private.chordUid).toBe(ev.id);
  });

  it('does NOT push a gcal-sourced (pulled) event back — loop prevention', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({}));
    vi.stubGlobal('fetch', fetchMock);

    const ev = await createEvent(db, {
      groupId,
      title: 'Synced in',
      startsAt: future,
      createdBy: userId,
      externalUid: 'gcal:abc',
    });
    await settleBackgroundWork();

    const r = await row(ev.id);
    expect(r?.local_dirty).toBe(0);
    expect(r?.chord_uid).toBeNull();
    expect(r?.ical_uid).toBe('gcal:abc');
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
  });
});

describe('updateEvent → two-way patch', () => {
  it('bumps the sequence and patches Google', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') {
        return res({ id: 'g_up', etag: '"e2"', sequence: 1 });
      }
      return res({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedSyncedEvent({ title: 'Old', gcal_event_id: 'g_up', google_calendar_id: 'primary' });
    const updated = await updateEvent(db, id, { title: 'New' });
    expect(updated?.title).toBe('New');

    // Poll on gcal_sync_status: the claim clears local_dirty up front, so only
    // 'synced' (set by markPushed) signals the push actually completed.
    const synced = await until(() => row(id), (r) => r?.gcal_sync_status === 'synced');
    expect(synced?.title).toBe('New');
    expect(synced?.sequence).toBe(1);
    expect(synced?.etag).toBe('"e2"');
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PATCH')).toBe(true);
  });

  it('ADR 0297: a time zone set in the editor is stored and sent to Google', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PATCH') return res({ id: 'g_tz', etag: '"e3"', sequence: 1 });
      return res({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedSyncedEvent({ title: 'Call', gcal_event_id: 'g_tz', google_calendar_id: 'primary' });
    const updated = await updateEvent(db, id, { startsAt: '2026-11-21T14:00:00.000Z', timeZone: 'Europe/Paris' });
    expect(updated?.timeZone).toBe('Europe/Paris');

    await until(() => row(id), (r) => r?.gcal_sync_status === 'synced');
    const patch = fetchMock.mock.calls.find(([, i]) => i?.method === 'PATCH');
    const body = JSON.parse(String(patch?.[1]?.body)) as { start?: { timeZone?: string } };
    expect(body.start?.timeZone).toBe('Europe/Paris');
  });
});

describe('deleteEvent → two-way delete', () => {
  it('deletes on Google and removes the local row', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({}, 204));
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedSyncedEvent({ gcal_event_id: 'g_del', google_calendar_id: 'primary' });
    await deleteEvent(db, id);

    expect(await row(id)).toBeUndefined();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(true);
  });

  it('recovers the Google link from a legacy external_uid so the delete propagates', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({}, 204));
    vi.stubGlobal('fetch', fetchMock);

    // Pre-two-way row: gcal_event_id NULL, linkage only in external_uid.
    const id = await seedSyncedEvent({ external_uid: 'gcal:secondary@cal:evt-9', gcal_event_id: null });
    await deleteEvent(db, id);

    expect(await row(id)).toBeUndefined();
    const del = fetchMock.mock.calls.find(([, i]) => i?.method === 'DELETE')!;
    expect(String(del[0])).toContain('evt-9'); // targeted the recovered event id
    expect(String(del[0])).toContain('secondary%40cal'); // ...on the recovered calendar
  });

  it('reverseDeleteFromGoogle skips the push (Google already removed it)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => res({}, 204));
    vi.stubGlobal('fetch', fetchMock);

    const id = await seedSyncedEvent({ gcal_event_id: 'g_rev', google_calendar_id: 'primary' });
    await deleteEvent(db, id, { reverseDeleteFromGoogle: true });

    expect(await row(id)).toBeUndefined();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'DELETE')).toBe(false);
  });
});
