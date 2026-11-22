import { describe, expect, it } from 'vitest';

import { eventLocalDays, instantInZoneMs } from '@/utils/tz.js';

const NY = 'America/New_York';

describe('eventLocalDays', () => {
  it('treats an all-day end at midnight as exclusive', () => {
    expect(eventLocalDays('2026-10-22T00:00:00', '2026-10-23T00:00:00', NY)).toEqual({
      first: '2026-10-22',
      last: '2026-10-22',
    });
    expect(eventLocalDays('2026-10-21T00:00:00', '2026-10-24T00:00:00', NY)).toEqual({
      first: '2026-10-21',
      last: '2026-10-23',
    });
  });

  it('reads a zoned end on the user clock', () => {
    // 11pm-1am New York crosses into the 23rd.
    expect(eventLocalDays('2026-10-23T03:00:00Z', '2026-10-23T05:00:00Z', NY)).toEqual({
      first: '2026-10-22',
      last: '2026-10-23',
    });
    // Ends exactly at New York midnight: still the 22nd only.
    expect(eventLocalDays('2026-10-22T20:00:00Z', '2026-10-23T04:00:00Z', NY)).toEqual({
      first: '2026-10-22',
      last: '2026-10-22',
    });
  });

  it('is one day with no end', () => {
    expect(eventLocalDays('2026-10-22T09:00:00', null, NY)).toEqual({
      first: '2026-10-22',
      last: '2026-10-22',
    });
  });

  it('handles a date-only all-day pair', () => {
    expect(eventLocalDays('2026-10-22', '2026-10-23', NY)).toEqual({
      first: '2026-10-22',
      last: '2026-10-22',
    });
  });
});

describe('instantInZoneMs', () => {
  it('reads a floating time in the user zone, not the server zone', () => {
    expect(instantInZoneMs('2026-10-22T00:00:00', NY)).toBe(Date.parse('2026-10-22T04:00:00Z'));
    expect(instantInZoneMs('2026-12-22T09:30:00', NY)).toBe(Date.parse('2026-12-22T14:30:00Z'));
  });

  it('keeps a zoned value as it is', () => {
    expect(instantInZoneMs('2026-10-22T09:00:00+02:00', NY)).toBe(Date.parse('2026-10-22T07:00:00Z'));
  });

  it('reads a date as the start of that day in the zone', () => {
    expect(instantInZoneMs('2026-10-22', NY)).toBe(Date.parse('2026-10-22T04:00:00Z'));
  });
});
