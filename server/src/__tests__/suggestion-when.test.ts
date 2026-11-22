/**
 * A pending suggestion's date reads as a date (kernel/src/suggestion-when.ts).
 * Seen on a demo account: Action Items and the Tasks tab printed
 * "due 2026-11-28T09:00:00-05:00" and "2026-11-25T15:30:00-05:00 · 120 Main St",
 * the shape the email suggestion pass writes for every user.
 */
import { describe, expect, it } from 'vitest';

import { suggestionWhen } from '@chord/kernel';

const NY = { timeZone: 'America/New_York', locale: 'en-US' };

describe('suggestionWhen', () => {
  it('reads the reported to-do due date as a day, not an ISO string', () => {
    const out = suggestionWhen('2026-11-28T09:00:00-05:00', { ...NY, withTime: false });
    expect(out).toBe('Sat, Nov 28');
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('reads the reported event start as day and time in the viewer zone', () => {
    expect(suggestionWhen('2026-11-25T15:30:00-05:00', NY)).toBe('Wed, Nov 25, 3:30 PM');
    expect(suggestionWhen('2026-11-25T15:30:00-05:00', { ...NY, timeZone: 'America/Los_Angeles' })).toBe(
      'Wed, Nov 25, 12:30 PM',
    );
    expect(suggestionWhen('2026-11-25T20:30:00Z', NY)).toBe('Wed, Nov 25, 3:30 PM');
  });

  it('shows an all-day date as that date in every zone (ADR 0040)', () => {
    for (const timeZone of ['America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Auckland']) {
      const o = { timeZone, locale: 'en-US' };
      expect(suggestionWhen('2026-11-25', o)).toBe('Wed, Nov 25');
      expect(suggestionWhen('2026-11-25T00:00:00', o)).toBe('Wed, Nov 25');
      expect(suggestionWhen('2026-11-25T00:00:00Z', { ...o, allDay: true })).toBe('Wed, Nov 25');
    }
  });

  it('shows a floating time as written', () => {
    expect(suggestionWhen('2026-11-25T15:30', { timeZone: 'Asia/Tokyo', locale: 'en-US' })).toBe(
      'Wed, Nov 25, 3:30 PM',
    );
  });

  it('shows a flight leg on its airport clock when asked (ADR 0240)', () => {
    expect(suggestionWhen('2026-12-03T01:50:00+05:30', { ...NY, clock: 'written' })).toBe('Thu, Dec 3, 1:50 AM');
    expect(suggestionWhen('2026-12-03T01:50:00+05:30', NY)).toBe('Wed, Dec 2, 3:20 PM');
  });

  it('drops what is not a date instead of printing it', () => {
    expect(suggestionWhen('next week sometime', NY)).toBeNull();
    expect(suggestionWhen('', NY)).toBeNull();
    expect(suggestionWhen(undefined, NY)).toBeNull();
    expect(suggestionWhen('2026-13-45T99:00:00Z', NY)).toBeNull();
  });
});
