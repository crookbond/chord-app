/**
 * The landing hero, sized for the screen it is on.
 *
 * A fixed 44pt wrapped "Convert your email to action items." onto four lines on
 * a ~360dp Android phone and filled the screen, while the same words read as
 * three balanced lines on a 390-430dp iPhone. Width is the input, so the phones
 * the page already looked right on barely move.
 *
 * Pure + here rather than in the screen because mobile/ has no test harness
 * (ADR 0120/0121).
 */

/** Below this width the hero is at its smallest. */
export const HERO_NARROW_WIDTH = 340;
/**
 * At or above this width the hero is the size the page was designed at.
 *
 * 390 rather than a rounder 400 so every current iPhone - 390 (14/15), 393
 * (14/15 Pro), 428/430 (Max) - lands on the full size and the page the owner
 * likes on iOS does not move at all.
 */
export const HERO_WIDE_WIDTH = 390;

export const HERO_MIN_FONT = 34;
export const HERO_MAX_FONT = 44;

/** The ratio the hand-set 44/50 pair used. */
const LINE_HEIGHT_RATIO = 1.14;

export type HeroType = { fontSize: number; lineHeight: number };

/**
 * Hero type for a viewport `width` in dp.
 *
 * A width that is missing or nonsense falls back to the wide size rather than
 * the narrow one: the page has rendered at 44pt since it was written, so an
 * unreadable measurement should not silently shrink it.
 */
export function heroTypeScale(width: number | null | undefined): HeroType {
  const usable = typeof width === 'number' && Number.isFinite(width) && width > 0;
  const w = usable ? width : HERO_WIDE_WIDTH;

  const span = HERO_WIDE_WIDTH - HERO_NARROW_WIDTH;
  const t = (w - HERO_NARROW_WIDTH) / span;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;

  const fontSize = Math.round(HERO_MIN_FONT + (HERO_MAX_FONT - HERO_MIN_FONT) * clamped);
  return { fontSize, lineHeight: Math.round(fontSize * LINE_HEIGHT_RATIO) };
}
