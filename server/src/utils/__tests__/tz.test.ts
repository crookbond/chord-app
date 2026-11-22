import { describe, expect, it } from 'vitest';

import {
  fmtWhenWithZone,
  offsetForLocalDatetime,
  tzToOffset,
  zonedDayStartUtc,
  zonedWallToUtcMs,
} from '@/utils/tz.js';

// A wall time in the hours after a clock change used to get the OLD offset:
// it was read at the wall time taken as UTC, hours before the real instant.
describe('wall time on the morning of a clock change', () => {
  it('Los Angeles 8:00 on 2026-11-01 is standard time', () => {
    expect(offsetForLocalDatetime('America/Los_Angeles', '2026-11-01T08:00:00')).toBe('-08:00');
    expect(new Date(zonedWallToUtcMs('2026-11-01T08:00:00', 'America/Los_Angeles')).toISOString()).toBe(
      '2026-11-01T16:00:00.000Z',
    );
  });

  it('New York 5:00 on 2026-11-01 is standard time', () => {
    expect(offsetForLocalDatetime('America/New_York', '2026-11-01T05:00:00')).toBe('-05:00');
  });

  it('Los Angeles 8:00 on 2027-03-14 is daylight time', () => {
    expect(offsetForLocalDatetime('America/Los_Angeles', '2027-03-14T08:00:00')).toBe('-07:00');
  });

  it('a day that starts on a midnight clock change starts at the new offset', () => {
    // Chile moved to summer time at 00:00 on 2026-09-06: that day starts at
    // 01:00 -03:00 (midnight does not exist), so 04:00Z.
    expect(zonedDayStartUtc('2026-09-06', 'America/Santiago').toISOString()).toBe('2026-09-06T04:00:00.000Z');
  });

  it('an unknown zone throws', () => {
    expect(() => zonedWallToUtcMs('2026-11-01T08:00:00', 'Not/A_Zone')).toThrow();
  });
});

describe('offsetForLocalDatetime', () => {
  it("uses the TARGET date's DST state, not today's", () => {
    // America/New_York: EDT (-04:00) roughly mid-March to early November,
    // EST (-05:00) the rest of the year. Dec 5 is always standard time.
    expect(offsetForLocalDatetime('America/New_York', '2026-12-05T13:00:00')).toBe('-05:00');
    // And a summer date is always daylight time, regardless of when this
    // runs.
    expect(offsetForLocalDatetime('America/New_York', '2026-07-04T13:00:00')).toBe('-04:00');
  });

  it('matches tzToOffset when the target date IS today (both DST-correct for "now")', () => {
    const now = new Date();
    const localNow = now.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T');
    expect(offsetForLocalDatetime('America/New_York', localNow)).toBe(tzToOffset('America/New_York'));
  });

  it('handles a southern-hemisphere zone (DST flipped relative to the north)', () => {
    // Australia/Sydney: daylight saving is roughly October–April (their
    // summer), so a December date is DST (+11:00) and a July date is
    // standard time (+10:00) — the reverse of the New York cases above.
    expect(offsetForLocalDatetime('Australia/Sydney', '2026-12-05T13:00:00')).toBe('+11:00');
    expect(offsetForLocalDatetime('Australia/Sydney', '2026-07-04T13:00:00')).toBe('+10:00');
  });

  it('falls back to tzToOffset on an unparseable local string', () => {
    expect(offsetForLocalDatetime('America/New_York', 'not-a-date')).toBe(tzToOffset('America/New_York'));
  });
});

describe('fmtWhenWithZone', () => {
  it('keeps a numeric UTC offset, never converting it', () => {
    // A Barcelona departure booked in ET stays ET — the bot must not restate
    // "6:15" as a Barcelona (CEST) time or shift it into the server zone.
    expect(fmtWhenWithZone('2026-09-08T06:15:00-04:00')).toBe('2026-09-08 06:15 (UTC-04:00)');
    expect(fmtWhenWithZone('2026-09-08T12:15:00+02:00')).toBe('2026-09-08 12:15 (UTC+02:00)');
  });

  it('labels a Z instant as UTC rather than dropping the zone', () => {
    expect(fmtWhenWithZone('2026-09-08T06:15:00Z')).toBe('2026-09-08 06:15 (UTC)');
  });

  it('leaves a floating wall-clock unlabelled (all-day / ADR 0040)', () => {
    expect(fmtWhenWithZone('2026-09-08T00:00:00')).toBe('2026-09-08 00:00');
    expect(fmtWhenWithZone('2026-09-08')).toBe('2026-09-08');
  });

  it('tolerates missing seconds, fractional seconds, and a colon-less offset', () => {
    expect(fmtWhenWithZone('2026-09-08T06:15-04:00')).toBe('2026-09-08 06:15 (UTC-04:00)');
    expect(fmtWhenWithZone('2026-09-08T06:15:00.000-04:00')).toBe('2026-09-08 06:15 (UTC-04:00)');
    expect(fmtWhenWithZone('2026-09-08T06:15:00-0400')).toBe('2026-09-08 06:15 (UTC-04:00)');
  });

  it('returns the input unchanged when it is not a recognisable datetime', () => {
    expect(fmtWhenWithZone('sometime Friday')).toBe('sometime Friday');
  });
});
