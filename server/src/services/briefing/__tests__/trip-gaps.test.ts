/**
 * The briefing said "accommodation pending" for the same trips every
 * morning. It is said on two mornings in all; a rebuild on the same morning
 * does not use up a mention.
 */
import { describe, expect, it } from 'vitest';

import { decideTripGaps } from '@/services/briefing/trip-gaps.js';

const GAP = 'tr_ewr:no accommodation';

describe('decideTripGaps', () => {
  it('mentions a gap on two mornings, then stops', () => {
    let told: Record<string, string[]> = {};
    const days = ['2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'];
    const shown = days.map((day) => {
      const { show, next } = decideTripGaps(told, [GAP], day);
      told = next;
      return show.has(GAP);
    });
    expect(shown).toEqual([true, true, false, false]);
  });

  it('a briefing rebuilt the same morning still mentions it, without using a mention', () => {
    const first = decideTripGaps({}, [GAP], '2026-10-23');
    const retry = decideTripGaps(first.next, [GAP], '2026-10-23');
    expect(retry.show.has(GAP)).toBe(true);
    expect(retry.next[GAP]).toEqual(['2026-10-23']);
    expect(decideTripGaps(retry.next, [GAP], '2026-10-24').show.has(GAP)).toBe(true);
  });

  it('forgets trips no longer on the radar', () => {
    const { next } = decideTripGaps({ 'tr_old:no accommodation': ['2026-09-01', '2026-09-02'] }, [GAP], '2026-10-23');
    expect(Object.keys(next)).toEqual([GAP]);
  });
});
