import { describe, expect, it } from 'vitest';

import {
  HERO_MAX_FONT,
  HERO_MIN_FONT,
  HERO_NARROW_WIDTH,
  HERO_WIDE_WIDTH,
  heroTypeScale,
} from '@chord/kernel';

describe('heroTypeScale', () => {
  it('leaves the phones the page was designed on at full size', () => {
    // iPhone 14/15 (393) and Pro Max (430) both sit at or past the wide mark.
    expect(heroTypeScale(393).fontSize).toBe(HERO_MAX_FONT);
    expect(heroTypeScale(430).fontSize).toBe(HERO_MAX_FONT);
    expect(heroTypeScale(768).fontSize).toBe(HERO_MAX_FONT);
  });

  it('shrinks the hero on a 360dp Android phone', () => {
    // The reported device. 44pt wrapped the hero onto four lines there.
    const { fontSize, lineHeight } = heroTypeScale(360);
    expect(fontSize).toBeLessThan(HERO_MAX_FONT);
    expect(fontSize).toBeGreaterThanOrEqual(HERO_MIN_FONT);
    expect(lineHeight).toBeGreaterThan(fontSize);
  });

  it('never goes below the floor on the narrowest phones', () => {
    expect(heroTypeScale(320).fontSize).toBe(HERO_MIN_FONT);
    expect(heroTypeScale(280).fontSize).toBe(HERO_MIN_FONT);
    expect(heroTypeScale(HERO_NARROW_WIDTH).fontSize).toBe(HERO_MIN_FONT);
  });

  it('grows with the screen, never shrinks', () => {
    const widths = [300, 320, 340, 360, 375, 390, 400, 430, 600];
    const sizes = widths.map((w) => heroTypeScale(w).fontSize);
    for (let i = 1; i < sizes.length; i += 1) {
      expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    }
  });

  it('falls back to full size when the width is unreadable', () => {
    // An unmeasured viewport must not silently shrink a page that has rendered
    // at 44pt since it was written.
    expect(heroTypeScale(0).fontSize).toBe(HERO_MAX_FONT);
    expect(heroTypeScale(Number.NaN).fontSize).toBe(HERO_MAX_FONT);
    expect(heroTypeScale(null).fontSize).toBe(HERO_MAX_FONT);
    expect(heroTypeScale(undefined).fontSize).toBe(HERO_MAX_FONT);
  });

  it('keeps the line height proportional at both ends', () => {
    for (const w of [HERO_NARROW_WIDTH, HERO_WIDE_WIDTH]) {
      const { fontSize, lineHeight } = heroTypeScale(w);
      const ratio = lineHeight / fontSize;
      expect(ratio).toBeGreaterThan(1.1);
      expect(ratio).toBeLessThan(1.2);
    }
  });
});
