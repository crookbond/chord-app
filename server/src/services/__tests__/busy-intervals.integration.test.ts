/**
 * `busyIntervalsInWindow` feeds email-magics availability (bug 6). It answers a
 * different question from `computeConflicts` — every block across a window,
 * rather than clashes with one slot — but must agree with it on what "busy"
 * MEANS, so the times an email suggestion offers match what `find_conflicts`
 * would say. Free events (all-day, transparent, <5-min) never block, and
 * info-only calendars never do either.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { busyIntervalsInWindow } from '@/services/conflicts.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('busyIntervalsInWindow', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const dayAhead = (days: number, hour: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };

  const window = () => ({
    startIso: new Date().toISOString(),
    endIso: dayAhead(12, 0),
  });

  it('returns a blocking event as an interval, defaulting a missing end to an hour', async () => {
    const uid = await createUser(db, 'busy-user');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
    const startsAt = dayAhead(2, 15);
    await createEvent(db, { groupId: group.id, title: 'Standup', startsAt, createdBy: uid });

    const { intervals, truncated } = await busyIntervalsInWindow(db, { userId: uid, ...window() });

    expect(truncated).toBe(false);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].endMs - intervals[0].startMs).toBe(60 * 60 * 1000);
  });

  it('an all-day event is free time, not a block', async () => {
    const uid = await createUser(db, 'allday-user');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'Company holiday',
      startsAt: dayAhead(3, 0),
      allDay: true,
      createdBy: uid,
    });

    const { intervals } = await busyIntervalsInWindow(db, { userId: uid, ...window() });
    expect(intervals).toEqual([]);
  });

  it('an info-only calendar never blocks — same rule find_conflicts applies', async () => {
    const uid = await createUser(db, 'info-cal-user');
    const group = await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid });
    await upsertCalendarSource(db, uid, {
      googleCalendarId: 'soccer@info',
      summary: 'Kids soccer',
      accessRole: 'reader',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Sam soccer game',
      startsAt: dayAhead(4, 17),
      createdBy: uid,
      externalUid: 'gcal:soccer@info:evt1',
    });

    const { intervals } = await busyIntervalsInWindow(db, { userId: uid, ...window() });
    expect(intervals).toEqual([]);
  });

  it('another user’s calendar is invisible', async () => {
    const mine = await createUser(db, 'mine');
    const other = await createUser(db, 'other');
    const theirGroup = await createGroup(db, {
      name: 'Personal',
      kind: 'personal',
      createdBy: other,
    });
    await createEvent(db, {
      groupId: theirGroup.id,
      title: 'Their meeting',
      startsAt: dayAhead(2, 15),
      createdBy: other,
    });

    const { intervals } = await busyIntervalsInWindow(db, { userId: mine, ...window() });
    expect(intervals).toEqual([]);
  });
});
