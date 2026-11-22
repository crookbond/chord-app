/**
 * A non-invite .ics attached to a ticket/confirmation email (ADR 0175) still
 * carries a real DTSTART the body text usually omits a year for — used to
 * correct the classifier's own year-resolution when month/day already
 * agree (ADR 0177).
 */
import { describe, expect, it } from 'vitest';

import { icsYearCorrection, shiftYear } from '@/services/bot/trip_classifier.js';

describe('icsYearCorrection', () => {
  it('returns 0 with no hint', () => {
    expect(icsYearCorrection(undefined, '2026-02-11T20:55:00-05:00')).toBe(0);
  });

  it('returns the year delta when month/day agree but year differs', () => {
    expect(icsYearCorrection('2027-02-11T00:00:00', '2026-02-11T20:55:00-05:00')).toBe(1);
    expect(icsYearCorrection('2025-02-11', '2026-02-11')).toBe(-1);
  });

  it('returns 0 when the dates already agree', () => {
    expect(icsYearCorrection('2027-02-11', '2027-02-11T20:55:00-05:00')).toBe(0);
  });

  it('returns 0 when month/day genuinely differ — not this fix\'s problem', () => {
    expect(icsYearCorrection('2027-03-01', '2026-02-11')).toBe(0);
  });

  it('returns 0 for unparseable input on either side', () => {
    expect(icsYearCorrection('not-a-date', '2026-02-11')).toBe(0);
    expect(icsYearCorrection('2027-02-11', 'not-a-date')).toBe(0);
  });
});

describe('shiftYear', () => {
  it('shifts the leading year and leaves the rest of the string alone', () => {
    expect(shiftYear('2026-02-11T20:55:00-05:00', 1)).toBe('2027-02-11T20:55:00-05:00');
    expect(shiftYear('2026-02-15', -1)).toBe('2025-02-15');
  });

  it('is a no-op at delta 0 or for a non-date string', () => {
    expect(shiftYear('2026-02-11', 0)).toBe('2026-02-11');
    expect(shiftYear('not-a-date', 1)).toBe('not-a-date');
  });
});
