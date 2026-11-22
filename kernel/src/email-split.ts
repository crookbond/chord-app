/**
 * ADR 0320 — the mail list stays beside the reader on a wide screen, so the
 * email you are answering is not the last thing you see before the composer
 * takes the window. The divider is draggable and the width is per device.
 *
 * In kernel because `mobile/` has no test harness (ADR 0120/0121's reason) and
 * because the pane, the divider and the stored width must agree about what a
 * legal width is — three copies of a clamp is how they stop agreeing.
 */

/** Below this the screen cannot hold both panes; one column, as before. */
export const SPLIT_MIN_WINDOW = 900;
/** Narrower than this a row shows a sender and nothing else useful. */
export const PANE_MIN = 260;
/** HTML mail scrolls sideways under this, and the composer body gets cramped. */
export const READER_MIN = 420;
/** The grab strip between the two panes. */
export const DIVIDER_WIDTH = 8;

/** Is there room for both panes at this window width? */
export function splitFits(windowWidth: number): boolean {
  return (
    windowWidth >= SPLIT_MIN_WINDOW &&
    windowWidth - DIVIDER_WIDTH - READER_MIN >= PANE_MIN
  );
}

/** Half the window, which is what the pane opens at before anyone drags it. */
export function defaultPaneWidth(windowWidth: number): number {
  return clampPaneWidth(windowWidth, Math.round(windowWidth / 2));
}

/**
 * The nearest legal width. A window that shrank (a resized browser, a rotated
 * tablet) takes the reader's minimum off the pane rather than letting the
 * stored width squeeze the reader out.
 */
export function clampPaneWidth(windowWidth: number, width: number): number {
  const max = windowWidth - DIVIDER_WIDTH - READER_MIN;
  if (max <= PANE_MIN) return PANE_MIN;
  return Math.min(Math.max(Math.round(width), PANE_MIN), max);
}

/** Where a drag that started at `startWidth` and has moved `dx` leaves it. */
export function draggedPaneWidth(windowWidth: number, startWidth: number, dx: number): number {
  return clampPaneWidth(windowWidth, startWidth + dx);
}

/** A stored width is only as good as the window it is read into. */
export function storedPaneWidth(windowWidth: number, stored: number | null): number {
  return stored === null || !Number.isFinite(stored)
    ? defaultPaneWidth(windowWidth)
    : clampPaneWidth(windowWidth, stored);
}
