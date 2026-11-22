/**
 * `svWall` replaces `date.toLocaleString('sv-SE', { timeZone })` in helpers that
 * run several times per bot turn and per mail extraction. It builds one
 * formatter per zone instead of one per call, and must return the same string,
 * including across DST changes and for the inputs that make toLocaleString odd.
 */
import { describe, expect, it } from 'vitest';

import { offsetForLocalDatetime, svWall, tzToOffset, tzToOffsetMinutes, zonedDayStartUtc } from '../tz.js';

const ZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Madrid',
  'Africa/Nairobi',
  'Asia/Kolkata', // +05:30
  'Asia/Kathmandu', // +05:45
  'Australia/Lord_Howe', // 30-minute DST
  'Pacific/Chatham', // +12:45 / +13:45
  'Pacific/Kiritimati', // +14
];

// Instants around DST changes in both hemispheres, year ends, and the epoch.
const INSTANTS = [
  '2026-03-08T06:59:59Z',
  '2026-03-08T07:00:00Z',
  '2026-03-29T00:59:59Z',
  '2026-03-29T01:00:00Z',
  '2026-04-05T15:29:59Z',
  '2026-10-25T00:59:59Z',
  '2026-11-01T05:59:59Z',
  '2026-11-01T06:00:00Z',
  '2026-12-31T23:59:59Z',
  '2027-01-01T00:00:00Z',
  '2024-02-29T12:00:00Z',
  '1970-01-01T00:00:00Z',
  '2099-06-15T13:45:10Z',
].map((s) => new Date(s));

describe('svWall', () => {
  it('matches toLocaleString exactly, for every zone and instant', () => {
    for (const tz of ZONES) {
      for (const d of INSTANTS) {
        expect(svWall(d, tz), `${tz} ${d.toISOString()}`).toBe(d.toLocaleString('sv-SE', { timeZone: tz }));
      }
    }
  });

  it('is stable when called again (the formatter is reused)', () => {
    const d = new Date('2026-09-24T04:05:06Z');
    const first = svWall(d, 'America/New_York');
    for (let i = 0; i < 50; i++) expect(svWall(d, 'America/New_York')).toBe(first);
    expect(first).toBe('2026-09-24 00:05:06');
  });

  it('throws for an unknown zone, as toLocaleString does, and callers can fall back', () => {
    const d = new Date('2026-09-24T04:05:06Z');
    expect(() => d.toLocaleString('sv-SE', { timeZone: 'Not/AZone' })).toThrow(RangeError);
    expect(() => svWall(d, 'Not/AZone')).toThrow(RangeError);
    // A bad zone is not remembered as good.
    expect(() => svWall(d, 'Not/AZone')).toThrow(RangeError);
  });

  it('answers "Invalid Date" for an invalid date, as toLocaleString does', () => {
    const bad = new Date(NaN);
    expect(bad.toLocaleString('sv-SE', { timeZone: 'UTC' })).toBe('Invalid Date');
    expect(svWall(bad, 'UTC')).toBe('Invalid Date');
  });
});

describe('the helpers built on it keep their answers', () => {
  it('offsets, in minutes and as ±HH:MM', () => {
    for (const tz of ZONES) {
      const now = new Date();
      const wall = Date.parse(now.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T') + 'Z');
      const utc = Date.parse(now.toLocaleString('sv-SE', { timeZone: 'UTC' }).replace(' ', 'T') + 'Z');
      const expected = Math.round((wall - utc) / 60000);
      expect(tzToOffsetMinutes(tz), tz).toBe(expected);
      const sign = expected >= 0 ? '+' : '-';
      const abs = Math.abs(expected);
      expect(tzToOffset(tz), tz).toBe(`${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`);
    }
    expect(tzToOffsetMinutes('Not/AZone')).toBeNull();
    expect(tzToOffset('Not/AZone')).toBe('+00:00');
  });

  it('the offset that applies on a given local date, either side of a DST change', () => {
    expect(offsetForLocalDatetime('America/New_York', '2026-10-15T13:00:00')).toBe('-04:00');
    expect(offsetForLocalDatetime('America/New_York', '2026-12-05T13:00:00')).toBe('-05:00');
    expect(offsetForLocalDatetime('Asia/Kolkata', '2026-06-01T09:00:00')).toBe('+05:30');
    expect(offsetForLocalDatetime('Australia/Lord_Howe', '2026-01-15T09:00:00')).toBe('+11:00');
  });

  it('the start of a day in a zone', () => {
    expect(zonedDayStartUtc('2026-07-04', 'America/Los_Angeles').toISOString()).toBe('2026-07-04T07:00:00.000Z');
    expect(zonedDayStartUtc('2026-12-25', 'Europe/Madrid').toISOString()).toBe('2026-12-24T23:00:00.000Z');
    expect(zonedDayStartUtc('2026-07-04', null).toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });
});
