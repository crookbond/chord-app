/**
 * upcomingHolidays — the morning scan adds a HOLIDAYS section so the bot
 * can surface "Mother's Day is Sunday" without the user having to put
 * Mother's Day on their calendar. Coverage:
 *   - fixed-date holidays inside the horizon
 *   - floating holidays (Thanksgiving, Mother's Day, Memorial Day)
 *     computed correctly
 *   - horizon boundary respected (nothing past today+N days)
 *   - empty result for a window with no holidays
 */
import { describe, expect, it } from 'vitest';

import { upcomingHolidays } from '@/services/proactive.service.js';

describe('upcomingHolidays', () => {
  it('returns Christmas Day when querying mid-December with a 14-day horizon', () => {
    const out = upcomingHolidays('2026-12-20', 14);
    const names = out.map((h) => h.name);
    expect(names).toContain('Christmas Day');
    expect(names).toContain('Christmas Eve');
    expect(names).toContain("New Year's Eve");
  });

  it("computes Thanksgiving as the 4th Thursday of November", () => {
    const out = upcomingHolidays('2026-11-01', 30);
    const thanks = out.find((h) => h.name === 'Thanksgiving');
    expect(thanks?.on).toBe('2026-11-26');
  });

  it("computes Mother's Day as the 2nd Sunday of May", () => {
    const out = upcomingHolidays('2026-05-01', 30);
    const mom = out.find((h) => h.name === "Mother's Day");
    expect(mom?.on).toBe('2026-05-10');
  });

  it('computes Memorial Day as the last Monday of May', () => {
    const out = upcomingHolidays('2026-05-01', 31);
    const mem = out.find((h) => h.name === 'Memorial Day');
    expect(mem?.on).toBe('2026-05-25');
  });

  it('respects the horizon — nothing past today + N days', () => {
    const out = upcomingHolidays('2026-05-01', 7);
    for (const h of out) {
      const days =
        (Date.parse(`${h.on}T00:00:00Z`) - Date.parse('2026-05-01T00:00:00Z')) /
        86400000;
      expect(days).toBeGreaterThanOrEqual(0);
      expect(days).toBeLessThanOrEqual(7);
    }
  });

  it('returns empty for a window with no notable holidays', () => {
    // Late August through mid-September straddles Labor Day; pick a tighter
    // window in mid-August where nothing on the list lands.
    const out = upcomingHolidays('2026-08-14', 14);
    expect(out).toHaveLength(0);
  });

  it('sorts results by date ascending', () => {
    const out = upcomingHolidays('2026-12-20', 14);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].on >= out[i - 1].on).toBe(true);
    }
  });
});
