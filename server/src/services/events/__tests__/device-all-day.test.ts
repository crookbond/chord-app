import { describe, expect, it } from 'vitest';

import { allDayEndDate, allDayStartDate, sameEventStart } from '../device-all-day.js';

describe('allDayStartDate', () => {
  it.each([
    ['2026-07-04T00:00:00', 'America/New_York', '2026-07-04'], // floating (Google/Outlook)
    ['2026-07-04', 'America/New_York', '2026-07-04'],
    ['2026-07-04T04:00:00.000Z', 'America/New_York', '2026-07-04'], // iPhone, west
    ['2026-07-03T18:30:00.000Z', 'Asia/Kolkata', '2026-07-04'], // iPhone, east
    ['2026-07-03T10:00:00.000Z', 'Pacific/Kiritimati', '2026-07-04'], // +14
    ['2026-07-04T00:00:00.000Z', 'America/Los_Angeles', '2026-07-04'], // Android
    ['2026-07-04T00:00:00.000Z', 'Asia/Tokyo', '2026-07-04'], // Android
    ['2026-07-04T04:00:00.000Z', null, '2026-07-04'], // zone unknown
    ['2026-07-03T18:30:00.000Z', null, '2026-07-04'],
  ])('%s in %s is %s', (iso, tz, want) => {
    expect(allDayStartDate(iso, tz)).toBe(want);
  });
});

describe('allDayEndDate (exclusive)', () => {
  it.each([
    ['2026-07-05T00:00:00', 'America/New_York', '2026-07-05'],
    ['2026-07-05T03:59:59.000Z', 'America/New_York', '2026-07-05'], // iPhone 23:59:59
    ['2026-07-05T04:00:00.000Z', 'America/New_York', '2026-07-05'], // iPhone next midnight
    ['2026-07-04T18:29:59.000Z', 'Asia/Kolkata', '2026-07-05'],
    ['2026-07-05T00:00:00.000Z', 'America/New_York', '2026-07-05'], // Android
    ['2026-07-05T03:59:59.000Z', null, '2026-07-05'],
  ])('%s in %s ends before %s', (iso, tz, want) => {
    expect(allDayEndDate(iso, tz)).toBe(want);
  });
});

describe('sameEventStart', () => {
  it('compares all-day events by date and timed ones by instant', () => {
    const google = { startsAt: '2026-07-04T00:00:00', allDay: true };
    expect(sameEventStart({ startsAt: '2026-07-03T18:30:00.000Z', allDay: true }, google, 'Asia/Kolkata')).toBe(true);
    expect(sameEventStart({ startsAt: '2026-07-04T00:00:00.000Z', allDay: true }, google, 'America/New_York')).toBe(true);
    expect(sameEventStart({ startsAt: '2026-07-05T04:00:00.000Z', allDay: true }, google, 'America/New_York')).toBe(false);
    expect(sameEventStart({ startsAt: '2026-07-04T00:00:00.000Z', allDay: false }, google, 'UTC')).toBe(false);
    expect(
      sameEventStart(
        { startsAt: '2026-07-23T20:00:00.000Z', allDay: false },
        { startsAt: '2026-07-23T16:00:00-04:00', allDay: false },
        'America/New_York',
      ),
    ).toBe(true);
  });
});
