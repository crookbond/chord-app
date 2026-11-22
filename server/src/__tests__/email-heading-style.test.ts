import { describe, expect, it } from 'vitest';

import { emailHeadingStyle } from '@chord/kernel';

describe('emailHeadingStyle', () => {
  it.each([
    ['School', '🎒'],
    ['Travel', '🧳'],
    ['Flights', '✈️'],
    ['Deliveries', '📦'],
    ['Receipts', '🧾'],
    ['Coupons', '🏷️'],
    ['Bills & payments', '💳'],
    ['Events & invites', '🎉'],
    ['Social & professional', '💼'],
    ['Newsletters', '📰'],
    ['To-dos', '✅'],
    ['Events', '🎉'],
    ['Lists', '📝'],
  ])('%s gets %s', (title, emoji) => {
    expect(emailHeadingStyle(title).emoji).toBe(emoji);
  });

  it('gives an unknown title an envelope and the same colour every time', () => {
    const a = emailHeadingStyle('Zorblax updates');
    expect(a.emoji).toBe('✉️');
    expect(emailHeadingStyle('Zorblax updates')).toEqual(a);
    expect(a.fg).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('gives dark mode a dark tint behind light text, same emoji', () => {
    const light = emailHeadingStyle('School');
    const dark = emailHeadingStyle('School', 'dark');
    expect(dark.emoji).toBe(light.emoji);
    expect(luminance(dark.bg)).toBeLessThan(0.1);
    expect(luminance(dark.fg)).toBeGreaterThan(0.4);
    expect(emailHeadingStyle('Zorblax updates', 'dark')).toEqual(emailHeadingStyle('Zorblax updates', 'dark'));
  });
});

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('emailHeadingStyle (light)', () => {
  it('defaults to the light tints', () => {
    expect(luminance(emailHeadingStyle('School').bg)).toBeGreaterThan(0.6);
  });
});
