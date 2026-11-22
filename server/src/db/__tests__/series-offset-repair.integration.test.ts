/**
 * Migration 135: repeating-event occurrences that the old one-pass offset
 * conversion stored with the wrong offset around a clock change. A weekly
 * Sunday 8:00 Los Angeles event's occurrence on 14 Mar 2027 (clocks spring
 * forward at 2:00) was written as 08:00-08:00, which is 9:00 PDT.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { repairedOffset, repairSeriesOffsets } from '@/db/series-offset-repair.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const LA = 'America/Los_Angeles';

describe('repairedOffset', () => {
  it('fixes exactly what the old conversion wrote', () => {
    expect(repairedOffset('2027-03-14T08:00:00-08:00', LA)).toBe('2027-03-14T08:00:00-07:00');
    expect(repairedOffset('2026-11-01T08:00:00-07:00', LA)).toBe('2026-11-01T08:00:00-08:00');
  });

  it('leaves a correct value, another shape, and an offset the old code never gave', () => {
    expect(repairedOffset('2027-03-14T08:00:00-07:00', LA)).toBeNull();
    expect(repairedOffset('2027-03-14T16:00:00.000Z', LA)).toBeNull();
    expect(repairedOffset('2027-03-14T00:00:00', LA)).toBeNull();
    // 12:00 is far from the change: both conversions agree, nothing to fix.
    expect(repairedOffset('2027-03-14T12:00:00-07:00', LA)).toBeNull();
    // Wrong, but not the bug's wrong (an edit in another zone): not ours to touch.
    expect(repairedOffset('2027-03-14T08:00:00-05:00', LA)).toBeNull();
  });
});

describe('repairSeriesOffsets', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'weekly');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('restores the clock-change occurrence and touches nothing else', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: LA,
      tzOffset: '-07:00',
      call: {
        name: 'create_event',
        args: {
          title: 'Sunday swim',
          startsAt: '2027-03-14T08:00:00-07:00',
          endsAt: '2027-03-14T09:00:00-07:00',
          repeat: { frequency: 'weekly', weekdays: ['SU'], count: 3 },
          confirmPast: true,
        },
      } as never,
    });
    const rows = await db
      .selectFrom('events')
      .select(['id', 'starts_at', 'ends_at', 'original_start'])
      .where('series_id', 'is not', null)
      .orderBy('starts_at')
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    const first = rows.find((r) => r.starts_at.startsWith('2027-03-14'))!;
    expect(first.starts_at).toBe('2027-03-14T08:00:00-07:00');
    // What the old conversion stored for this occurrence.
    await db
      .updateTable('events')
      .set({
        starts_at: '2027-03-14T08:00:00-08:00',
        ends_at: '2027-03-14T09:00:00-08:00',
        original_start: '2027-03-14T08:00:00-08:00',
      })
      .where('id', '=', first.id)
      .execute();
    const before = await db.selectFrom('events').selectAll().where('series_id', 'is not', null).execute();

    expect(await repairSeriesOffsets(db)).toBe(1);

    const after = await db.selectFrom('events').selectAll().where('series_id', 'is not', null).execute();
    const fixed = after.find((r) => r.id === first.id)!;
    expect(fixed.starts_at).toBe('2027-03-14T08:00:00-07:00');
    expect(fixed.ends_at).toBe('2027-03-14T09:00:00-07:00');
    expect(fixed.original_start).toBe('2027-03-14T08:00:00-07:00');
    for (const r of after.filter((x) => x.id !== first.id)) {
      expect(r).toEqual(before.find((b) => b.id === r.id));
    }
    // A second run has nothing left to do.
    expect(await repairSeriesOffsets(db)).toBe(0);
  });
});
