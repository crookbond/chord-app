/**
 * ADR 0273 — the calendar behind every date field. Pure, so it can be tested
 * (mobile has no test harness) and shared by web and native.
 *
 * Dates are `YYYY-MM-DD` strings throughout, matching what the fields already
 * store. Year `0000` means "year unknown" (People birthdays, ADR 0016).
 */

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

export interface GridDay extends Ymd {
  inMonth: boolean;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function daysInMonth(y: number, m: number): number {
  // Year 0 is a leap year in the proleptic calendar, so 29 Feb survives.
  return new Date(Date.UTC(y === 0 ? 2000 : y, m, 0)).getUTCDate();
}

/** `YYYY-MM-DD` → parts, or null for anything that is not a real date. */
export function parseYmd(s: string | null | undefined, opts: { allowUnknownYear?: boolean } = {}): Ymd | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec((s ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y === 0 && !opts.allowUnknownYear) return null;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function formatYmd(v: Ymd): string {
  return `${pad(v.y, 4)}-${pad(v.m)}-${pad(v.d)}`;
}

export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const i = y * 12 + (m - 1) + delta;
  return { y: Math.floor(i / 12), m: (i % 12) + 1 };
}

/** Six Sunday-first weeks covering month `m` of year `y`. */
export function monthGrid(y: number, m: number): GridDay[][] {
  const first = new Date(Date.UTC(2000, m - 1, 1));
  first.setUTCFullYear(y); // Date.UTC maps years 0-99 to 19xx
  const lead = first.getUTCDay();
  const weeks: GridDay[][] = [];
  let cur = addMonths(y, m, -1);
  let day = daysInMonth(cur.y, cur.m) - lead + 1;
  if (lead === 0) {
    cur = { y, m };
    day = 1;
  }
  for (let w = 0; w < 6; w++) {
    const week: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ y: cur.y, m: cur.m, d: day, inMonth: cur.y === y && cur.m === m });
      day += 1;
      if (day > daysInMonth(cur.y, cur.m)) {
        cur = addMonths(cur.y, cur.m, 1);
        day = 1;
      }
    }
    weeks.push(week);
  }
  return weeks;
}

export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Today's date on the device clock. */
export function todayYmd(now: Date = new Date()): Ymd {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

export function sameYmd(a: Ymd | null, b: Ymd | null): boolean {
  return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
}

/** Years offered by the year list, newest first. */
export function pickerYears(now: Date = new Date(), back = 120, ahead = 10): number[] {
  const top = now.getFullYear() + ahead;
  return Array.from({ length: back + ahead + 1 }, (_, i) => top - i);
}
