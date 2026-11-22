/**
 * A sideways swipe on the calendar moves by what the view shows (a day, the
 * multi-day span, a month), like the header's ‹ › buttons. The page follows
 * the finger, as in Apple and Google Calendar: swiping left pushes today off
 * to the left and brings in the next day; swiping right goes back.
 */

/** A drag this far sideways counts on its own. */
export const SWIPE_MIN_DISTANCE = 50;
/** A shorter flick counts when it is this fast (points per second). */
export const SWIPE_FLICK_DISTANCE = 20;
export const SWIPE_FLICK_VELOCITY = 500;

/**
 * What a finished drag does: +1 forward, -1 back, 0 nothing. A drag that is
 * mostly up or down is the hour grid scrolling, not a swipe.
 */
export function calendarSwipeStep(drag: { dx: number; dy: number; vx: number }): -1 | 0 | 1 {
  const ax = Math.abs(drag.dx);
  if (ax < Math.abs(drag.dy) * 1.5) return 0;
  const far = ax >= SWIPE_MIN_DISTANCE;
  const flick =
    ax >= SWIPE_FLICK_DISTANCE &&
    Math.abs(drag.vx) >= SWIPE_FLICK_VELOCITY &&
    Math.sign(drag.vx) === Math.sign(drag.dx);
  if (!far && !flick) return 0;
  return drag.dx < 0 ? 1 : -1;
}
