/**
 * ADR 0297 - the wheel time picker's rules. Kernel has no harness of its own,
 * so they are tested here.
 */
import { describe, expect, it } from 'vitest';

import {
  fromWheel,
  instantOfWallTime,
  moveEndWithStart,
  timeZoneChoices,
  timeZoneLabel,
  toWheel,
  wallTimeIn,
  zoneForEvent,
} from '@chord/kernel';

describe('12-hour wheels', () => {
  it('round-trips every minute of the day', () => {
    for (let m = 0; m < 24 * 60; m++) {
      const t = { hour: Math.floor(m / 60), minute: m % 60 };
      const w = toWheel(t);
      expect(fromWheel(w.hour12, w.minute, w.pm)).toEqual(t);
    }
  });

  it('midnight is 12 AM and noon is 12 PM', () => {
    expect(toWheel({ hour: 0, minute: 0 })).toEqual({ hour12: 12, minute: 0, pm: false });
    expect(toWheel({ hour: 12, minute: 5 })).toEqual({ hour12: 12, minute: 5, pm: true });
  });
});

describe('moveEndWithStart', () => {
  it('keeps the event length when the start moves (3:30-4:15 moved to 5:00 ends 5:45)', () => {
    expect(
      moveEndWithStart({ hour: 15, minute: 30 }, { hour: 16, minute: 15 }, { hour: 17, minute: 0 }),
    ).toEqual({ hour: 17, minute: 45 });
  });

  it('wraps past midnight', () => {
    expect(
      moveEndWithStart({ hour: 21, minute: 0 }, { hour: 23, minute: 0 }, { hour: 23, minute: 30 }),
    ).toEqual({ hour: 1, minute: 30 });
  });

  it('measures an overnight event the way the editor saves it', () => {
    expect(
      moveEndWithStart({ hour: 22, minute: 0 }, { hour: 1, minute: 0 }, { hour: 20, minute: 0 }),
    ).toEqual({ hour: 23, minute: 0 });
  });

  it('no end stays no end', () => {
    expect(moveEndWithStart({ hour: 9, minute: 0 }, null, { hour: 10, minute: 0 })).toBeNull();
  });
});

describe('clock time in a zone', () => {
  it('3:30 PM in New York in summer is 19:30 UTC, in winter 20:30 UTC', () => {
    const w = { year: 2026, month: 7, day: 15, hour: 15, minute: 30 };
    expect(instantOfWallTime(w, 'America/New_York').toISOString()).toBe('2026-07-15T19:30:00.000Z');
    expect(instantOfWallTime({ ...w, month: 12 }, 'America/New_York').toISOString()).toBe(
      '2026-12-15T20:30:00.000Z',
    );
  });

  it('reads back the same clock time', () => {
    const w = { year: 2026, month: 11, day: 1, hour: 9, minute: 15 };
    const at = instantOfWallTime(w, 'Asia/Kolkata');
    expect(wallTimeIn(at.getTime(), 'Asia/Kolkata')).toEqual(w);
  });

  it('the day after the clocks go back still lands on the right hour', () => {
    // US clocks fell back on 1 Nov 2026; 10:00 AM that day is EST (UTC-5).
    const at = instantOfWallTime({ year: 2026, month: 11, day: 1, hour: 10, minute: 0 }, 'America/New_York');
    expect(at.toISOString()).toBe('2026-11-01T15:00:00.000Z');
  });

  it('labels a zone with its offset at that date', () => {
    expect(timeZoneLabel('Asia/Kolkata', Date.UTC(2026, 0, 1))).toBe('Kolkata (GMT+5:30)');
    expect(timeZoneLabel('America/Los_Angeles', Date.UTC(2026, 6, 1))).toBe('Los Angeles (GMT-7)');
  });

  it('opens an event in its stored zone', () => {
    expect(zoneForEvent('2026-11-21T14:00:00.000Z', 'Europe/Paris', 'America/New_York')).toBe('Europe/Paris');
  });

  it('with no stored zone, an offset the device does not have picks a zone that has it', () => {
    // A Denver dinner written -07:00 opened on a New York phone.
    expect(zoneForEvent('2026-11-21T19:00:00-07:00', null, 'America/New_York')).toBe('America/Denver');
    // India's +05:30 lands on Kolkata.
    expect(zoneForEvent('2026-11-21T09:00:00+05:30', undefined, 'America/New_York')).toBe('Asia/Kolkata');
  });

  it('stays on the device when the offset is the device zone\'s own, or the time is UTC or floating', () => {
    expect(zoneForEvent('2026-11-21T19:00:00-05:00', null, 'America/New_York')).toBe('America/New_York');
    expect(zoneForEvent('2026-11-21T19:00:00.000Z', null, 'America/New_York')).toBe('America/New_York');
    expect(zoneForEvent('2026-11-21T00:00:00', null, 'America/New_York')).toBe('America/New_York');
  });

  it('lists the device zone first and drops unknown or repeated zones', () => {
    const z = timeZoneChoices(['Asia/Kolkata', 'Not/AZone', 'Asia/Kolkata']);
    expect(z[0]).toBe('Asia/Kolkata');
    expect(z).not.toContain('Not/AZone');
    expect(z.filter((x) => x === 'Asia/Kolkata')).toHaveLength(1);
  });
});
