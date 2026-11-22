/**
 * The new-message composer as a sheet / popout window (ADR 0341).
 *
 * Pure rules shared by the app, kept here because `mobile/` has no test
 * harness (ADR 0120/0121).
 */

/**
 * Which mailbox a new message opens on.
 *
 * `selected` is the Email list's mailbox chip (ADR 0119): `'primary'` for the
 * Gmail on the user row, an `email_accounts.id`, or undefined for "All". A
 * mailbox the user is looking at wins over the default chosen in chat
 * (ADR 0255); with "All" selected there is nothing to prefer, so the default
 * stands. Returns null for the primary Gmail, undefined for "no preference".
 */
export function composeFromAccount(
  selected: string | null | undefined,
  defaultAccount: string | null | undefined,
): string | null | undefined {
  if (selected === 'primary') return null;
  if (selected) return selected;
  return defaultAccount;
}

/** How the composer is laid out on this window. */
export type ComposeLayout = 'popout' | 'sheet';

/** Narrower than this, a floating window would cover most of the screen anyway. */
export const COMPOSE_POPOUT_MIN_WINDOW = 768;

/** A floating window on a wide web page; a sheet everywhere else. */
export function composeLayout(platform: string, windowWidth: number): ComposeLayout {
  return platform === 'web' && windowWidth >= COMPOSE_POPOUT_MIN_WINDOW ? 'popout' : 'sheet';
}

/** The popout's size: Gmail-like in the corner, or most of the window when expanded. */
export function composePopoutSize(
  window: { width: number; height: number },
  expanded: boolean,
): { width: number; height: number } {
  const margin = 24;
  if (expanded) {
    return {
      width: Math.min(1000, window.width - margin * 2),
      height: Math.min(900, window.height - margin * 2),
    };
  }
  return {
    width: Math.min(560, window.width - margin * 2),
    height: Math.min(640, window.height - margin * 2),
  };
}

/** A pull this far down, or a flick this fast, puts the message away. */
export const SHEET_DISMISS_DISTANCE = 120;
export const SHEET_DISMISS_VELOCITY = 1.0; // points per ms, as PanResponder reports

/** Does a swipe down that ended here close the sheet (saving the draft)? */
export function sheetSwipeDismisses(dy: number, vy: number): boolean {
  if (dy <= 0) return false;
  return dy >= SHEET_DISMISS_DISTANCE || (vy >= SHEET_DISMISS_VELOCITY && dy >= 24);
}

/** A drag starts only when it is clearly downward, so taps and sideways moves stay buttons. */
export function sheetDragStarts(dx: number, dy: number): boolean {
  return dy > 8 && dy > Math.abs(dx) * 1.5;
}
