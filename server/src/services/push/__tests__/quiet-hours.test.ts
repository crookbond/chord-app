import { describe, expect, it } from 'vitest';

import { isQuietNow, localMinuteOfDay } from '@/services/push/quiet-hours.js';

// A fixed UTC instant: 2026-06-17T06:30:00Z.
const at = (iso: string) => new Date(iso);

describe('localMinuteOfDay', () => {
  it('converts UTC to the tz wall clock', () => {
    // 06:30 UTC = 23:30 the previous day in LA (UTC-7 in June).
    expect(localMinuteOfDay(at('2026-06-17T06:30:00Z'), 'America/Los_Angeles')).toBe(
      23 * 60 + 30,
    );
    // Same instant in London (UTC+1 in June) = 07:30.
    expect(localMinuteOfDay(at('2026-06-17T06:30:00Z'), 'Europe/London')).toBe(7 * 60 + 30);
  });

  it('falls back to server local time on missing/invalid tz', () => {
    const d = at('2026-06-17T06:30:00Z');
    expect(localMinuteOfDay(d, null)).toBe(d.getHours() * 60 + d.getMinutes());
    expect(localMinuteOfDay(d, 'Not/AZone')).toBe(d.getHours() * 60 + d.getMinutes());
  });
});

describe('isQuietNow', () => {
  const win = { startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 };

  it('treats a wrap-around window (22:00 → 07:00) correctly', () => {
    // 23:30 LA is inside the window.
    expect(isQuietNow('America/Los_Angeles', win, at('2026-06-17T06:30:00Z'))).toBe(true);
    // 07:30 London is past the 07:00 end → not quiet.
    expect(isQuietNow('Europe/London', win, at('2026-06-17T06:30:00Z'))).toBe(false);
  });

  it('handles a same-day window (09:00 → 17:00)', () => {
    const day = { startHour: 9, startMinute: 0, endHour: 17, endMinute: 0 };
    // 07:30 London → before 09:00 → not quiet.
    expect(isQuietNow('Europe/London', day, at('2026-06-17T06:30:00Z'))).toBe(false);
    // 13:00 London (12:00 UTC) → inside → quiet.
    expect(isQuietNow('Europe/London', day, at('2026-06-17T12:00:00Z'))).toBe(true);
  });

  it('is inclusive of the start minute and exclusive of the end minute', () => {
    const w = { startHour: 22, startMinute: 0, endHour: 7, endMinute: 0 };
    // Exactly 22:00 local (use UTC tz for a clean wall clock).
    expect(isQuietNow('UTC', w, at('2026-06-17T22:00:00Z'))).toBe(true);
    // Exactly 07:00 local → end is exclusive → not quiet.
    expect(isQuietNow('UTC', w, at('2026-06-17T07:00:00Z'))).toBe(false);
  });

  it('a zero-length window is never quiet', () => {
    const w = { startHour: 8, startMinute: 0, endHour: 8, endMinute: 0 };
    expect(isQuietNow('UTC', w, at('2026-06-17T08:00:00Z'))).toBe(false);
  });
});
