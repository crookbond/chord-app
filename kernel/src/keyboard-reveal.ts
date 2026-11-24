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

/**
 * How much of a view the Android keyboard covers. React Native's
 * `measureInWindow` on Android reports y from the bottom of the status bar
 * (it subtracts the visible display frame's top), while `keyboardDidShow`'s
 * `screenY` is measured from the top of the screen. Without adding the status
 * bar back, a view's bottom reads that much higher than it is, and a
 * composer padded by the result sits under the keyboard on an edge-to-edge
 * window (Android 15+, which no longer shrinks for the keyboard).
 */
export function androidKeyboardOverlap(input: {
  /** Bottom of the view from `measureInWindow` (y + height). */
  viewBottomInWindow: number;
  /** `endCoordinates.screenY` of the keyboard event. */
  keyboardScreenY: number;
  /** Status bar height (`StatusBar.currentHeight`). */
  statusBarHeight: number;
}): number {
  return Math.max(0, input.viewBottomInWindow + input.statusBarHeight - input.keyboardScreenY);
}
