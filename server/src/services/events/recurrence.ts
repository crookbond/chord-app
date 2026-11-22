/**
 * ADR 0217 — the repeat rules Chord can say, store and expand.
 *
 * The model never writes an RRULE: it passes a `RepeatSpec`, the server builds
 * the rule, and this module expands it into wall-clock occurrences. Expansion
 * works on local calendar dates (Y-M-D arithmetic, no instants), so "every
 * Wednesday 3:30" stays 3:30 on both sides of a daylight-saving change; the
 * offset for each occurrence is applied afterwards, for that date.
 */
import { offsetForLocalDatetime, svWall } from '../../utils/tz.js';

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface RepeatSpec {
  frequency: Frequency;
  /** Every N periods; default 1. */
  interval?: number;
  /** Weekly only: which days. Defaults to the first occurrence's weekday. */
  weekdays?: Weekday[];
  /** Monthly only: on the Nth weekday of the month (1-4, or -1 for last),
   *  using the first occurrence's weekday. Absent = the same date each month. */
  monthlyWeek?: 1 | 2 | 3 | 4 | -1;
  /** Last day it may occur on (YYYY-MM-DD, inclusive, in the event's zone). */
  until?: string;
  /** Stop after this many occurrences. */
  count?: number;
}

export interface ParsedRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byDay: Weekday[];
  /** Monthly Nth weekday (1-4, -1). */
  byDayOrdinal: number | null;
  byMonthDay: number | null;
  /** Local inclusive end date (YYYY-MM-DD). */
  untilDate: string | null;
  count: number | null;
}

/** Most occurrences one series ever materializes at once. */
export const MAX_OCCURRENCES = 500;

const FREQ: Record<Frequency, ParsedRule['freq']> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
  yearly: 'YEARLY',
};

/** `YYYY-MM-DDTHH:mm:ss` wall clock → its parts. */
function parts(local: string): { y: number; m: number; d: number; time: string } {
  const [date, time = '00:00:00'] = local.split('T');
  const [y, m, d] = date!.split('-').map(Number);
  return { y: y!, m: m!, d: d!, time: time.slice(0, 8) };
}

