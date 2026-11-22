/**
 * nextScanDate(tz) — schedules the next daily morning scan at 7am in the
 * user's local IANA timezone. Falls back to `BRIEFING_DEFAULT_TZ` when tz is
 * unset or malformed; it used to fall back to the SERVER's clock, which on a
 * UTC VM put a 07:00 briefing at midnight Pacific (ADR 0098). The function
 * returns a UTC ISO string; callers insert it as `scheduled_for` on the
 * proactive_messages row.
 *
 * Tests verify the wall-clock invariant: rendering the result *back* in
 * the input zone must read "07:00:00".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import { nextScanDate } from '@/services/proactive.service.js';

function wallClockIn(iso: string, tz: string): string {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: tz });
}

// Found on 2026-10-31, the evening before US clocks fell back: the 7:00 Los
// Angeles briefing for Nov 1 came out as 14:00Z, which is 6:00 PST. The
// offset was read at 07:00Z, still Oct 31 summer time there.
describe('nextScanDate across a clock change', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the morning US clocks fall back is still 7:00 local', () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T20:00:00-07:00') });
    const out = nextScanDate('America/Los_Angeles');
    expect(out).toBe('2026-11-01T15:00:00.000Z');
    expect(wallClockIn(out, 'America/Los_Angeles')).toBe('2026-11-01 07:00:00');
  });

  it('New York, same night', () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T23:30:00-04:00') });
    expect(nextScanDate('America/New_York')).toBe('2026-11-01T12:00:00.000Z');
  });

  it('the morning US clocks spring forward is still 7:00 local', () => {
    vi.useFakeTimers({ now: new Date('2027-03-13T20:00:00-08:00') });
    const out = nextScanDate('America/Los_Angeles');
    expect(out).toBe('2027-03-14T14:00:00.000Z');
    expect(wallClockIn(out, 'America/Los_Angeles')).toBe('2027-03-14 07:00:00');
  });
});

describe('nextScanDate', () => {
  it('returns a future timestamp when given no tz', () => {
    const out = nextScanDate();
    expect(Date.parse(out)).toBeGreaterThan(Date.now());
  });

  it('returns a future timestamp when given null tz', () => {
    const out = nextScanDate(null);
    expect(Date.parse(out)).toBeGreaterThan(Date.now());
  });

  it('schedules at 07:00 wall clock in America/Los_Angeles', () => {
    const out = nextScanDate('America/Los_Angeles');
    expect(wallClockIn(out, 'America/Los_Angeles')).toMatch(/ 07:00:00$/);
  });

  it('schedules at 07:00 wall clock in Asia/Kolkata', () => {
    const out = nextScanDate('Asia/Kolkata');
    expect(wallClockIn(out, 'Asia/Kolkata')).toMatch(/ 07:00:00$/);
  });

  it('schedules at 07:00 wall clock in Europe/London', () => {
    const out = nextScanDate('Europe/London');
    expect(wallClockIn(out, 'Europe/London')).toMatch(/ 07:00:00$/);
  });

  it('falls back to a future timestamp for a garbage tz string', () => {
    const out = nextScanDate('Not/A_Zone');
    expect(Date.parse(out)).toBeGreaterThan(Date.now());
  });

  it('times an unknown zone in BRIEFING_DEFAULT_TZ, not the server clock', () => {
    const out = nextScanDate(null);
    expect(wallClockIn(out, env.BRIEFING_DEFAULT_TZ)).toMatch(/ 07:00:00$/);
  });

  /**
   * A zone that predates `isValidTz` must still land on the default. Routing
   * it to the server clock is what put a 07:00 briefing at 07:00Z — midnight
   * in Los Angeles — on a UTC VM.
   */
  it('sends a garbage zone to the default too — never to server-local', () => {
    const out = nextScanDate('Not/A_Zone');
    expect(wallClockIn(out, env.BRIEFING_DEFAULT_TZ)).toMatch(/ 07:00:00$/);
  });

  it('always schedules within the next 25 hours', () => {
    const out = nextScanDate('America/New_York');
    const delta = Date.parse(out) - Date.now();
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(25 * 3600 * 1000);
  });

  it('honors a custom hour/minute in the user zone', () => {
    const out = nextScanDate('America/Los_Angeles', 19, 30);
    expect(wallClockIn(out, 'America/Los_Angeles')).toMatch(/ 19:30:00$/);
  });

  it('honors a custom hour at minute 0 with no tz (default zone)', () => {
    const out = nextScanDate(null, 6, 0);
    expect(wallClockIn(out, env.BRIEFING_DEFAULT_TZ)).toMatch(/ 06:00:00$/);
    expect(Date.parse(out)).toBeGreaterThan(Date.now());
  });

  it('still schedules a future midnight (hour 0) target', () => {
    const out = nextScanDate('Asia/Kolkata', 0, 0);
    expect(wallClockIn(out, 'Asia/Kolkata')).toMatch(/ 00:00:00$/);
    expect(Date.parse(out)).toBeGreaterThan(Date.now());
  });
});
