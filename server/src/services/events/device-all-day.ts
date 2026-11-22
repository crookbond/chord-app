/**
 * ADR 0057 addendum — the day a phone's all-day event is on.
 *
 * A phone does not send an all-day event as a date. iOS (EventKit) sends the
 * instant of LOCAL midnight ("2026-07-04T04:00:00.000Z" in New York,
 * "2026-07-03T18:30:00.000Z" in Kolkata), Android (CalendarContract) sends
 * UTC midnight ("2026-07-04T00:00:00.000Z" wherever the phone is). Google and
 * Outlook all-day rows are stored floating ("2026-07-04T00:00:00", ADR 0040).
 * Comparing any of these as instants never matches, so the date is what gets
 * compared, and what a phone's all-day row is stored as.
 */
import { instantMs } from '../../db/text-instant.js';
import { dayOf, hasZone, isAllDayValue } from '../../utils/tz.js';

const DAY_MS = 86_400_000;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(ymd: string, n: number): string {
  return utcDate(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS);
}

/**
 * The date of the UTC midnight nearest `ms`: right for every zone from −11
 * to +11 hours, used only when the phone's zone is not known.
 */
function nearestMidnightDate(ms: number): string {
  return utcDate(Math.round(ms / DAY_MS) * DAY_MS);
}

/**
 * The calendar date an all-day START names. Floating or bare dates are taken
 * as written; exact UTC midnight is Android's encoding (and any zone at UTC+0)
 * so it is the UTC date; anything else is a local midnight read in `tz`.
 */
export function allDayStartDate(iso: string, tz: string | null | undefined): string {
  if (!hasZone(iso)) return iso.slice(0, 10);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  if (ms % DAY_MS === 0) return utcDate(ms);
  return tz ? dayOf(iso, tz) : nearestMidnightDate(ms);
}

/**
 * The exclusive end date of an all-day END (the Google convention: a one-day
 * event on the 4th ends on the 5th). iOS sends 23:59:59 local or the next
 * local midnight, Android the next UTC midnight; both land on the same date.
 */
export function allDayEndDate(iso: string, tz: string | null | undefined): string {
  if (!hasZone(iso)) return iso.slice(0, 10);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.slice(0, 10);
  if (ms % DAY_MS === 0) return utcDate(ms);
  if (!tz) return nearestMidnightDate(ms);
  return addDays(dayOf(new Date(ms - 1).toISOString(), tz), 1);
}

/** A stored row is all-day by its flag or by its floating-midnight shape. */
export function rowIsAllDay(row: { starts_at: string; all_day?: number | null }): boolean {
  return Number(row.all_day) === 1 || isAllDayValue(row.starts_at);
}

/**
 * Do two events start at the same moment? Timed: the same instant. All-day:
 * the same date, however each side encoded it. One of each never matches.
 */
export function sameEventStart(
  a: { startsAt: string; allDay: boolean },
  b: { startsAt: string; allDay: boolean },
  tz: string | null | undefined,
): boolean {
  if (a.allDay !== b.allDay) return false;
  if (a.allDay) return allDayStartDate(a.startsAt, tz) === allDayStartDate(b.startsAt, tz);
  return instantMs(a.startsAt) === instantMs(b.startsAt);
}