/** Days since the epoch for a calendar date (pure date arithmetic). */
function dayNumber(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

function fromDayNumber(n: number): { y: number; m: number; d: number } {
  const dt = new Date(n * 86_400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Throws with a sentence the bot can relay when a spec cannot be a rule. */
export function validateRepeat(spec: RepeatSpec): void {
  if (spec.interval !== undefined && (!Number.isInteger(spec.interval) || spec.interval < 1 || spec.interval > 52)) {
    throw new Error('interval must be a whole number from 1 to 52');
  }
  if (spec.weekdays && spec.frequency !== 'weekly') {
    throw new Error('weekdays only applies to a weekly repeat');
  }
  if (spec.monthlyWeek !== undefined && spec.frequency !== 'monthly') {
    throw new Error('monthlyWeek only applies to a monthly repeat');
  }
  if (spec.until && !/^\d{4}-\d{2}-\d{2}$/.test(spec.until)) {
    throw new Error('until must be a date, YYYY-MM-DD');
  }
  if (spec.count !== undefined && (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > MAX_OCCURRENCES)) {
    throw new Error(`count must be from 1 to ${MAX_OCCURRENCES}`);
  }
}

/**
 * Does the person's own message say ANYTHING that sounds like a repeat?
 *
 * Prod (2026-10): twice, on two differently-worded one-time requests with
 * no recurrence language at all ("Call with AHF at noon tomorrow"), the
 * model attached an invalid `repeat` anyway (self-contradictory - a
 * modifier set for the wrong frequency, e.g. `monthlyWeek` on a `daily`
 * repeat) - a hallucination, not a misunderstood request. Refusing the
 * WHOLE event over a repeat nobody asked for is worse than the thing it
 * guards against (ADR 0217's own motivating bug: silently creating a
 * one-off and claiming it repeats) - that bug was about a user who DID ask
 * for a repeat. This check is deliberately coarse and permissive: a false
 * positive (real recurrence language in there somewhere) just keeps
 * today's refuse-and-ask behavior, so it fails toward the safer, already-
 * shipped default.
 */
export function looksLikeRecurrenceRequest(text: string): boolean {
  // The plural day names and the "-ly" words matter since ADR 0229: this now
  // decides whether a VALID repeat is kept, so "soccer on Tuesdays" reading as
  // a one-time request would lose a repeat the person asked for.
  return /\b(repeat\w*|recur\w*|every|each\s+(day|week|month|year|weekday|morning|evening|night|(mon|tues|wednes|thurs|fri|satur|sun)day)|daily|nightly|weekly|bi-?weekly|fortnight(ly)?|monthly|quarterly|yearly|annually|annual|weekdays|weeknights|weekends|(mon|tues|wednes|thurs|fri|satur|sun)days|standing|regularly)\b/i.test(
    text,
  );
}

const SAYS_AN_END =
  /\b(until|till|til|through|thru|ending|ends?|stops?|last day|end of|for (the )?(next )?(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|few|couple of)\s+(days?|weeks?|months?|years?|times|sessions|classes|lessons)|\d+\s+(times|sessions|classes|lessons|weeks|months)|(this|the) (school )?(year|semester|term|season|summer|fall|autumn|spring|winter))\b/i;
const SAYS_A_WEEK_OF_MONTH = /\b(first|second|third|fourth|last|1st|2nd|3rd|4th)\b/i;
const SAYS_AN_INTERVAL =
  /\b(every (other|\d+|two|three|four|five|six)|alternate|alternating|bi-?weekly|bi-?monthly|fortnight(ly)?)\b/i;
const SAYS_SOME_WEEKDAYS =
  /\b(weekdays?|weeknights?|weekends?|(mon|tues|wednes|thurs|fri|satur|sun)days?|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i;

/**
 * Keep only the parts of a repeat the person's words support.
 *
 * Through OpenRouter, OpenAI models fill every optional field of a tool call,
 * so "every Tuesday" arrived as `{ frequency: weekly, monthlyWeek: 1,
 * count: 1, until: <a made-up date, sometimes before the start>, … }` -
 * which validation refused, and which would have stored a series of one if it
 * had not. `userWords` is the user's own recent messages; null (no message to
 * read: ingest, a proposal confirm) returns the spec unchanged, so a
 * contradiction there is still refused rather than guessed at.
 */
export function trimRepeatToRequest(
  spec: RepeatSpec,
  userWords: string[] | null,
  firstLocalDate: string,
): RepeatSpec {
  if (userWords === null) return spec;
  const said = userWords.join('\n');
  const out: RepeatSpec = { frequency: spec.frequency };
  if (spec.interval !== undefined && spec.interval !== 1 && SAYS_AN_INTERVAL.test(said)) {
    out.interval = spec.interval;
  }
  if (spec.weekdays?.length) {
    if (spec.frequency === 'weekly') out.weekdays = spec.weekdays;
    else if (spec.frequency === 'daily' && SAYS_SOME_WEEKDAYS.test(said)) {
      out.frequency = 'weekly';
      out.weekdays = spec.weekdays;
    }
  }
  if (spec.monthlyWeek !== undefined && spec.frequency === 'monthly' && SAYS_A_WEEK_OF_MONTH.test(said)) {
    out.monthlyWeek = spec.monthlyWeek;
  }
  const endAsked = SAYS_AN_END.test(said);
  if (spec.until && endAsked && spec.until >= firstLocalDate.slice(0, 10)) out.until = spec.until;
  if (spec.count !== undefined && spec.count > 1 && endAsked) out.count = spec.count;
  return out;
}

/**
 * The RRULE body for a spec, anchored on the first occurrence's local start.
 * UNTIL is written as a local date and converted by the caller when a
 * provider needs UTC (see `rruleForGoogle`).
 */
export function buildRrule(spec: RepeatSpec, firstLocal: string): string {
  validateRepeat(spec);
  const { y, m, d } = parts(firstLocal);
  const out = [`FREQ=${FREQ[spec.frequency]}`];
  if (spec.interval && spec.interval > 1) out.push(`INTERVAL=${spec.interval}`);
  const startDay = WEEKDAYS[weekdayIndex(y, m, d)]!;
  if (spec.frequency === 'weekly') {
    const days = spec.weekdays?.length ? [...new Set(spec.weekdays)] : [startDay];
    days.sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
    out.push(`BYDAY=${days.join(',')}`);
  } else if (spec.frequency === 'monthly') {
    out.push(spec.monthlyWeek !== undefined ? `BYDAY=${spec.monthlyWeek}${startDay}` : `BYMONTHDAY=${d}`);
  }
  if (spec.until) out.push(`UNTIL=${spec.until.replace(/-/g, '')}`);
  else if (spec.count) out.push(`COUNT=${spec.count}`);
  return out.join(';');
}

export function parseRrule(rrule: string): ParsedRule {
  const fields = new Map(
    rrule
      .replace(/^RRULE:/, '')
      .split(';')
      .map((kv) => kv.split('=') as [string, string]),
  );
  const freq = fields.get('FREQ') as ParsedRule['freq'];
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    throw new Error(`unsupported FREQ in ${rrule}`);
  }
  const byDay: Weekday[] = [];
  let byDayOrdinal: number | null = null;
  const rawDays = fields.get('BYDAY');
  if (rawDays) {
    for (const tok of rawDays.split(',')) {
      const mm = /^(-?\d)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(tok);
      if (!mm) throw new Error(`unsupported BYDAY in ${rrule}`);
      if (mm[1]) byDayOrdinal = Number(mm[1]);
      byDay.push(mm[2] as Weekday);
    }
  }
  const until = fields.get('UNTIL');
  return {
    freq,
    interval: Number(fields.get('INTERVAL') ?? 1),
    byDay,
    byDayOrdinal,
    byMonthDay: fields.has('BYMONTHDAY') ? Number(fields.get('BYMONTHDAY')) : null,
    untilDate: until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : null,
    count: fields.has('COUNT') ? Number(fields.get('COUNT')) : null,
  };
}

/** The Nth (or last, n = -1) given weekday of a month, as a day of month. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number | null {
  if (n > 0) {
    const first = weekdayIndex(y, m, 1);
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= daysInMonth(y, m) ? day : null;
  }
  const lastDay = daysInMonth(y, m);
  const last = weekdayIndex(y, m, lastDay);
  return lastDay - ((last - weekday + 7) % 7);
}

/**
 * Local wall-clock starts ("YYYY-MM-DDTHH:mm:ss") of a rule, in order, from
 * the first occurrence, within [fromDate, toDate] (inclusive local dates).
 * COUNT counts every generated occurrence, excluded dates included (RFC
 * 5545), so removing one occurrence does not push a new one onto the end.
 */
export function expandLocal(input: {
  firstLocal: string;
  rrule: string;
  exdates?: string[];
  fromDate: string;
  toDate: string;
  cap?: number;
}): string[] {
  const rule = parseRrule(input.rrule);
  const first = parts(input.firstLocal);
  const firstDay = dayNumber(first.y, first.m, first.d);
  const from = parts(input.fromDate);
  const to = parts(input.toDate);
  const fromDay = dayNumber(from.y, from.m, from.d);
  let toDay = dayNumber(to.y, to.m, to.d);
  if (rule.untilDate) {
    const u = parts(rule.untilDate);
    toDay = Math.min(toDay, dayNumber(u.y, u.m, u.d));
  }
  const excluded = new Set((input.exdates ?? []).map((x) => x.slice(0, 10)));
  const cap = input.cap ?? MAX_OCCURRENCES;
  const out: string[] = [];
  let generated = 0;

  const emit = (dayNum: number): boolean => {
    if (dayNum < firstDay) return true;
    if (dayNum > toDay) return false;
    if (rule.count !== null && generated >= rule.count) return false;
    generated++;
    const { y, m, d } = fromDayNumber(dayNum);
    const date = ymd(y, m, d);
    if (dayNum >= fromDay && !excluded.has(date)) out.push(`${date}T${first.time}`);
    return out.length < cap;
  };

  const startWeekday = weekdayIndex(first.y, first.m, first.d);
  // Enough periods to reach any date the window can hold; each branch stops
  // early once it passes the end.
  for (let k = 0; k < 20_000; k++) {
    if (rule.freq === 'DAILY') {
      if (!emit(firstDay + k * rule.interval)) break;
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = firstDay - startWeekday + k * 7 * rule.interval;
      if (weekStart > toDay) break;
      const days = (rule.byDay.length ? rule.byDay : [WEEKDAYS[startWeekday]!])
        .map((w) => WEEKDAYS.indexOf(w))
        .sort((a, b) => a - b);
      let go = true;
      for (const w of days) if (!(go = emit(weekStart + w))) break;
      if (!go) break;
    } else if (rule.freq === 'MONTHLY') {
      const monthIndex = first.m - 1 + k * rule.interval;
      const y = first.y + Math.floor(monthIndex / 12);
      const m = (monthIndex % 12) + 1;
      if (dayNumber(y, m, 1) > toDay) break;
      let day: number | null;
      if (rule.byDayOrdinal !== null && rule.byDay.length) {
        day = nthWeekday(y, m, WEEKDAYS.indexOf(rule.byDay[0]!), rule.byDayOrdinal);
      } else {
        const want = rule.byMonthDay ?? first.d;
        day = want <= daysInMonth(y, m) ? want : null;
      }
      if (day !== null && !emit(dayNumber(y, m, day))) break;
    } else {
      const y = first.y + k * rule.interval;
      if (dayNumber(y, 1, 1) > toDay) break;
      if (first.d <= daysInMonth(y, first.m) && !emit(dayNumber(y, first.m, first.d))) break;
    }
  }
  return out;
}

/** A wall-clock start in `tz` → the stored instant form (with that date's
 *  offset), or floating midnight for an all-day occurrence. */
export function storedStart(local: string, tz: string, allDay: boolean): string {
  if (allDay) return `${local.slice(0, 10)}T00:00:00`;
  return `${local}${offsetForLocalDatetime(tz, local)}`;
}

/** Wall-clock `YYYY-MM-DDTHH:mm:ss` of a stored start, in `tz`. */
export function localWallOf(stored: string, tz: string): string {
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(stored)) return stored.slice(0, 19);
  return svWall(new Date(stored), tz).replace(' ', 'T');
}

/** Add minutes to a wall-clock string, as wall-clock arithmetic. */
export function addWallMinutes(local: string, minutes: number): string {
  const ms = Date.parse(`${local}Z`) + minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 19);
}

const DAY_NAMES: Record<Weekday, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

/** "weekly on Wed", "every 2 weeks on Mon, Thu until 2026-12-18". */
export function describeRrule(rrule: string): string {
  const r = parseRrule(rrule);
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  let s =
    r.interval > 1
      ? `every ${r.interval} ${unit}s`
      : { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[r.freq];
  if (r.freq === 'WEEKLY' && r.byDay.length) s += ` on ${r.byDay.map((d) => DAY_NAMES[d]).join(', ')}`;
  if (r.freq === 'MONTHLY') {
    if (r.byDayOrdinal !== null && r.byDay.length) {
      const nth = r.byDayOrdinal === -1 ? 'last' : ['1st', '2nd', '3rd', '4th'][r.byDayOrdinal - 1];
      s += ` on the ${nth} ${DAY_NAMES[r.byDay[0]!]}`;
    } else if (r.byMonthDay) {
      s += ` on day ${r.byMonthDay}`;
    }
  }
  if (r.untilDate) s += ` until ${r.untilDate}`;
  else if (r.count) s += `, ${r.count} times`;
  return s;
}

/**
 * The rule as Google wants it. A date-only UNTIL is fine for an all-day
 * series; a timed series needs UNTIL as a UTC instant, taken as the end of
 * that local day so the last occurrence is kept.
 */
export function rruleForGoogle(rrule: string, tz: string, allDay: boolean): string {
  const m = /UNTIL=(\d{8})(?!T)/.exec(rrule);
  if (!m || allDay) return `RRULE:${rrule}`;
  const d = m[1]!;
  const localEnd = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T23:59:59`;
  const utc = new Date(`${localEnd}${offsetForLocalDatetime(tz, localEnd)}`)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `RRULE:${rrule.replace(`UNTIL=${d}`, `UNTIL=${utc}`)}`;
}

/** EXDATE lines for Google, one per removed occurrence. */
export function exdatesForGoogle(exdates: string[], tz: string, allDay: boolean): string[] {
  return exdates.map((x) =>
    allDay
      ? `EXDATE;VALUE=DATE:${x.slice(0, 10).replace(/-/g, '')}`
      : `EXDATE;TZID=${tz}:${x.slice(0, 19).replace(/[-:]/g, '')}`,
  );
}
