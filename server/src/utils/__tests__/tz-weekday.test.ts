import { describe, expect, it } from 'vitest';
import { localWhen, localWhenOrNull, ownWhen, upcomingDatesTable, weekdayOf } from '../tz.js';

// Prod, Sunday 2026-09-27: asked what was on "Monday", the bot answered
// "Monday, September 29" (a Tuesday) — the prompt carried the date but no
// weekday, so the model computed one — and relayed a stored UTC start as
// "9:15 AM UTC".
describe('weekday grounding', () => {
  it('names the weekday of a date', () => {
    expect(weekdayOf('2026-09-27')).toBe('Sunday');
    expect(weekdayOf('2026-09-28')).toBe('Monday');
    expect(weekdayOf('2026-09-29')).toBe('Tuesday');
  });

  it('puts Monday on 9/28 when today is Sunday 9/27', () => {
    const table = upcomingDatesTable('2026-09-27');
    expect(table).toContain('Sun 2026-09-27 (today)');
    expect(table).toContain('Mon 2026-09-28 (tomorrow)');
    expect(table).toContain('Tue 2026-09-29');
    expect(table).not.toMatch(/Mon 2026-09-29/);
    expect(table.split(', ')).toHaveLength(14);
  });

  it('crosses a month end', () => {
    expect(upcomingDatesTable('2026-09-27')).toContain('Thu 2026-10-01');
  });

  it('renders a UTC start in the user zone, with its weekday', () => {
    expect(localWhen('2026-09-28T13:15:00Z', 'America/New_York')).toBe('Monday 2026-09-28 09:15');
  });

  it('moves the weekday when the zone moves the day', () => {
    expect(localWhen('2026-09-29T02:30:00Z', 'America/New_York')).toBe('Monday 2026-09-28 22:30');
  });

  it('leaves floating and all-day values as wall clock', () => {
    expect(localWhen('2026-09-28T19:30:00', 'America/New_York')).toBe('Monday 2026-09-28 19:30');
    expect(localWhen('2026-09-28', 'America/New_York')).toBe('Monday 2026-09-28 (all day)');
  });

  it('keeps a travel time in the zone it was booked in', () => {
    // A Tokyo departure reads as Tokyo time for a New York user.
    expect(ownWhen('2026-10-05T10:30:00+09:00', 'America/New_York')).toBe(
      'Monday 2026-10-05 10:30 local (UTC+09:00)',
    );
    // A bare Z has no place attached, so it is shown in the user's zone.
    expect(ownWhen('2026-09-28T10:00:00Z', 'America/New_York')).toBe('Monday 2026-09-28 06:00');
  });

  it('renders a nullable column', () => {
    expect(localWhenOrNull(null, 'America/New_York')).toBeNull();
    expect(localWhenOrNull('2026-09-28T13:15:00Z', 'America/New_York')).toBe('Monday 2026-09-28 09:15');
  });

  it('falls back to UTC for no or a bad zone', () => {
    expect(localWhen('2026-09-28T13:15:00Z', null)).toBe('Monday 2026-09-28 13:15');
    expect(localWhen('2026-09-28T13:15:00Z', 'Not/AZone')).toBe('Monday 2026-09-28 13:15');
  });
});
