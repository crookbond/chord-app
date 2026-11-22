/**
 * A push Google has rejected stops being re-sent.
 *
 * Prod, 2026-08-24: one event created on 18 June sat at `local_dirty=1` with
 * `gcal_last_error='events.insert 400'` and was re-sent on every sync pass for
 * over two months, failing identically every time. The catch restored the dirty
 * flag unconditionally, so "retry" had no exit.
 *
 * A 4xx is Google refusing this payload, not a hiccup — the same body will be
 * refused the same way forever. 408 and 429 are the two that genuinely mean
 * try again, and 5xx always does.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const start = new Date(Date.now() + 3 * 86_400_000).toISOString();

describe('push give-up', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'push-giveup-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    // Write scope, or pushDirtyEvents returns before it reaches fetch.
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const stubInsert = (status: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: status < 400,
            status,
            json: async () => ({}),
            text: async () => '',
          }) as unknown as Response,
      ),
    );

  // Inserted directly rather than through createEvent: that fires a
  // background push, which would race — and win — against the explicit pass
  // this test is measuring.
  const seed = async () => {
    const id = newId('e');
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
        title: 'Giant',
        starts_at: start,
        created_at: now,
        updated_at: now,
        created_by: userId,
        status: 'confirmed',
        sequence: 0,
        google_calendar_id: 'primary',
        local_dirty: 1,
      })
      .execute();
    return id;
  };

  const dirtyOf = async (id: string) =>
    (
      await db
        .selectFrom('events')
        .select(['local_dirty', 'gcal_sync_status', 'gcal_last_error'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
    );

  it('a 400 is not retried on the next pass', async () => {
    const id = await seed();
    stubInsert(400);

    const first = await pushDirtyEvents(db, userId);
    expect(first.errored).toBe(1);
    const after = await dirtyOf(id);
    expect(after.local_dirty).toBe(0);
    expect(after.gcal_sync_status).toBe('error');
    expect(after.gcal_last_error).toBe('events.insert 400');

    // The next pass finds nothing to send — this is the loop that ran for two
    // months.
    const second = await pushDirtyEvents(db, userId);
    expect(second.errored).toBe(0);
    expect(second.created).toBe(0);
  });

  it('a 500 is still retried', async () => {
    const id = await seed();
    stubInsert(500);

    await pushDirtyEvents(db, userId);
    expect((await dirtyOf(id)).local_dirty).toBe(1);

    const second = await pushDirtyEvents(db, userId);
    expect(second.errored).toBe(1);
  });

  it('a 429 is still retried — rate limiting is not rejection', async () => {
    const id = await seed();
    stubInsert(429);

    await pushDirtyEvents(db, userId);
    expect((await dirtyOf(id)).local_dirty).toBe(1);
  });

  it('a local edit re-arms a given-up event', async () => {
    const id = await seed();
    stubInsert(400);
    await pushDirtyEvents(db, userId);
    expect((await dirtyOf(id)).local_dirty).toBe(0);

    // Whatever Google objected to may now be fixed, so an edit is the signal
    // that it is worth another try.
    await db.updateTable('events').set({ local_dirty: 1 }).where('id', '=', id).execute();
    const again = await pushDirtyEvents(db, userId);
    expect(again.errored).toBe(1);
  });

  // Regression: a Resy reservation .ics stuck at `gcal_last_error='events.insert
  // 400'` with no further detail — GcalWriteError discarded Google's response
  // body, so the ONLY trace of a silent calendar-push failure was that bare
  // status code, undiagnosable without SSH+log archaeology. The body (where
  // Google's actual rejection reason lives) is now captured and stored.
  it('captures the response body Google actually sent, not just the status', async () => {
    const id = await seed();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            json: async () => ({}),
            text: async () =>
              '{"error":{"errors":[{"reason":"invalid","message":"Invalid time range."}],"code":400,"message":"Invalid time range."}}',
          }) as unknown as Response,
      ),
    );

    await pushDirtyEvents(db, userId);
    const after = await dirtyOf(id);
    expect(after.gcal_last_error).toContain('events.insert 400');
    expect(after.gcal_last_error).toContain('Invalid time range.');
  });
});
