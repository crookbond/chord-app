/** ADR 0091 — WMO 4677 code rendering. */
import { describe, expect, it } from 'vitest';

import { describeWmo, renderWeatherLine } from '@/services/weather/wmo.js';

describe('describeWmo', () => {
  it('maps the codes we care about', () => {
    expect(describeWmo(0).phrase).toBe('Clear');
    expect(describeWmo(3).phrase).toBe('Overcast');
    expect(describeWmo(95).phrase).toBe('Thunderstorms');
  });

  it('falls back rather than returning undefined for an unlisted code', () => {
    const out = describeWmo(4242);
    expect(out.phrase).toBe('Mixed');
    expect(out.emoji.length).toBeGreaterThan(0);
  });
});

describe('renderWeatherLine', () => {
  it('converts to Fahrenheit when asked', () => {
    // 22C = 71.6F -> 72, 14C = 57.2F -> 57
    expect(renderWeatherLine({ code: 0, highC: 22, lowC: 14, unit: 'F' })).toBe(
      '☀️ Clear today, low 57° and high 72°F',
    );
  });

  it('leaves Celsius alone', () => {
    expect(renderWeatherLine({ code: 0, highC: 22, lowC: 14, unit: 'C' })).toBe(
      '☀️ Clear today, low 14° and high 22°C',
    );
  });

  it('names the place when one is given, and stays single-line for the Meta slot', () => {
    const out = renderWeatherLine({ code: 0, highC: 22, lowC: 14, unit: 'C', place: 'Seville' });
    expect(out).toBe('☀️ Clear in Seville today, low 14° and high 22°C');
    expect(out).not.toMatch(/[\n\t]|\s{4,}/);
  });

  it('drops the clause when place is null or empty', () => {
    expect(renderWeatherLine({ code: 0, highC: 22, lowC: 14, unit: 'C', place: null })).toBe(
      '☀️ Clear today, low 14° and high 22°C',
    );
    expect(renderWeatherLine({ code: 0, highC: 22, lowC: 14, unit: 'C', place: '' })).toBe(
      '☀️ Clear today, low 14° and high 22°C',
    );
  });

  it('names the chance, the kind, and the hour', () => {
    const out = renderWeatherLine({
      code: 2,
      highC: 26,
      lowC: 18,
      unit: 'C',
      chancePct: 60,
      chanceAt: '2026-08-22T15:00',
      chanceCode: 95,
    });
    expect(out).toContain('60% chance of thunderstorms around 3 PM');
  });

  it('advises an umbrella at or above 50%, and stays quiet below it', () => {
    const wet = { code: 3, highC: 20, lowC: 12, unit: 'C' as const, chanceAt: '2026-08-22T08:00' };
    expect(renderWeatherLine({ ...wet, chancePct: 70, chanceCode: 63 })).toContain(
      'carry an umbrella',
    );
    expect(renderWeatherLine({ ...wet, chancePct: 30, chanceCode: 63 })).not.toContain('umbrella');
    expect(renderWeatherLine({ ...wet, chancePct: 30, chanceCode: 63 })).toContain('30% chance');
  });

  it('says bundle up for snow rather than reaching for an umbrella', () => {
    const out = renderWeatherLine({
      code: 73,
      highC: -1,
      lowC: -8,
      unit: 'C',
      chancePct: 80,
      chanceAt: '2026-01-05T07:00',
      chanceCode: 73,
    });
    expect(out).toContain('bundle up');
    expect(out).not.toContain('umbrella');
  });

  it('omits the clause entirely on a dry day', () => {
    const out = renderWeatherLine({
      code: 0,
      highC: 24,
      lowC: 15,
      unit: 'C',
      chancePct: 8,
      chanceAt: '2026-08-22T14:00',
      chanceCode: 0,
    });
    expect(out).toBe('☀️ Clear today, low 15° and high 24°C');
  });

  it('never pairs a big number with a dry code', () => {
    // A high probability against a clear-sky code is a rounding artefact;
    // "60% chance of clear" would read as a bug to anyone who saw it.
    const out = renderWeatherLine({
      code: 1,
      highC: 24,
      lowC: 15,
      unit: 'C',
      chancePct: 60,
      chanceAt: '2026-08-22T14:00',
      chanceCode: 1,
    });
    expect(out).not.toContain('chance');
  });

  it('handles midnight and noon without printing "0 AM"', () => {
    const at = (iso: string) =>
      renderWeatherLine({
        code: 61,
        highC: 10,
        lowC: 5,
        unit: 'C',
        chancePct: 60,
        chanceAt: iso,
        chanceCode: 61,
      });
    expect(at('2026-08-22T00:00')).toContain('around 12 AM');
    expect(at('2026-08-22T12:00')).toContain('around 12 PM');
  });

  it('drops the hour rather than the clause when timing is unknown', () => {
    const out = renderWeatherLine({
      code: 61,
      highC: 10,
      lowC: 5,
      unit: 'C',
      chancePct: 60,
      chanceCode: 61,
    });
    expect(out).toContain('60% chance of light rain');
    expect(out).not.toContain('around');
  });

  it('is always a single line — it becomes a Meta template slot', () => {
    const out = renderWeatherLine({
      code: 95,
      highC: 30,
      lowC: 20,
      unit: 'C',
      chancePct: 90,
      chanceAt: '2026-08-22T17:00',
      chanceCode: 95,
    });
    expect(out).not.toMatch(/[\r\n\t]| {2,}/);
  });
});
