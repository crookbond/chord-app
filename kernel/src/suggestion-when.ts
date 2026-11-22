/**
 * How a suggestion's date reads on a card: "Wed, Nov 25, 3:30 PM", never the
 * ISO string its tool call carries. One rule for every surface that shows a
 * pending suggestion (Action Items, the Tasks tab, the calendar strip, the
 * email cards, and the chat/WhatsApp/Telegram card the server builds).
 *
 * Three shapes reach it:
 * - an instant with an offset or `Z` - shown in the viewer's zone;
 * - a floating time with no zone - shown as written (it already IS the
 *   user's wall clock);
 * - a date, or floating midnight (ADR 0040 all-day) - shown as a date only,
 *   read from its digits so no zone can move it to the day before. `allDay`
 *   says the same of a stored `…T00:00:00Z`.
 *
 * Anything that is not a date reads as null, so a caller drops it rather than
 * printing what it was given.
 */
export interface SuggestionWhenOptions {
  /** false = the date alone (a to-do's due day). Default true. */
  withTime?: boolean;
  /** Default true: "Wed, Nov 25". */
  weekday?: boolean;
  /** The suggestion says it is all day (`create_event.allDay`). */
  allDay?: boolean;
  /** Zone to show an instant in. Default: the device's. */
  timeZone?: string;
  /**
   * 'written' shows an instant on the clock its own offset names - a flight
   * leg on its airport's clock (ADR 0240), a reservation on the venue's
   * (ADR 0245), as the ticket prints it. Default 'viewer'.
   */
  clock?: 'viewer' | 'written';
  /** Default: the device's. */
  locale?: string;
}

const SHAPE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

export function suggestionWhen(value: unknown, opts: SuggestionWhenOptions = {}): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const withTime = opts.withTime !== false;
  const base: Intl.DateTimeFormatOptions = {
    ...(opts.weekday === false ? {} : { weekday: 'short' }),
    month: 'short',
    day: 'numeric',
  };
  const timeParts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const fmt = (ms: number, timeZone: string | undefined, time: boolean): string | null => {
    try {
      return new Intl.DateTimeFormat(opts.locale, { ...base, ...(time ? timeParts : {}), timeZone }).format(ms);
    } catch {
      return null;
    }
  };

  const m = SHAPE.exec(value.trim());
  if (!m) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : fmt(ms, opts.timeZone, withTime);
  }
  const [, y, mo, d, hh, mi, ss, zone] = m;
  const midnight = hh === undefined || (hh === '00' && mi === '00' && (ss ?? '00') === '00');
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mi ?? 0));
  if (Number.isNaN(wall)) return null;
  // A date, floating midnight, or a midnight the caller says is all day.
  if (hh === undefined || (midnight && (!zone || opts.allDay))) return fmt(wall, 'UTC', false);
  if (!zone || opts.clock === 'written') return fmt(wall, 'UTC', withTime);
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : fmt(ms, opts.timeZone, withTime);
}
