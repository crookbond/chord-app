/**
 * Which hour the briefing points at when it says "around 3 PM".
 *
 * Two rules that only show up against real forecasts: the hour must still be
 * ahead of the reader, and long runs of hours share a probability, so ties
 * are the common case rather than an edge.
 */
import { describe, expect, it } from 'vitest';

import { peakPrecip } from '@/services/weather/open-meteo.js';

/** 24 local hours, `probs`/`codes` indexed by hour. */
function day(probs: number[], codes?: number[]) {
  return {
    time: Array.from({ length: 24 }, (_, h) => `2026-08-22T${String(h).padStart(2, '0')}:00`),
    precipitation_probability: probs,
    weather_code: codes,
  };
}

const flat = (v: number) => Array.from({ length: 24 }, () => v);

describe('peakPrecip', () => {
  it('picks the wettest hour', () => {
    const probs = flat(10);
    probs[15] = 80;
    expect(peakPrecip(day(probs), 7)).toMatchObject({ pct: 80, at: '2026-08-22T15:00' });
  });

  it('ignores rain the reader has already walked through', () => {
    const probs = flat(5);
    probs[6] = 90; // this morning
    probs[18] = 40; // still ahead
    expect(peakPrecip(day(probs), 12)).toMatchObject({ pct: 40, at: '2026-08-22T18:00' });
  });

  it('breaks a tie on severity, not on whichever hour came first', () => {
    const probs = flat(100);
    const codes = flat(53); // drizzle all day...
    codes[16] = 95; // ...except the thunderstorm
    expect(peakPrecip(day(probs, codes), 7)).toMatchObject({
      pct: 100,
      at: '2026-08-22T16:00',
      code: 95,
    });
  });

  it('does not resurrect this morning\'s rain for an evening reader', () => {
    const probs = flat(0);
    probs[9] = 70;
    // Read at 11 PM: the 70% already happened. Reporting the remaining 0
    // is what makes the caller drop the clause, which is the right answer —
    // an umbrella warning for weather you already walked through is noise.
    expect(peakPrecip(day(probs), 23)).toMatchObject({ pct: 0, at: '2026-08-22T23:00' });
  });

  it('returns null when the provider sent no hourly block', () => {
    expect(peakPrecip(undefined, 7)).toBeNull();
    expect(peakPrecip({ time: [], precipitation_probability: [] }, 7)).toBeNull();
  });

  it('survives a short or ragged probability array', () => {
    // Defensive: the arrays are parallel by contract, not by construction.
    const out = peakPrecip({ ...day(flat(0)), precipitation_probability: [10, 20] }, 0);
    expect(out).toMatchObject({ pct: 20, at: '2026-08-22T01:00' });
  });
});
