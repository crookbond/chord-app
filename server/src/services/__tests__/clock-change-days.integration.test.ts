/**
 * Days stepped as 24 hours of time instead of as calendar dates (found in the
 * 2026-10-31 sweep after the briefing clock-change bug). A local day is 23 or
 * 25 hours long when the clocks change, so "now + 24h":
 *   - skipped a day (spring) or walked the same day twice (fall) in the free
 *     times offered for a "reply with times" to-do;
 *   - ended "the day" an hour early or late (events on a named day, a
 *     receipts total ending on a date, the availability busy window);
 *   - put the availability window's last day one past the days it listed.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { userAvailability } from '@/services/availability.service.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { openSlotsFrom } from '@/services/email/magics-context.js';
import { zonedDayEndUtc } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const LA = 'America/Los_Angeles';
const localDay = (ms: number) => new Date(ms).toLocaleString('sv-SE', { timeZone: LA }).slice(0, 10);

describe('a local day ends at its own next midnight', () => {
  it('the 25-hour fall-back day', () => {
    expect(zonedDayEndUtc('2026-11-01', LA).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });
  it('the 23-hour spring-forward day', () => {
    expect(zonedDayEndUtc('2027-03-14', LA).toISOString()).toBe('2027-03-15T07:00:00.000Z');
  });
});

describe('free times walk calendar days', () => {
  it('the fall-back night does not walk Nov 1 twice', () => {
    // Sun 1 Nov 2026, 00:30 PDT. The 24h lead keeps Nov 1 itself out.
    const nowMs = Date.parse('2026-11-01T00:30:00-07:00');
    const slots = openSlotsFrom([], { nowMs, tz: LA, days: 4, cap: 5 });
    expect(slots.map((s) => localDay(s.startMs))).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });

  it('the spring-forward night does not skip Mar 14', () => {
    // Sat 13 Mar 2027, 23:30 PST: the days walked are 13, 14, 15.
    const nowMs = Date.parse('2027-03-13T23:30:00-08:00');
    const slots = openSlotsFrom([], { nowMs, tz: LA, days: 3, cap: 5 });
    expect(slots.map((s) => localDay(s.startMs))).toEqual(['2027-03-15']);
  });
});

describe('availability window across a clock change', () => {
  let db: Kysely<DB>;
  let userId: string;
  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'clockchange');
    await db.updateTable('users').set({ last_tz: LA }).where('id', '=', userId).execute();
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary@cal',
      summary: 'Me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('a day asked about just past the window still gets its own line', async () => {
    // Sat 13 Mar 2027, 23:30 PST, ten days: Mar 13-22 are listed. Mar 23 is
    // past the window and is asked about, so it must get a line of its own.
    // 24h steps put the window's end on Mar 23 and the line was never written.
    const avail = await userAvailability(db, userId, {
      nowMs: Date.parse('2027-03-13T23:30:00-08:00'),
      days: 10,
      alsoDays: ['2027-03-23'],
    });
    expect(avail.text).toContain('Mar 22');
    expect(avail.text).not.toContain('Mar 23');
    expect(avail.askedDaysText ?? '').toContain('Mar 23');
  });
});
