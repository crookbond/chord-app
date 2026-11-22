/**
 * The background calendar sweep (ADR 0181), mirroring ADR 0144's mail sweep.
 *
 * Two-way calendar sync only ever ran opportunistically (a bot call, a
 * foreground refresh, the manual sync route) — this sweep gives it the same
 * periodic backstop mail already has, so an edit made directly in Google
 * Calendar between sessions converges without the user triggering anything.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { sweepCalendars } from '@/services/google/calendar-sweep.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let db: Kysely<DB>;
let originalEnabled: boolean;
let originalMinutes: number;
let originalBatch: number;

beforeEach(async () => {
  db = await openTestDb();
  originalEnabled = env.CALENDAR_SWEEP_ENABLED;
  originalMinutes = env.CALENDAR_SWEEP_MINUTES;
  originalBatch = env.CALENDAR_SWEEP_BATCH;
  (env as { CALENDAR_SWEEP_ENABLED: boolean }).CALENDAR_SWEEP_ENABLED = true;
  (env as { CALENDAR_SWEEP_MINUTES: number }).CALENDAR_SWEEP_MINUTES = 15;
  (env as { CALENDAR_SWEEP_BATCH: number }).CALENDAR_SWEEP_BATCH = 20;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => res({ items: [] })),
  );
});

afterEach(async () => {
  (env as { CALENDAR_SWEEP_ENABLED: boolean }).CALENDAR_SWEEP_ENABLED = originalEnabled;
  (env as { CALENDAR_SWEEP_MINUTES: number }).CALENDAR_SWEEP_MINUTES = originalMinutes;
  (env as { CALENDAR_SWEEP_BATCH: number }).CALENDAR_SWEEP_BATCH = originalBatch;
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

async function withCalendarScope(userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({
      refresh_token_ciphertext: Buffer.from('x'),
      refresh_token_scopes: 'https://www.googleapis.com/auth/calendar',
    })
    .where('id', '=', userId)
    .execute();
}

describe('sweepCalendars', () => {
  it('syncs a user whose calendar mirror is stale', async () => {
    const userId = await createUser(db, 'stale');
    await withCalendarScope(userId);
    await db
      .updateTable('users')
      .set({ google_calendar_synced_at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where('id', '=', userId)
      .execute();

    expect(await sweepCalendars(db)).toBe(1);
    const row = await db
      .selectFrom('users')
      .select('google_calendar_synced_at')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Date.now() - Date.parse(row.google_calendar_synced_at!)).toBeLessThan(5_000);
  });

  it('syncs a user who has never synced at all', async () => {
    const userId = await createUser(db, 'never');
    await withCalendarScope(userId);
    expect(await sweepCalendars(db)).toBe(1);
  });

  it('skips a user recently synced', async () => {
    const userId = await createUser(db, 'fresh');
    await withCalendarScope(userId);
    await db
      .updateTable('users')
      .set({ google_calendar_synced_at: new Date().toISOString() })
      .where('id', '=', userId)
      .execute();
    expect(await sweepCalendars(db)).toBe(0);
  });

  it('skips a user with no calendar scope', async () => {
    const userId = await createUser(db, 'noscope');
    await db
      .updateTable('users')
      .set({
        refresh_token_ciphertext: Buffer.from('x'),
        refresh_token_scopes: 'https://www.googleapis.com/auth/userinfo.email',
        google_calendar_synced_at: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .where('id', '=', userId)
      .execute();
    expect(await sweepCalendars(db)).toBe(0);
  });

  it('skips a shadow user', async () => {
    const userId = await createUser(db, 'shadow-user');
    await withCalendarScope(userId);
    await db.updateTable('users').set({ shadow: 1 }).where('id', '=', userId).execute();
    expect(await sweepCalendars(db)).toBe(0);
  });

  it('does nothing when disabled', async () => {
    (env as { CALENDAR_SWEEP_ENABLED: boolean }).CALENDAR_SWEEP_ENABLED = false;
    const userId = await createUser(db, 'disabled');
    await withCalendarScope(userId);
    expect(await sweepCalendars(db)).toBe(0);
  });

  it('one user’s failure does not stop the rest of the batch', async () => {
    const bad = await createUser(db, 'bad');
    await withCalendarScope(bad);
    const good = await createUser(db, 'good');
    await withCalendarScope(good);

    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('network blip');
        return res({ items: [] });
      }),
    );

    expect(await sweepCalendars(db)).toBe(1);
  });

  it('users who can never sync do not keep a calendar user out of the sweep', async () => {
    // Signed in with Google but no calendar scope: selected, dropped by the
    // scope check, and google_calendar_synced_at never moves - so ordered by
    // it they filled the over-fetch on every tick.
    (env as { CALENDAR_SWEEP_BATCH: number }).CALENDAR_SWEEP_BATCH = 1;
    for (let i = 0; i < 4; i++) {
      const id = await createUser(db, `no-scope-${i}`);
      await db
        .updateTable('users')
        .set({ refresh_token_ciphertext: Buffer.from('x'), refresh_token_scopes: 'openid email' })
        .where('id', '=', id)
        .execute();
    }
    const calendarUser = await createUser(db, 'starved');
    await withCalendarScope(calendarUser);
    await db
      .updateTable('users')
      .set({ google_calendar_synced_at: new Date(Date.now() - 60 * 60_000).toISOString() })
      .where('id', '=', calendarUser)
      .execute();

    const swept = (await sweepCalendars(db)) + (await sweepCalendars(db));
    expect(swept).toBe(1);
  });

  it('marks swept only the users it actually syncs', async () => {
    // Batch of 1 with three stale calendar users: one sweep syncs one, and
    // the other two must still be due on the next ticks, not stamped as
    // swept by an over-fetch they were sliced out of.
    (env as { CALENDAR_SWEEP_BATCH: number }).CALENDAR_SWEEP_BATCH = 1;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await createUser(db, `cal-${i}`);
      await withCalendarScope(id);
      ids.push(id);
    }
    expect(await sweepCalendars(db)).toBe(1);
    const stamped = await db
      .selectFrom('users')
      .select('id')
      .where('id', 'in', ids)
      .where('calendar_swept_at', 'is not', null)
      .execute();
    expect(stamped).toHaveLength(1);
    expect(await sweepCalendars(db)).toBe(1);
    expect(await sweepCalendars(db)).toBe(1);
  });
});
