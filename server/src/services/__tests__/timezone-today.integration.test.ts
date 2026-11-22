/**
 * "Today" and "still on" are the user's, not the server's.
 *
 * Failures being fixed (each case below fails on the code before this fix):
 *  - find_events (the chat tool and the morning briefing's own) kept only
 *    events STARTING inside the range, so "what's on Thursday" missed a
 *    multi-day visit that began on Tuesday.
 *  - findNearestEvent (record_rsvp / get_event_status default) skipped the
 *    meeting happening right now.
 *  - An email cancelling today's all-day event, or a meeting under way, was
 *    skipped as "past": its start was read as UTC midnight / compared to now.
 *  - Birthdays, the "current trip" and the trip the booking links use took
 *    today from the server clock (UTC): on a US evening a birthday today and
 *    a trip ending today had already gone.
 *  - The stale-to-do sweep compared remind_at as text, so a reminder still
 *    ahead, stored with a negative offset, sorted as past and the to-do was
 *    archived out from under it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { enrichExternalActionQuery } from '@/services/bot/external-actions-enrich.js';
import { applyEmailChanges } from '@/services/email/email-changes.service.js';
import type { ChangeSuggestion } from '@/services/email/magics.service.js';
import { createEvent, findNearestEvent } from '@/services/events.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addImportantDate, createPerson, listImportantDayOccurrences } from '@/services/people.service.js';
import { __testing as proactive, drainOnce } from '@/services/proactive.service.js';
import { createTask } from '@/services/tasks.service.js';
import { createTrip, pickActiveTrip } from '@/services/trips.service.js';
import { svWall } from '@/utils/tz.js';

const NY = 'America/New_York';
const HONOLULU = 'Pacific/Honolulu'; // behind this New York machine AND the UTC server

let db: Kysely<DB>;
let uid: string;
let gid: string;

async function setZone(tz: string): Promise<void> {
  await db.updateTable('users').set({ last_tz: tz }).where('id', '=', uid).execute();
}

beforeEach(async () => {
  db = await openTestDb();
  uid = await createUser(db, 'ada');
  gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  await setZone(NY);
});

afterEach(async () => {
  vi.useRealTimers();
  await closeTestDb(db);
});

describe('find_events reads overlap, not start', () => {
  beforeEach(async () => {
    // Tue 3 - Sat 7 Nov, all day.
    await createEvent(db, {
      groupId: gid,
      title: 'Grandma visiting',
      startsAt: '2026-11-03T00:00:00',
      endsAt: '2026-11-08T00:00:00',
      createdBy: uid,
    });
    // Mon 2 Nov only (exclusive end at Tuesday midnight).
    await createEvent(db, {
      groupId: gid,
      title: 'Teacher day',
      startsAt: '2026-11-02T00:00:00',
      endsAt: '2026-11-03T00:00:00',
      createdBy: uid,
    });
  });

  it('the chat tool finds a visit that began two days earlier', async () => {
    const res = await applyToolCall(db, {
      groupId: gid,
      actorUserId: uid,
      provenance: null,
      call: { name: 'find_events', args: { startDate: '2026-11-05', endDate: '2026-11-05' } },
    });
    const titles = (res.data as { events: { title: string }[] }).events.map((e) => e.title);
    expect(titles).toEqual(['Grandma visiting']);
  });

  it('the chat tool leaves out an all-day event that ended at the range start', async () => {
    const res = await applyToolCall(db, {
      groupId: gid,
      actorUserId: uid,
      provenance: null,
      call: { name: 'find_events', args: { startDate: '2026-11-03', endDate: '2026-11-03' } },
    });
    const titles = (res.data as { events: { title: string }[] }).events.map((e) => e.title);
    expect(titles).toEqual(['Grandma visiting']);
  });

  it("the briefing's own find_events finds it too", async () => {
    const res = await proactive.executeScanTool(db, uid, {
      name: 'find_events',
      args: { startDate: '2026-11-05', endDate: '2026-11-05' },
    });
    expect((res.events as Array<{ title: string }>).map((e) => e.title)).toEqual(['Grandma visiting']);
  });
});

describe('the event happening now', () => {
  it('findNearestEvent returns the meeting under way, not tomorrow', async () => {
    const now = Date.now();
    await createEvent(db, {
      groupId: gid,
      title: 'Board meeting',
      startsAt: new Date(now - 30 * 60_000).toISOString(),
      endsAt: new Date(now + 60 * 60_000).toISOString(),
      createdBy: uid,
    });
    await createEvent(db, {
      groupId: gid,
      title: 'Dentist',
      startsAt: new Date(now + 26 * 3600_000).toISOString(),
      createdBy: uid,
    });
    const nearest = await findNearestEvent(db, gid, new Date(now).toISOString(), NY);
    expect(nearest?.title).toBe('Board meeting');
  });
});

describe('an email changing something today', () => {
  // 7 PM on Thursday 5 Nov in New York (00:00 UTC on the 6th).
  const NOW = Date.parse('2026-11-06T00:00:00Z');

  async function change(eventId: string, title: string, at: string) {
    const personal = (await ensurePersonalGroup(db, uid)).id;
    return applyEmailChanges(db, {
      userId: uid,
      personalGroupId: personal,
      userTz: NY,
      provenance: 'gmail:thr-today',
      changes: [{ kind: 'change', target: 'e1', action: 'remove' } as ChangeSuggestion],
      targets: new Map([['e1', { kind: 'event', id: eventId, seriesId: null, title, at }]]),
      nowMs: NOW,
    });
  }

  it("cancelling today's all-day event is offered, not skipped as past", async () => {
    const ev = await createEvent(db, {
      groupId: gid,
      title: 'Water shut-off',
      startsAt: '2026-11-05T00:00:00',
      endsAt: '2026-11-06T00:00:00',
      createdBy: uid,
    });
    const out = await change(ev.id, ev.title, ev.startsAt);
    expect(out.skipped).toEqual([]);
    expect(out.staged).toBe(1);
  });

  it('cancelling a meeting under way is offered', async () => {
    const ev = await createEvent(db, {
      groupId: gid,
      title: 'Parent evening',
      startsAt: '2026-11-05T18:00:00-05:00',
      endsAt: '2026-11-05T20:00:00-05:00',
      createdBy: uid,
    });
    const out = await change(ev.id, ev.title, ev.startsAt);
    expect(out.staged).toBe(1);
  });

  it('a meeting that already ended is still skipped as past', async () => {
    const ev = await createEvent(db, {
      groupId: gid,
      title: 'Lunch',
      startsAt: '2026-11-05T12:00:00-05:00',
      endsAt: '2026-11-05T13:00:00-05:00',
      createdBy: uid,
    });
    const out = await change(ev.id, ev.title, ev.startsAt);
    expect(out.skipped.map((s) => s.reason)).toEqual(['past']);
  });
});

describe("today on a US evening (it is already tomorrow in UTC)", () => {
  // 7 PM Thursday 22 Oct in Honolulu = 05:00 UTC Friday 23 = 1 AM Friday in New York.
  const EVENING = new Date('2026-10-23T05:00:00Z');

  beforeEach(async () => {
    await setZone(HONOLULU);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING);
  });

  it("today's birthday is still listed", async () => {
    const person = await createPerson(db, { ownerUserId: uid, displayName: 'Ben' });
    await addImportantDate(db, { personId: person.id, kind: 'birthday', date: '2015-10-22', recurs: true });
    const days = await listImportantDayOccurrences(db, uid, 30);
    expect(days.map((d) => d.on)).toEqual(['2026-10-22']);
  });

  async function twoTrips() {
    const base = { groupId: gid, createdBy: uid, participantIds: [] };
    await createTrip(db, { ...base, name: 'Maui', destination: 'Maui', startDate: '2026-10-18', endDate: '2026-10-22' });
    await createTrip(db, { ...base, name: 'Denver', destination: 'Denver', startDate: '2026-11-10', endDate: '2026-11-14' });
  }

  it('the trip ending today is the current trip', async () => {
    await twoTrips();
    expect((await pickActiveTrip(db, gid, HONOLULU))?.name).toBe('Maui');
  });

  it('a flight search link is filled from the trip ending today', async () => {
    await twoTrips();
    const q = await enrichExternalActionQuery(db, { groupId: gid, userId: uid }, 'flight', {});
    expect(q.destination).toBe('Maui');
  });
});

describe('the stale to-do sweep', () => {
  it('keeps an overdue to-do whose reminder is still ahead, stored with a negative offset', async () => {
    const now = Date.now();
    const task = await createTask(db, {
      groupId: gid,
      title: 'Renew car registration',
      createdBy: uid,
      dueAt: new Date(now - 20 * 86400_000).toISOString(),
    });
    // One hour from now, written in Honolulu's offset: the text sorts BEFORE
    // now's "...Z" string although the instant is after it.
    const remindAt = `${svWall(new Date(now + 3600_000), HONOLULU).replace(' ', 'T')}-10:00`;
    await db.updateTable('tasks').set({ remind_at: remindAt }).where('id', '=', task.id).execute();
    expect(remindAt < new Date(now).toISOString()).toBe(true);

    await drainOnce(db);

    const row = await db.selectFrom('tasks').select(['status']).where('id', '=', task.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('open');
  });
});
