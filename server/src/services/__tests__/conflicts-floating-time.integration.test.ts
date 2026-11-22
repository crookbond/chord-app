/**
 * A floating event time (no offset, e.g. from an .ics file with no zone) is
 * wall time in the USER's zone.
 *
 * Failure being fixed: conflicts.service read stored times with `Date.parse`,
 * which reads a floating value in the SERVER's zone (UTC in prod). For a user
 * in India a floating 3:00 PM event became 3:00 PM UTC - 8:30 PM their time -
 * so a meeting booked at 3:15 PM their time was reported free: no conflict
 * nudge, and `get_my_availability` / the reply drafter offered a busy slot.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { busyIntervalsInWindow, computeConflicts } from '@/services/conflicts.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';

const TZ = 'Asia/Kolkata'; // +05:30, never the server's zone here or in prod
const DAY = '2026-11-05';

describe('conflicts - floating event times', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'ada');
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', uid).execute();
    gid = (await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid })).id;
    // 3:00-4:00 PM India time, stored floating.
    await createEvent(db, {
      groupId: gid,
      title: 'School pickup',
      startsAt: `${DAY}T15:00:00`,
      endsAt: `${DAY}T16:00:00`,
      createdBy: uid,
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a meeting at 3:15 PM India time clashes with the floating 3:00 PM event', async () => {
    // 3:15-4:15 PM India = 09:45-10:45 UTC.
    const conflicts = await computeConflicts(db, {
      userId: uid,
      startIso: `${DAY}T09:45:00Z`,
      endIso: `${DAY}T10:45:00Z`,
    });
    expect(conflicts.map((c) => c.title)).toEqual(['School pickup']);
  });

  it('a meeting at 8:30 PM India time does not clash with it', async () => {
    // 8:30-9:30 PM India = 15:00-16:00 UTC, where the server-zone reading put it.
    const conflicts = await computeConflicts(db, {
      userId: uid,
      startIso: `${DAY}T15:00:00Z`,
      endIso: `${DAY}T16:00:00Z`,
    });
    expect(conflicts).toEqual([]);
  });

  it('a floating new event is read in the user zone too', async () => {
    // The event-created nudge passes the stored (floating) start straight in.
    const conflicts = await computeConflicts(db, {
      userId: uid,
      startIso: `${DAY}T15:30:00`,
      endIso: `${DAY}T16:30:00`,
    });
    expect(conflicts.map((c) => c.title)).toEqual(['School pickup']);
  });

  it('the busy block sits at 09:30-10:30 UTC', async () => {
    const { intervals } = await busyIntervalsInWindow(db, {
      userId: uid,
      startIso: `${DAY}T00:00:00Z`,
      endIso: `${DAY}T23:59:00Z`,
    });
    expect(intervals).toEqual([
      { startMs: Date.parse(`${DAY}T09:30:00Z`), endMs: Date.parse(`${DAY}T10:30:00Z`) },
    ]);
  });
});
