/**
 * `events.starts_at` is text in three shapes - UTC "…Z" (REST, .ics timed),
 * the event's own offset (Google pull, bot create_event) and floating
 * "…T00:00:00" (all-day, ADR 0040). Comparing the raw strings:
 *   - dropped a floating all-day event on the first day of a find_events range
 *     (it is a prefix of the "…T00:00:00.000Z" bound, so it sorts below it);
 *   - bucketed a 9pm New York event stored as "01:00Z" into the next day;
 *   - made findNearestEvent skip a "10:00-04:00" event two hours ahead of a
 *     "12:00Z" now as already past.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent, findNearestEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function inOffset(ms: number, offsetHours: number): string {
  const sign = offsetHours < 0 ? '-' : '+';
  const hh = String(Math.abs(offsetHours)).padStart(2, '0');
  return new Date(ms + offsetHours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, `${sign}${hh}:00`);
}

describe('event start times compared as instants', () => {
  let db: Kysely<DB>;
  let uid: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice');
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('find_events returns a day’s all-day event and its late-evening UTC-stored event', async () => {
    await createEvent(db, { groupId, createdBy: uid, title: 'Picture day', startsAt: '2026-10-15T00:00:00' });
    // 9pm New York on the 15th, stored in UTC as the 16th.
    await createEvent(db, { groupId, createdBy: uid, title: 'Dinner', startsAt: '2026-10-16T01:00:00.000Z' });
    // 9pm New York on the 14th - must NOT land on the 15th.
    await createEvent(db, { groupId, createdBy: uid, title: 'Night before', startsAt: '2026-10-15T01:00:00.000Z' });

    const result = await applyToolCall(db, {
      groupId,
      actorUserId: uid,
      provenance: null,
      tz: 'America/New_York',
      tzOffset: '-04:00',
      call: { name: 'find_events', args: { startDate: '2026-10-15', endDate: '2026-10-15' } },
    });
    const titles = (result.data as { events: { title: string }[] }).events.map((e) => e.title);
    expect(titles).toEqual(['Picture day', 'Dinner']);
  });

  it('findNearestEvent picks the event two hours out, stored in its own offset', async () => {
    const now = Date.now();
    await createEvent(db, {
      groupId,
      createdBy: uid,
      title: 'Soon',
      startsAt: inOffset(now + 2 * 3_600_000, -4),
    });
    await createEvent(db, {
      groupId,
      createdBy: uid,
      title: 'Later',
      startsAt: new Date(now + 5 * 3_600_000).toISOString(),
    });
    const next = await findNearestEvent(db, groupId, new Date(now).toISOString());
    expect(next?.title).toBe('Soon');
  });
});
