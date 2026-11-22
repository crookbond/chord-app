/**
 * ADR 0278 — calendar colors. A calendar shows the user's pick, else its
 * provider's color, else the next free color of Chord's own palette (the five
 * figures of the app icon, then a darker and a lighter set of the same). No
 * two calendars look the same unless the user picks the same color for both.
 */

/** The app icon's five colors, then darker and lighter versions of them. */
export const CHORD_CALENDAR_PALETTE: readonly string[] = [
  '#D85A30',
  '#3A8AE0',
  '#1F9E78',
  '#F0A12A',
  '#7F76DE',
  '#A8401F',
  '#2463AE',
  '#15735A',
  '#C27A0E',
  '#5A50B8',
  '#E8876A',
  '#6FAAEA',
  '#4CBB98',
  '#F5BE65',
  '#A39CE8',
];

/** Colors offered in Settings and by name in chat. */
export const CALENDAR_COLOR_CHOICES: readonly { name: string; hex: string }[] = [
  { name: 'orange', hex: '#D85A30' },
  { name: 'red', hex: '#D64545' },
  { name: 'pink', hex: '#D6588F' },
  { name: 'purple', hex: '#7F76DE' },
  { name: 'blue', hex: '#3A8AE0' },
  { name: 'navy', hex: '#2463AE' },
  { name: 'teal', hex: '#14A3A3' },
  { name: 'green', hex: '#1F9E78' },
  { name: 'yellow', hex: '#F0A12A' },
  { name: 'brown', hex: '#8B5E3C' },
  { name: 'gray', hex: '#7A7970' },
  { name: 'black', hex: '#1A1A18' },
];

const NAME_ALIASES: Record<string, string> = {
  grey: 'gray',
  violet: 'purple',
  lavender: 'purple',
  amber: 'yellow',
  gold: 'yellow',
  coral: 'orange',
  crimson: 'red',
  magenta: 'pink',
  turquoise: 'teal',
  cyan: 'teal',
  'dark blue': 'navy',
  'light blue': 'blue',
  'sky blue': 'blue',
};

/**
 * A color as the user gave it — `#abc`, `#aabbcc` (with or without `#`) or a
 * name from `CALENDAR_COLOR_CHOICES` — as uppercase `#RRGGBB`, else null.
 */
export function normalizeCalendarColor(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const hex = s.startsWith('#') ? s.slice(1) : s;
  if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[0-9a-f]{3}$/.test(hex)) {
    return `#${hex
      .split('')
      .map((c) => c + c)
      .join('')
      .toUpperCase()}`;
  }
  const name = NAME_ALIASES[s] ?? s;
  return CALENDAR_COLOR_CHOICES.find((c) => c.name === name)?.hex ?? null;
}

/** The choice name of a color, when it is one of the named ones. */
export function calendarColorName(hex: string | null | undefined): string | null {
  const n = normalizeCalendarColor(hex);
  return CALENDAR_COLOR_CHOICES.find((c) => c.hex === n)?.name ?? null;
}

/** Move a color toward black (negative) or white (positive) by `amount` 0..1. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const ch = (v: number) => Math.round(v + (target - v) * t);
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
}

/** The palette, then ever-slighter shades of it, without end. */
function* paletteColors(): Generator<string> {
  yield* CHORD_CALENDAR_PALETTE;
  for (let round = 1; ; round++) {
    const amount = (round % 2 === 1 ? -1 : 1) * 0.08 * Math.ceil(round / 2);
    for (const base of CHORD_CALENDAR_PALETTE) yield shade(base, Math.max(-0.9, Math.min(0.9, amount)));
  }
}

export interface CalendarColorInput {
  id: string;
  /** The user's pick in Chord; kept exactly. */
  chosen?: string | null;
  /** The color the provider (Google, Outlook, the phone) gives the calendar. */
  sourceColor?: string | null;
}

/** Slight shades of a color, nearest first. */
function* nearbyShades(hex: string): Generator<string> {
  for (let step = 1; step <= 6; step++) {
    yield shade(hex, -0.15 * step);
    yield shade(hex, 0.15 * step);
  }
}

/**
 * Each calendar's display color, in order of preference: the user's pick in
 * Chord (kept as given, so two calendars may share it); else the provider's
 * color, shifted to a slight shade when another calendar already shows it;
 * else the first Chord palette color nobody is using.
 */
export function assignCalendarColors(calendars: readonly CalendarColorInput[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const c of calendars) {
    const picked = normalizeCalendarColor(c.chosen);
    if (picked) {
      out.set(c.id, picked);
      used.add(picked);
    }
  }
  for (const c of calendars) {
    if (out.has(c.id)) continue;
    const source = normalizeCalendarColor(c.sourceColor);
    if (!source) continue;
    let color = source;
    if (used.has(color)) {
      for (const s of nearbyShades(source)) {
        color = s;
        if (!used.has(s)) break;
      }
    }
    out.set(c.id, color);
    used.add(color);
  }
  const next = paletteColors();
  for (const c of calendars) {
    if (out.has(c.id)) continue;
    let color = next.next().value as string;
    while (used.has(color)) color = next.next().value as string;
    out.set(c.id, color);
    used.add(color);
  }
  return out;
}
