import { Appearance, StyleSheet } from 'react-native';

export type ColorScheme = 'light' | 'dark';

const lightColors = {
  bg: '#F7F6F2',
  bg2: '#EFEDE8',
  card: '#FFFFFF',
  text: '#1A1A18',
  muted: '#7A7970',
  border: '#E5E3DC',
  accent: '#1A1A18',
  accentDark: '#000000',
  accentLight: '#EFEDE8',
  /** Text and icons drawn ON `accent` (a filled button, an active chip). */
  onAccent: '#FFFFFF',
  leftBubble: '#F1EFE8',
  rightBubble: '#E8E6DF',
  chordBubble: '#EFEDE8',
  red: '#B91C1C',
  green: '#15803D',
  warn: '#B45309',
  /** Pale tints behind a status line (warning, error, success). */
  warnBg: '#FFF7ED',
  redBg: '#FEE2E2',
  greenBg: '#DCFCE7',
  amberBg: '#FEF3C7',
};

export type Palette = typeof lightColors;

const darkColors: Palette = {
  bg: '#141413',
  bg2: '#1E1E1C',
  card: '#1F1F1D',
  text: '#ECEAE3',
  muted: '#9C9A90',
  border: '#34332F',
  accent: '#ECEAE3',
  accentDark: '#FFFFFF',
  accentLight: '#2B2A27',
  onAccent: '#141413',
  leftBubble: '#262522',
  rightBubble: '#302F2B',
  chordBubble: '#2B2A27',
  red: '#F87171',
  green: '#4ADE80',
  warn: '#FBBF24',
  warnBg: '#3A2A14',
  redBg: '#3B1B1B',
  greenBg: '#16301F',
  amberBg: '#3A3014',
};

const palettes: Record<ColorScheme, Palette> = { light: lightColors, dark: darkColors };

/** Email HTML is designed for white paper; the reader keeps it there (ADR 0282). */
export const paperColors: Palette = lightColors;

let active: ColorScheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';

export function activeColorScheme(): ColorScheme {
  return active;
}

/**
 * A one-off colour that is not in the palette. Call it in render or inside a
 * `themed` factory, never into a module-level constant.
 */
export function byScheme<T>(light: T, dark: T): T {
  return active === 'dark' ? dark : light;
}

/** Called by ThemeProvider only; the subtree is remounted right after. */
export function setActiveColorScheme(scheme: ColorScheme): void {
  active = scheme;
}

/**
 * The active palette. Each property is read when it is used, so a value read
 * during render follows the scheme; a value copied into a module-level
 * constant does not (use `themed` for styles).
 */
export const colors: Palette = Object.defineProperties(
  {} as Palette,
  Object.fromEntries(
    (Object.keys(lightColors) as Array<keyof Palette>).map((k) => [
      k,
      { enumerable: true, get: () => palettes[active][k] },
    ]),
  ),
);

/**
 * `StyleSheet.create` for both schemes: the factory is given the palette and
 * built once per scheme on first use; each style is read through a getter, so
 * `styles.row` in render is the active scheme's.
 */
export function themed<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: Palette) => T & StyleSheet.NamedStyles<any>,
): T {
  const built: Partial<Record<ColorScheme, T>> = {};
  const sheet = (): T => (built[active] ??= StyleSheet.create(factory(palettes[active])));
  const out = {} as T;
  for (const key of Object.keys(factory(lightColors))) {
    Object.defineProperty(out, key, { enumerable: true, get: () => (sheet() as any)[key] });
  }
  return out;
}

export const avatarPalette: Array<{ bg: string; fg: string }> = [
  { bg: '#DBEAFE', fg: '#1D4ED8' },
  { bg: '#FCE7F3', fg: '#BE185D' },
  { bg: '#DCFCE7', fg: '#15803D' },
  { bg: '#FEF3C7', fg: '#B45309' },
  { bg: '#EFEDE8', fg: '#1A1A18' },
  { bg: '#D1FAE5', fg: '#065F46' },
  { bg: '#FEE2E2', fg: '#B91C1C' },
  { bg: '#E0F2FE', fg: '#0369A1' },
];

export function avatarFor(seed: string): { bg: string; fg: string; initials: string } {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const c = avatarPalette[hash % avatarPalette.length];
  const initials = seed.slice(0, 2).toUpperCase();
  return { bg: c.bg, fg: c.fg, initials };
}
