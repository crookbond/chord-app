/**
 * The daily briefing must follow the user when they travel.
 *
 * Two defects made a NY → Nairobi → NY trip mis-time the briefing in both
 * directions: `users.last_tz` was written only when the user posted a chat
 * message, and even once it changed, the already-queued row was never re-timed
 * (the enqueue deduped on a `scanDate` computed in *server*-local time, so it
 * returned early). `recordUserTimezone` closes both.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  nextScanDate,
  recordUserTimezone,
  rescheduleDailyScanForUser,
  seedDailyScan,
} from '@/services/proactive.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const NY = 'America/New_York';
const NAIROBI = 'Africa/Nairobi';

/** Wall clock the pending briefing lands on, rendered in `tz`. */
async function pendingWallClock(
  db: Kysely<DB>,
  userId: string,
  tz: string,
): Promise<string | null> {
  const rows = await pendingRows(db, userId);
  if (rows.length !== 1) return null;
  return new Date(rows[0].scheduled_for).toLocaleString('sv-SE', { timeZone: tz });
}

async function pendingRows(db: Kysely<DB>, userId: string) {
  return db
    .selectFrom('proactive_messages')
    .select(['id', 'scheduled_for', 'payload'])
    .where('kind', '=', 'daily_morning_scan')
    .where('persona_id', '=', userId)
    .where('fired_at', 'is', null)
    .execute();
}

async function setupUser(db: Kysely<DB>, tz: string): Promise<string> {
  const uid = await createUser(db, 'traveller');
  await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
  await db
    .updateTable('users')
    .set({ last_tz: tz, nudge_hour: 7, nudge_minute: 0, nudge_enabled: 1 })
    .where('id', '=', uid)
    .execute();
  await rescheduleDailyScanForUser(db, uid);
  return uid;
}

describe('timezone travel — the briefing follows the user', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('re-times the pending briefing when the zone changes', async () => {
    const uid = await setupUser(db, NY);
    expect(await pendingWallClock(db, uid, NY)).toMatch(/ 07:00:00$/);

    const changed = await recordUserTimezone(db, uid, NAIROBI);

    expect(changed).toBe(true);
    expect(await pendingWallClock(db, uid, NAIROBI)).toMatch(/ 07:00:00$/);
  });

  it('re-times again on the return leg', async () => {
    const uid = await setupUser(db, NY);
    await recordUserTimezone(db, uid, NAIROBI);

    expect(await recordUserTimezone(db, uid, NY)).toBe(true);
    expect(await pendingWallClock(db, uid, NY)).toMatch(/ 07:00:00$/);
  });

  it('leaves exactly one pending briefing after a zone change', async () => {
    const uid = await setupUser(db, NY);
    await recordUserTimezone(db, uid, NAIROBI);

    expect(await pendingRows(db, uid)).toHaveLength(1);
  });

  it('is a no-op when the reported zone is unchanged', async () => {
    const uid = await setupUser(db, NY);
    const before = await pendingRows(db, uid);

    expect(await recordUserTimezone(db, uid, NY)).toBe(false);

    const after = await pendingRows(db, uid);
    expect(after).toHaveLength(1);
    // Same row, untouched — an unchanged zone must not churn the schedule.
    expect(after[0].id).toBe(before[0].id);
  });

  it('rejects a malformed zone rather than poisoning last_tz', async () => {
    const uid = await setupUser(db, NY);

    expect(await recordUserTimezone(db, uid, 'Not/A_Zone')).toBe(false);

    const row = await db
      .selectFrom('users')
      .select('last_tz')
      .where('id', '=', uid)
      .executeTakeFirst();
    expect(row?.last_tz).toBe(NY);
    expect(await pendingWallClock(db, uid, NY)).toMatch(/ 07:00:00$/);
  });

  it('does not queue a second briefing when the user has nudges off', async () => {
    const uid = await setupUser(db, NY);
    await db.updateTable('users').set({ nudge_enabled: 0 }).where('id', '=', uid).execute();

    await recordUserTimezone(db, uid, NAIROBI);

    expect(await pendingRows(db, uid)).toHaveLength(0);
  });

  it('keys the dedup on the user day, so re-seeding does not double up', async () => {
    const uid = await setupUser(db, NAIROBI);

    // Same-zone re-seed must find the existing row regardless of how the
    // server's own day compares to the user's.
    await rescheduleDailyScanForUser(db, uid);

    expect(await pendingRows(db, uid)).toHaveLength(1);
  });

  it('does not double-brief a row whose key was computed in another zone', async () => {
    // The boot seed does NOT delete first, so it is the path where a row
    // carrying a stale key (queued before this fix, or before the user
    // travelled) could produce a second briefing for the same local day.
    const uid = await createUser(db, 'traveller');
    const g = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
    await db
      .updateTable('users')
      .set({ last_tz: NAIROBI, nudge_hour: 7, nudge_minute: 0, nudge_enabled: 1 })
      .where('id', '=', uid)
      .execute();

    const landsAt = nextScanDate(NAIROBI, 7, 0);
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: g.id,
        persona_id: uid,
        kind: 'daily_morning_scan',
        // Key from a different zone — must not defeat the dedup.
        payload: JSON.stringify({ userId: uid, scanDate: '1999-01-01' }),
        scheduled_for: landsAt,
        fired_at: null,
        created_at: new Date().toISOString(),
      })
      .execute();

    await seedDailyScan(db);

    expect(await pendingRows(db, uid)).toHaveLength(1);
  });
});
