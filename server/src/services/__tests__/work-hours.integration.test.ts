/**
 * ADR 0330 — "in suggested times, we treat sundays as free." The day lines
 * said "Sun, Nov 15: nothing scheduled" and the reply drafter offered Sunday.
 * Now every line leads with the work day (or NOT A WORK DAY), holidays come
 * off, the closest free work-hours times are worked out in code, and the user
 * can set their own hours in chat.
 */
import { DEFAULT_WORK_HOURS, describeWorkHours, usFederalHolidays, workDayOf } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { userAvailability } from '@/services/availability.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { getWorkHours, setWorkHours } from '@/services/work-hours.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
// Fri 13 Nov 2026, 3:00 PM EST.
const NOW = Date.parse('2026-11-13T15:00:00-05:00');

describe('the rules', () => {
  it('knows the 2026 US federal holidays as observed', () => {
    const h = usFederalHolidays(2026);
    expect(h.get('2026-11-26')).toBe('Thanksgiving Day');
    expect(h.get('2026-07-03')).toBe('Independence Day'); // 4 Jul is a Saturday
    expect(h.get('2026-05-25')).toBe('Memorial Day');
    expect(h.get('2026-01-19')).toBe('Martin Luther King Jr. Day');
    expect(usFederalHolidays(2027).get('2027-12-31')).toBe("New Year's Day"); // 1 Jan 2028 is a Saturday
  });

  it('a Sunday, a holiday and a non-US zone', () => {
    expect(workDayOf('2026-11-15', TZ, DEFAULT_WORK_HOURS)).toEqual({ work: false, reason: 'Sunday' });
    expect(workDayOf('2026-11-26', TZ, DEFAULT_WORK_HOURS)).toEqual({ work: false, reason: 'holiday: Thanksgiving Day' });
    expect(workDayOf('2026-11-26', 'Europe/London', DEFAULT_WORK_HOURS).work).toBe(true);
    expect(describeWorkHours(DEFAULT_WORK_HOURS)).toBe('Mon–Fri, 9:00 AM–5:00 PM, public holidays off');
  });
});

describe('suggested times', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
    groupId = (await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: userId })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const busy = (title: string, from: string, to: string) =>
    createEvent(db, { groupId, title, startsAt: from, endsAt: to, createdBy: userId });

  it('a Sunday is not a work day and is never in the closest free times', async () => {
    // Friday afternoon is booked to the end of the day, so the old reading
    // made the weekend the "next free" time.
    await busy('Offsite', '2026-11-13T15:00:00-05:00', '2026-11-13T17:00:00-05:00');
    const avail = await userAvailability(db, userId, { nowMs: NOW, days: 4 });
    const lines = avail.text.split('\n');
    expect(lines[1]).toBe('Sat, Nov 14: NOT A WORK DAY (Saturday); nothing scheduled');
    expect(lines[2]).toBe('Sun, Nov 15: NOT A WORK DAY (Sunday); nothing scheduled');
    expect(lines[3]).toBe('Mon, Nov 16: work hours 9:00 AM–5:00 PM, free in work hours: 9:00 AM–5:00 PM; nothing scheduled');
    expect(lines[0]).toContain('work hours 9:00 AM–5:00 PM, free in work hours: none');
    expect(avail.nextFreeText).toContain('Mon, Nov 16 at 9:00 AM');
    expect(avail.nextFreeText).not.toMatch(/Sat|Sun/);
    expect(avail.workHoursText).toBe(
      'Work hours: Mon–Fri, 9:00 AM–5:00 PM, public holidays off (the default; the user has not said theirs).',
    );
  });

  it('Thanksgiving is skipped', async () => {
    const wed = Date.parse('2026-11-25T16:30:00-05:00');
    const avail = await userAvailability(db, userId, { nowMs: wed, days: 3 });
    expect(avail.text.split('\n')[1]).toBe('Thu, Nov 26: NOT A WORK DAY (holiday: Thanksgiving Day); nothing scheduled');
    expect(avail.nextFreeText).toContain('Fri, Nov 27 at 9:00 AM');
    expect(avail.nextFreeText).not.toContain('Nov 26');
  });

  it('an asked time that is busy gets the closest free times after it, soonest first, one per gap', async () => {
    await busy('Standup', '2026-11-16T10:00:00-05:00', '2026-11-16T11:00:00-05:00');
    await busy('Lunch', '2026-11-16T12:00:00-05:00', '2026-11-16T13:00:00-05:00');
    const avail = await userAvailability(db, userId, {
      nowMs: NOW,
      askedSlots: [{ day: '2026-11-16', minutes: 10 * 60 }],
    });
    expect(avail.askedSlotsText).toContain('Mon, Nov 16 at 10:00 AM: BUSY');
    expect(avail.nextFreeText).toBe(
      'Closest free times in work hours (60 min each, soonest first): Mon, Nov 16 at 11:00 AM; Mon, Nov 16 at 1:00 PM; Tue, Nov 17 at 9:00 AM',
    );
  });

  it('a Sunday time the sender asked about keeps its verdict and says it is outside work hours', async () => {
    const avail = await userAvailability(db, userId, {
      nowMs: NOW,
      askedSlots: [{ day: '2026-11-15', minutes: 11 * 60 }],
    });
    expect(avail.askedSlotsText).toMatch(/^Sun, Nov 15 at 11:00 AM: FREE .*; OUTSIDE WORK HOURS \(not a work day: Sunday\)$/);
  });

  it('the user sets their own hours in chat, and suggestions follow', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    const call = (args: Record<string, unknown>) =>
      applyToolCall(db, { groupId: personal.id, actorUserId: userId, provenance: 'test', call: { name: 'set_work_hours', args } });

    const read = await call({});
    expect(read.data).toMatchObject({ ok: true, read: true, isDefault: true });

    const set = await call({ days: ['mon', 'tue', 'wed', 'thu'], start: '08:00', end: '16:00' });
    expect(set.data).toMatchObject({ ok: true, workHours: 'Mon–Thu, 8:00 AM–4:00 PM, public holidays off' });

    // Only what was said changes.
    await call({ observeHolidays: false });
    const { hours } = await getWorkHours(db, userId);
    expect(hours).toEqual({ days: [1, 2, 3, 4], startMinutes: 480, endMinutes: 960, observeHolidays: false });

    const avail = await userAvailability(db, userId, { nowMs: NOW, days: 4 });
    expect(avail.text.split('\n')[0]).toContain('NOT A WORK DAY (Friday)');
    expect(avail.nextFreeText).toContain('Mon, Nov 16 at 8:00 AM');

    const bad = await call({ start: '17:00', end: '09:00' });
    expect(bad.data).toMatchObject({ ok: false, reason: 'end_before_start', changed: false });
  });

  it('is personal chat only', async () => {
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });
    const r = await applyToolCall(db, {
      groupId: family.id,
      actorUserId: userId,
      provenance: 'test',
      call: { name: 'set_work_hours', args: { start: '07:00' } },
    });
    expect(r.data).toMatchObject({ ok: false, reason: 'personal_only' });
    expect((await getWorkHours(db, userId)).isDefault).toBe(true);
    expect(await setWorkHours(db, userId, { days: ['funday'] })).toMatchObject({ ok: false, reason: 'bad_day' });
  });
});
