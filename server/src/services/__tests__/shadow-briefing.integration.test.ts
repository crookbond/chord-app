/**
 * ADR 0098 — a briefing is only ever scheduled for a real user.
 *
 * The incident: a signed-up user messaged the WhatsApp bot months after
 * signing up, which minted a taster shadow (ADR 0053) with its own personal
 * group. `seedDailyScan` qualified on "owns a personal group", so the shadow
 * got its own daily briefing — and since a shadow never opens a client, it has
 * no `last_tz`, so that briefing was timed off the server clock and landed at
 * midnight Pacific on a UTC VM.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import {
  rescheduleDailyScanForUser,
  seedDailyScan,
} from '@/services/proactive.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function pendingScans(db: Kysely<DB>, userId: string) {
  return db
    .selectFrom('proactive_messages')
    .select(['id', 'scheduled_for'])
    .where('kind', '=', 'daily_morning_scan')
    .where('persona_id', '=', userId)
    .where('fired_at', 'is', null)
    .execute();
}

/** A taster shadow: no `last_tz` (it has no client to report one) and a
 *  personal group, which `maybeTasterServe` creates so the bot can reply. */
async function createShadowWithPersonalGroup(db: Kysely<DB>): Promise<string> {
  const id = newId('u');
  await db
    .insertInto('users')
    .values({
      id,
      username: `whatsapp_whatsapp:+1555${id.slice(-6)}`,
      display_name: 'Taster',
      created_at: new Date().toISOString(),
      shadow: 1,
      nudge_enabled: 1,
    })
    .execute();
  await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: id });
  return id;
}

async function createRealWithPersonalGroup(db: Kysely<DB>, tz: string | null) {
  const id = await createUser(db, `real_${newId('u')}`);
  await createGroup(db, { name: 'My Chord', kind: 'personal', createdBy: id });
  await db
    .updateTable('users')
    .set({ last_tz: tz, nudge_hour: 7, nudge_minute: 0, nudge_enabled: 1 })
    .where('id', '=', id)
    .execute();
  return id;
}

describe('shadow users get no scheduled briefing', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('does not seed a briefing for a taster shadow that owns a personal group', async () => {
    const shadow = await createShadowWithPersonalGroup(db);

    await seedDailyScan(db);

    expect(await pendingScans(db, shadow)).toHaveLength(0);
  });

  it('a seed re-times a queued briefing that was an hour off on the clock-change morning', async () => {
    // 2026-10-31 evening in Los Angeles: tomorrow's briefing had been queued
    // at 14:00Z (6:00 PST) by the one-pass offset bug. The startup seed after
    // the fix must move it to 15:00Z (7:00 PST), not leave it or add a second.
    vi.useFakeTimers({ now: new Date('2026-10-31T20:00:00-07:00'), toFake: ['Date'] });
    try {
      const real = await createRealWithPersonalGroup(db, 'America/Los_Angeles');
      const group = await db
        .selectFrom('groups')
        .select('id')
        .where('created_by', '=', real)
        .where('kind', '=', 'personal')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('proactive_messages')
        .values({
          id: newId('pm'),
          group_id: group.id,
          persona_id: real,
          kind: 'daily_morning_scan',
          payload: JSON.stringify({ userId: real, scanDate: '2026-11-01' }),
          scheduled_for: '2026-11-01T14:00:00.000Z',
          fired_at: null,
          created_at: new Date().toISOString(),
        })
        .execute();

      await seedDailyScan(db);

      const rows = await pendingScans(db, real);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.scheduled_for).toBe('2026-11-01T15:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still seeds one for a real user in the same sweep', async () => {
    const shadow = await createShadowWithPersonalGroup(db);
    const real = await createRealWithPersonalGroup(db, 'America/Los_Angeles');

    await seedDailyScan(db);

    expect(await pendingScans(db, shadow)).toHaveLength(0);
    expect(await pendingScans(db, real)).toHaveLength(1);
  });

  /**
   * The gate lives in `enqueueDailyScanForUser`, not in `seedDailyScan`, so a
   * nudge-settings change can't put the row back through the other door.
   */
  it('does not re-queue one on a reschedule either', async () => {
    const shadow = await createShadowWithPersonalGroup(db);

    await rescheduleDailyScanForUser(db, shadow);

    expect(await pendingScans(db, shadow)).toHaveLength(0);
  });

  /**
   * Rows queued before this rule existed would still fire. The seed reconciles
   * them away so the deploy fixes production without a hand-run DELETE.
   */
  it('purges a briefing already queued for a shadow', async () => {
    const shadow = await createShadowWithPersonalGroup(db);
    const groupId = (
      await db
        .selectFrom('groups')
        .select('id')
        .where('created_by', '=', shadow)
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: groupId,
        persona_id: shadow,
        kind: 'daily_morning_scan',
        payload: JSON.stringify({ userId: shadow, scanDate: '2026-08-23' }),
        scheduled_for: '2026-08-23T07:00:00.000Z',
        fired_at: null,
        created_at: new Date().toISOString(),
      })
      .execute();
    expect(await pendingScans(db, shadow)).toHaveLength(1);

    await seedDailyScan(db);

    expect(await pendingScans(db, shadow)).toHaveLength(0);
  });

  it('leaves an already-fired shadow row alone — history is not rewritten', async () => {
    const shadow = await createShadowWithPersonalGroup(db);
    const groupId = (
      await db
        .selectFrom('groups')
        .select('id')
        .where('created_by', '=', shadow)
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('proactive_messages')
      .values({
        id: newId('pm'),
        group_id: groupId,
        persona_id: shadow,
        kind: 'daily_morning_scan',
        payload: JSON.stringify({ userId: shadow, scanDate: '2026-08-22' }),
        scheduled_for: '2026-08-22T07:00:00.000Z',
        fired_at: '2026-08-22T07:00:01.000Z',
        created_at: new Date().toISOString(),
      })
      .execute();

    await seedDailyScan(db);

    const all = await db
      .selectFrom('proactive_messages')
      .select('id')
      .where('persona_id', '=', shadow)
      .execute();
    expect(all).toHaveLength(1);
  });

  /**
   * A real user with no zone on file is mistimed, not excluded — deferring
   * until a zone appears would silence someone who has never opened a client.
   */
  it('still seeds a real user who has never reported a timezone', async () => {
    const real = await createRealWithPersonalGroup(db, null);

    await seedDailyScan(db);

    expect(await pendingScans(db, real)).toHaveLength(1);
  });
});
