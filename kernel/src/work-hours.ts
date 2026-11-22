/**
 * ADR 0330 — when the user works, so suggested meeting times stay inside it.
 *
 * Pure rules shared by the server's availability rendering and its tests:
 * which local days are work days (weekday set minus holidays) and the work
 * window on each. With nothing set the default is 9 AM–5 PM, Monday to
 * Friday, with US federal holidays off when the user's zone is a US zone.
 */

/** 0 = Sunday … 6 = Saturday, as `Date.getUTCDay()`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface WorkHours {
  days: Weekday[];
  /** Minutes after local midnight. */
  startMinutes: number;
  endMinutes: number;
  /** Take public holidays off. Only the US federal list is known. */
  observeHolidays: boolean;
}

export const DEFAULT_WORK_HOURS: WorkHours = {
  days: [1, 2, 3, 4, 5],
  startMinutes: 9 * 60,
  endMinutes: 17 * 60,
  observeHolidays: true,
};

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const WEEKDAY_KEYS: Record<string, Weekday> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/** "mon", "Monday", "Tues" → 1; anything else → null. */
export function parseWeekday(s: string): Weekday | null {
  return WEEKDAY_KEYS[s.trim().toLowerCase().replace(/\.$/, '')] ?? null;
}

/** "09:00", "9:30", "17:00" → minutes; anything else → null. 24:00 is end of day. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59 || h > 24 || (h === 24 && min !== 0)) return null;
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const ampm = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/** "Mon–Fri" for a run, else "Mon, Wed, Fri". */
export function describeDays(days: readonly Weekday[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 0) return 'no days';
  if (sorted.length === 7) return 'every day';
  const short = (d: Weekday) => WEEKDAY_NAMES[d].slice(0, 3);
  const isRun = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  if (isRun && sorted.length >= 3) return `${short(sorted[0]!)}–${short(sorted[sorted.length - 1]!)}`;
  return sorted.map(short).join(', ');
}

export function describeWorkHours(w: WorkHours): string {
  return `${describeDays(w.days)}, ${formatClock(w.startMinutes)}–${formatClock(w.endMinutes)}${
    w.observeHolidays ? ', public holidays off' : ''
  }`;
}

/** Zones whose public holidays are the US federal ones. */
const US_ZONES = new Set([
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
  'America/Anchorage', 'America/Juneau', 'America/Sitka', 'America/Yakutat', 'America/Nome',
  'America/Metlakatla', 'America/Adak', 'America/Boise', 'America/Detroit', 'America/Menominee',
  'Pacific/Honolulu', 'US/Eastern', 'US/Central', 'US/Mountain', 'US/Pacific', 'US/Alaska', 'US/Hawaii',
  'US/Arizona', 'US/Michigan',
]);

export function isUsZone(tz: string): boolean {
  return (
    US_ZONES.has(tz) ||
    tz.startsWith('America/Indiana/') ||
    tz.startsWith('America/Kentucky/') ||
    tz.startsWith('America/North_Dakota/')
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekdayOf = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** The nth (1-based) given weekday of a month; n = -1 is the last. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = weekdayOf(y, m, 1);
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekdayOf(y, m, lastDay);
  return lastDay - ((last - weekday + 7) % 7);
}

/** A fixed-date holiday on a weekend is observed Friday before / Monday after. */
function observed(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d));
  const wd = date.getUTCDay();
  if (wd === 6) date.setUTCDate(d - 1);
  else if (wd === 0) date.setUTCDate(d + 1);
  return date.toISOString().slice(0, 10);
}

/** US federal holidays (as observed) for one year, `YYYY-MM-DD` → name. */
export function usFederalHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  out.set(observed(year, 1, 1), "New Year's Day");
  out.set(ymd(year, 1, nthWeekday(year, 1, 1, 3)), 'Martin Luther King Jr. Day');
  out.set(ymd(year, 2, nthWeekday(year, 2, 1, 3)), "Presidents' Day");
  out.set(ymd(year, 5, nthWeekday(year, 5, 1, -1)), 'Memorial Day');
  out.set(observed(year, 6, 19), 'Juneteenth');
  out.set(observed(year, 7, 4), 'Independence Day');
  out.set(ymd(year, 9, nthWeekday(year, 9, 1, 1)), 'Labor Day');
  out.set(ymd(year, 10, nthWeekday(year, 10, 1, 2)), 'Columbus Day');
  out.set(observed(year, 11, 11), 'Veterans Day');
  out.set(ymd(year, 11, nthWeekday(year, 11, 4, 4)), 'Thanksgiving Day');
  out.set(observed(year, 12, 25), 'Christmas Day');
  // Next year's New Year's Day observed on 31 Dec of this year.
  const nextNewYear = observed(year + 1, 1, 1);
  if (nextNewYear.startsWith(`${year}-`)) out.set(nextNewYear, "New Year's Day");
  return out;
}

/** The holiday on a local `YYYY-MM-DD`, when the rules take one off there. */
export function holidayOn(day: string, tz: string, w: WorkHours): string | null {
  if (!w.observeHolidays || !isUsZone(tz)) return null;
  const year = Number(day.slice(0, 4));
  return usFederalHolidays(year).get(day) ?? null;
}

export type WorkDay =
  | { work: true; startMinutes: number; endMinutes: number }
  | { work: false; reason: string };

/** Whether a local `YYYY-MM-DD` is a work day and, if so, its window. */
export function workDayOf(day: string, tz: string, w: WorkHours): WorkDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wd = weekdayOf(y, m, d) as Weekday;
  const holiday = holidayOn(day, tz, w);
  if (holiday) return { work: false, reason: `holiday: ${holiday}` };
  if (!w.days.includes(wd)) return { work: false, reason: WEEKDAY_NAMES[wd] };
  return { work: true, startMinutes: w.startMinutes, endMinutes: w.endMinutes };
}
