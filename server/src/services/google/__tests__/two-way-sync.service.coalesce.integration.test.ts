/**
 * The calendar screen asks for /me/events?futureDays=730 on every focus, and
 * that used to start a full two-way sync each time with no throttle; nothing
 * stopped several passes for one user running at once. Overlapping calls now
 * share a pass (plus one follow-up), and the screen's focus is throttled.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { meEventsSyncThrottleMs } from '@/routes/events.js';
import { maybeSyncCalendar } from '@/services/google/calendar.service.js';
import { syncTwoWay } from '@/services/google/two-way-sync.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

const gate = vi.hoisted(() => ({
  calls: 0,
  release: [] as Array<() => void>,
}));

// The token step is where a pass waits on Google; hold it shut so passes
// overlap for as long as the test needs.
vi.mock('@/services/google/oauth.service.js', async (orig) => {
  const real = await orig<typeof import('@/services/google/oauth.service.js')>();
  return {
    ...real,
    getAccessToken: () => {
      gate.calls++;
      return new Promise<string>((_, reject) => {
        gate.release.push(() => reject(new Error('token held for test')));
      });
    },
  };
});

const CAL_SCOPE = 'openid https://www.googleapis.com/auth/calendar';

describe('two-way sync coalescing', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    gate.calls = 0;
    gate.release = [];
    db = await openTestDb();
  });

  afterEach(async () => {
    for (const r of gate.release.splice(0)) r();
    await closeTestDb(db);
  });

  it('runs one pass for overlapping callers, plus one follow-up', async () => {
    const uid = await createUser(db, 'alice');
    await db.updateTable('users').set({ refresh_token_scopes: CAL_SCOPE }).where('id', '=', uid).execute();

    const runs = [syncTwoWay(db, uid), syncTwoWay(db, uid), syncTwoWay(db, uid)];
    for (const r of runs) r.catch(() => {});
    expect(await waitFor(() => gate.calls >= 1)).toBe(true);
    // Overlapping passes would each reach the token step; give them the time.
    expect(await waitFor(() => gate.calls >= 2, 2_000)).toBe(false);

    gate.release.shift()!();
    expect(await waitFor(() => gate.calls >= 2)).toBe(true);
    gate.release.shift()!();
    await Promise.allSettled(runs);
    expect(gate.calls).toBe(2);
  });

  it('throttles the calendar screen focus instead of syncing on every one', async () => {
    const uid = await createUser(db, 'bob');
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: CAL_SCOPE, google_calendar_synced_at: new Date().toISOString() })
      .where('id', '=', uid)
      .execute();
    // The route's 730-day call; synced a moment ago, so nothing should start.
    const throttle = meEventsSyncThrottleMs(730);
    expect(throttle).toBeGreaterThan(0);
    await maybeSyncCalendar(db, uid, throttle, 730);
    expect(gate.calls).toBe(0);
  });
});
