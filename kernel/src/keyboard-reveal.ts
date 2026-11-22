/**
 * ADR 0297 — how far a scroll view must move so a focused text box sits above
 * the on-screen keyboard. Pure, so the server's harness tests it.
 */

/** Space left between the box and the top of the keyboard. */
export const KEYBOARD_REVEAL_MARGIN = 24;

/**
 * Points to scroll DOWN (positive) so the box is visible, or 0 when it already
 * is. A box taller than the space left keeps its top in view rather than its
 * bottom, so the caret line is never pushed off the top of the screen.
 */
export function keyboardRevealDelta(input: {
  /** Box top and height in window coordinates. */
  boxTop: number;
  boxHeight: number;
  windowHeight: number;
  keyboardHeight: number;
  /** Window y of the top of the visible area (below a header). */
  visibleTop?: number;
  margin?: number;
}): number {
  if (input.keyboardHeight <= 0) return 0;
  const margin = input.margin ?? KEYBOARD_REVEAL_MARGIN;
  const visibleTop = input.visibleTop ?? 0;
  const visibleBottom = input.windowHeight - input.keyboardHeight - margin;
  const boxBottom = input.boxTop + input.boxHeight;
  if (boxBottom <= visibleBottom) return 0;
  const toFitBottom = boxBottom - visibleBottom;
  const toKeepTop = input.boxTop - (visibleTop + margin);
  return Math.max(0, Math.min(toFitBottom, toKeepTop));
}
