/**
 * Quiet-hours evaluation for push notifications (ADR 0054). Pure + unit-tested.
 *
 * Converts `now` into the user's local wall-clock minute-of-day using the same
 * `toLocaleString('sv-SE', { timeZone })` technique as `nextScanDate()` in
 * `proactive.service.ts`, then tests it against the [start, end) window. The
 * window may wrap past midnight (e.g. 22:00 → 07:00).
 */

export interface QuietWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** Minute-of-day (0..1439) for `now` in the given IANA tz. Falls back to the
 *  server's local clock when tz is missing/invalid. */
export function localMinuteOfDay(now: Date, tz?: string | null): number {
  if (tz) {
    try {
      const local = now.toLocaleString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD HH:MM:SS"
      const [, timePart] = local.split(' ');
      const [h, m] = timePart.split(':').map(Number);
      return h * 60 + m;
    } catch {
      /* invalid tz → fall through to server local */
    }
  }
  return now.getHours() * 60 + now.getMinutes();
}

export function isQuietNow(
  tz: string | null | undefined,
  win: QuietWindow,
  now: Date,
): boolean {
  const cur = localMinuteOfDay(now, tz);
  const start = win.startHour * 60 + win.startMinute;
  const end = win.endHour * 60 + win.endMinute;
  if (start === end) return false; // zero-length window = never quiet
  if (start < end) return cur >= start && cur < end; // same-day window
  return cur >= start || cur < end; // wraps past midnight
}
