/**
 * ADR 0273 — the calendar behind every date field. Kernel has no harness of
 * its own, so it is tested here.
 */
import { describe, expect, it } from 'vitest';

import { addMonths, daysInMonth, formatYmd, monthGrid, parseYmd, pickerYears } from '@chord/kernel';

describe('parseYmd', () => {
  it('reads a real date', () => {
    expect(parseYmd('2026-10-19')).toEqual({ y: 2026, m: 10, d: 19 });
    expect(parseYmd(' 2026-1-5 ')).toEqual({ y: 2026, m: 1, d: 5 });
  });

  it('refuses dates that do not exist', () => {
    expect(parseYmd('2026-02-29')).toBeNull();
    expect(parseYmd('2026-13-01')).toBeNull();
    expect(parseYmd('2026-04-31')).toBeNull();
    expect(parseYmd('19-10-2026')).toBeNull();
    expect(parseYmd('')).toBeNull();
  });

  it('accepts a year-unknown birthday only when asked to', () => {
    expect(parseYmd('0000-05-08')).toBeNull();
    expect(parseYmd('0000-05-08', { allowUnknownYear: true })).toEqual({ y: 0, m: 5, d: 8 });
    expect(parseYmd('0000-02-29', { allowUnknownYear: true })).toEqual({ y: 0, m: 2, d: 29 });
  });
});

describe('formatYmd', () => {
  it('pads, including the unknown year', () => {
    expect(formatYmd({ y: 2026, m: 3, d: 7 })).toBe('2026-03-07');
    expect(formatYmd({ y: 0, m: 5, d: 8 })).toBe('0000-05-08');
  });
});

describe('addMonths', () => {
  it('crosses year boundaries both ways', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ y: 2027, m: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ y: 2025, m: 12 });
    expect(addMonths(2026, 10, -22)).toEqual({ y: 2024, m: 12 });
  });
});

describe('monthGrid', () => {
  it('starts on the Sunday on or before the 1st and covers six weeks', () => {
    const g = monthGrid(2026, 10); // 1 Oct 2026 is a Thursday
    expect(g).toHaveLength(6);
    expect(g.every((w) => w.length === 7)).toBe(true);
    expect(g[0][0]).toEqual({ y: 2026, m: 9, d: 27, inMonth: false });
    expect(g[0][4]).toEqual({ y: 2026, m: 10, d: 1, inMonth: true });
    expect(g.flat().filter((d) => d.inMonth)).toHaveLength(31);
  });

  it('a month starting on Sunday has no leading days', () => {
    const g = monthGrid(2026, 2); // 1 Feb 2026 is a Sunday
    expect(g[0][0]).toEqual({ y: 2026, m: 2, d: 1, inMonth: true });
  });

  it('places old years correctly (Date.UTC maps 0-99 to 19xx)', () => {
    // 1 Jan 0050 was a Saturday in the proleptic Gregorian calendar.
    expect(monthGrid(50, 1)[0][6]).toMatchObject({ y: 50, m: 1, d: 1 });
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
  });
});

describe('pickerYears', () => {
  it('runs newest first and reaches far enough back for a grandparent', () => {
    const ys = pickerYears(new Date(2026, 9, 19));
    expect(ys[0]).toBe(2036);
    expect(ys).toContain(1930);
  });
});
