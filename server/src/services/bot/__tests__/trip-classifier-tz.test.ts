/**
 * Flight legs from the image classifier are local ticket times. A zone-less
 * value must be interpreted in the uploader's timezone, not UTC (option 1) —
 * otherwise an 8am EWR departure stored as 08:00Z shows as 4am Eastern.
 */
import { describe, expect, it } from 'vitest';

import { __testing } from '@/services/bot/trip_classifier.js';

const { toLocalDatetime, zonedDatetime } = __testing;

const EDT = -240; // -04:00 in minutes
const IST = 330; // +05:30

describe('toLocalDatetime', () => {
  it('appends the uploader offset to a bare datetime (not Z)', () => {
    expect(toLocalDatetime('2026-09-01T08:00:00', EDT)).toBe('2026-09-01T08:00:00-04:00');
  });

  it('handles half-hour offsets', () => {
    expect(toLocalDatetime('2026-09-01T08:00:00', IST)).toBe('2026-09-01T08:00:00+05:30');
  });

  it('inserts missing seconds before applying the offset', () => {
    expect(toLocalDatetime('2026-09-01T08:00', EDT)).toBe('2026-09-01T08:00:00-04:00');
  });

  it('converts a space separator', () => {
    expect(toLocalDatetime('2026-09-01 08:00', EDT)).toBe('2026-09-01T08:00:00-04:00');
  });

  it('uses local midnight with offset for a date-only value', () => {
    expect(toLocalDatetime('2026-09-01', EDT)).toBe('2026-09-01T00:00:00-04:00');
  });

  it('leaves an explicit offset or Z untouched', () => {
    expect(toLocalDatetime('2026-09-01T08:00:00+02:00', EDT)).toBe('2026-09-01T08:00:00+02:00');
    expect(toLocalDatetime('2026-09-01T08:00:00Z', EDT)).toBe('2026-09-01T08:00:00Z');
  });

  it('falls back to UTC when no offset is known', () => {
    expect(toLocalDatetime('2026-09-01T08:00:00', undefined)).toBe('2026-09-01T08:00:00+00:00');
  });
});

describe('zonedDatetime (airport timezone lookup)', () => {
  it("anchors a departure to the origin airport's zone (DST-aware)", () => {
    // Sept 1 → New York is on EDT (-04:00).
    expect(zonedDatetime('2026-09-01T08:00:00', 'America/New_York', -300)).toBe('2026-09-01T08:00:00-04:00');
  });

  it("anchors an arrival to the destination airport's zone", () => {
    // Sept 2 → Lisbon is on WEST (+01:00).
    expect(zonedDatetime('2026-09-02T19:55:00', 'Europe/Lisbon', -300)).toBe('2026-09-02T19:55:00+01:00');
  });

  it('uses standard-time offset in winter (DST-aware)', () => {
    // Jan 15 → New York is on EST (-05:00).
    expect(zonedDatetime('2026-01-15T08:00:00', 'America/New_York', 0)).toBe('2026-01-15T08:00:00-05:00');
  });

  it('falls back to the uploader offset for an unknown zone', () => {
    expect(zonedDatetime('2026-09-01T08:00:00', 'Not/A_Zone', -240)).toBe('2026-09-01T08:00:00-04:00');
  });

  it('falls back to the uploader offset when no zone is given', () => {
    expect(zonedDatetime('2026-09-01T08:00:00', undefined, -240)).toBe('2026-09-01T08:00:00-04:00');
  });

  it('leaves a value that already carries an offset untouched', () => {
    expect(zonedDatetime('2026-09-01T08:00:00+09:00', 'America/New_York', -240)).toBe('2026-09-01T08:00:00+09:00');
  });
});
