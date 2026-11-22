import { describe, expect, it } from 'vitest';

import {
  assignCalendarColors,
  CHORD_CALENDAR_PALETTE,
  calendarColorName,
  normalizeCalendarColor,
} from '@chord/kernel';

describe('normalizeCalendarColor (ADR 0278)', () => {
  it('reads hex in any of its spellings and names from the choice list', () => {
    expect(normalizeCalendarColor('#3a8ae0')).toBe('#3A8AE0');
    expect(normalizeCalendarColor('3a8ae0')).toBe('#3A8AE0');
    expect(normalizeCalendarColor('#abc')).toBe('#AABBCC');
    expect(normalizeCalendarColor('Blue')).toBe('#3A8AE0');
    expect(normalizeCalendarColor('grey')).toBe('#7A7970');
    expect(calendarColorName('#3a8ae0')).toBe('blue');
  });

  it('refuses what is not a color', () => {
    expect(normalizeCalendarColor('')).toBeNull();
    expect(normalizeCalendarColor('chartreuse-ish')).toBeNull();
    expect(normalizeCalendarColor('#12345')).toBeNull();
    expect(normalizeCalendarColor(null)).toBeNull();
  });
});

describe('assignCalendarColors (ADR 0278)', () => {
  it('uses the provider color when the user has not picked one', () => {
    const m = assignCalendarColors([
      { id: 'a', sourceColor: '#039be5' },
      { id: 'b', sourceColor: '#7986cb' },
    ]);
    expect(m.get('a')).toBe('#039BE5');
    expect(m.get('b')).toBe('#7986CB');
  });

  it("a user's pick beats the provider color", () => {
    const m = assignCalendarColors([{ id: 'a', sourceColor: '#039be5', chosen: 'green' }]);
    expect(m.get('a')).toBe('#1F9E78');
  });

  it('two calendars with the same provider color end up slightly different', () => {
    const m = assignCalendarColors([
      { id: 'a', sourceColor: '#039be5' },
      { id: 'b', sourceColor: '#039be5' },
    ]);
    expect(m.get('a')).toBe('#039BE5');
    expect(m.get('b')).not.toBe('#039BE5');
    expect(m.get('b')).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('keeps the same color when the user picks it twice', () => {
    const m = assignCalendarColors([
      { id: 'a', chosen: '#D85A30' },
      { id: 'b', chosen: 'orange' },
    ]);
    expect(m.get('a')).toBe('#D85A30');
    expect(m.get('b')).toBe('#D85A30');
  });

  it('a provider color that matches a pick is shifted, not the pick', () => {
    const m = assignCalendarColors([
      { id: 'a', sourceColor: '#3A8AE0' },
      { id: 'b', chosen: 'blue' },
    ]);
    expect(m.get('b')).toBe('#3A8AE0');
    expect(m.get('a')).not.toBe('#3A8AE0');
  });

  it('calendars with no color take the Chord palette in order, skipping colors in use', () => {
    const m = assignCalendarColors([
      { id: 'a', chosen: CHORD_CALENDAR_PALETTE[0] },
      { id: 'b' },
      { id: 'c' },
    ]);
    expect(m.get('b')).toBe(CHORD_CALENDAR_PALETTE[1]);
    expect(m.get('c')).toBe(CHORD_CALENDAR_PALETTE[2]);
  });

  it('every calendar is distinct even past the end of the palette', () => {
    const cals = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}` }));
    const colors = [...assignCalendarColors(cals).values()];
    expect(new Set(colors).size).toBe(40);
  });
});
