/**
 * The calendar dates a piece of text names outright (ADR 0244, weekday names
 * ADR 0245).
 *
 * "Are you free at 9a on 10/26" asks about one day. The reply drafter showed
 * the model a fixed ten days of the user's calendar, 26 October was fourteen
 * days out, and the draft offered three other days because the one asked
 * about was not in front of it. This finds such days so the calendar for
 * them can be read; it decides nothing about whether the user is free.
 *
 * Deliberately a parser and not a model call: which days get looked up is
 * then the same every time, and a date it misses costs what it cost before
 * (the day is simply not listed), never a wrong answer.
 *
 * Every relative reference ("this Sunday", "tomorrow") is resolved from
 * `anchorDay`, the day the text was WRITTEN in the reader's zone: the
 * email's sent date, never the server clock and never the day the thread
 * happens to be opened (ADR 0074).
 */

import { placeTimeZone } from '@chord/kernel';

const MONTHS = [
  'jan(?:uary)?',
  'feb(?:ruary)?',
  'mar(?:ch)?',
  'apr(?:il)?',
  'may',
  'june?',
  'july?',
  'aug(?:ust)?',
  'sep(?:t(?:ember)?)?',
  'oct(?:ober)?',
  'nov(?:ember)?',
  'dec(?:ember)?',
];
const MONTH = `(${MONTHS.join('|')})`;
const monthIndex = (word: string): number =>
  MONTHS.findIndex((m) => new RegExp(`^${m}$`, 'i').test(word.replace(/\.$/, '')));

const ymd = (y: number, m: number, d: number): string | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
};

const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface DateHit {
  day: string;
  /** Where in the text the date was written. */
  start: number;
  end: number;
  /**
   * False when the words do not pin one day: "next Friday" is this week's
   * Friday to some writers and the following week's to others. Such a day is
   * still worth LISTING (both candidates are), but nothing may be asserted
   * about a time on it.
   */
  certain: boolean;
}

// Full names in any case; abbreviations only capitalised and only where they
// read as a day ("Fri at 3", "Sat.", "Sun, Oct 18"), so "sat down", "the sun"
// and "wed" do not become dates.
const WEEKDAY_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_ABBR = ['Sun', 'Mon', 'Tue(?:s)?', 'Wed', 'Thu(?:rs?)?', 'Fri', 'Sat'];
const weekdayIndex = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, '');
  return WEEKDAY_FULL.findIndex((full) => full === w || full.startsWith(w.slice(0, 3)));
};
const QUALIFIER = '(?:([Tt]his|[Nn]ext|[Ll]ast|[Pp]ast|[Cc]oming)\\s+)?';
const WEEKDAY_FULL_RE = new RegExp(`\\b${QUALIFIER}(${WEEKDAY_FULL.join('|')})\\b`, 'gi');
const WEEKDAY_ABBR_RE = new RegExp(
  `\\b${QUALIFIER}(${WEEKDAY_ABBR.join('|')})(?=[.,]|\\s+(?:at\\b|\\d|morning|afternoon|evening|night|noon))`,
  'g',
);

/**
 * Every date `text` names, with where it was written.
 *
 * A date with no year is the first one on or after `anchorDay` ("10/26"
 * written on 12 October is this year's; written on 3 November it is next
 * year's), and "the 24th" is the next 24th. Numeric dates are read month
 * first.
 *
 * Weekday and relative words (ADR 0245), all counted from `anchorDay`:
 * - "today" / "tonight" is that day, "tomorrow" the next.
 * - "Sunday", "this Sunday", "coming Sunday" is the next Sunday AFTER that
 *   day. Written ON a Sunday, "this Sunday" is that day, and a bare "Sunday"
 *   is not resolved (today or a week on: the words do not say).
 * - "next Friday" is listed as BOTH the coming Friday and the one after,
 *   uncertain, unless written on a Friday, when it is a week on.
 * - "last Friday" / "past Friday" is in the past: no match.
 * - A weekday written beside an explicit date ("Saturday the 24th",
 *   "Fri November 20") is that date and adds no day of its own.
 */
function findDates(text: string, anchorDay: string): DateHit[] {
  const anchor = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorDay);
  if (!anchor || !text) return [];
  const anchorYear = Number(anchor[1]);
  const hits: DateHit[] = [];

  const yearless = (m: number, d: number): string | null => {
    const thisYear = ymd(anchorYear, m, d);
    if (thisYear && thisYear >= anchorDay) return thisYear;
    return ymd(anchorYear + 1, m, d);
  };
  const withYear = (m: number, d: number, year: string | undefined): string | null => {
    if (!year) return yearless(m, d);
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    return ymd(y, m, d);
  };
  const add = (day: string | null, match: RegExpMatchArray, certain = true): void => {
    if (day) hits.push({ day, start: match.index!, end: match.index! + match[0].length, certain });
  };

  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    add(ymd(Number(m[1]), Number(m[2]), Number(m[3])), m);
  }
  // 10/26, 10/26/26, 10/26/2026. Not part of a longer number or a fraction
  // of something ("1/2 cup" still reads as 2 January: one stray day listed).
  for (const m of text.matchAll(/(?<![\d/.$-])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/g)) {
    add(withYear(Number(m[1]), Number(m[2]), m[3]), m);
  }
  for (const m of text.matchAll(
    new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi'),
  )) {
    add(withYear(monthIndex(m[1]!) + 1, Number(m[2]), m[3]), m);
  }
  for (const m of text.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi'),
  )) {
    add(withYear(monthIndex(m[2]!) + 1, Number(m[1]), m[3]), m);
  }
  // "the 24th", when no month follows it.
  for (const m of text.matchAll(
    new RegExp(`\\bthe\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of\\s+)?${MONTH}\\b)`, 'gi'),
  )) {
    const d = Number(m[1]);
    const month = Number(anchor[2]);
    for (let i = 0; i < 3; i++) {
      const y = anchorYear + Math.floor((month - 1 + i) / 12);
      const candidate = ymd(y, ((month - 1 + i) % 12) + 1, d);
      if (candidate && candidate >= anchorDay) {
        add(candidate, m);
        break;
      }
    }
  }

  const explicit = [...hits];
  /** Is this stretch of text right beside a date that was written out? */
  const besideExplicitDate = (start: number, end: number): boolean =>
    explicit.some((h) => (h.start >= end ? h.start - end : start >= h.end ? start - h.end : 0) <= 6);

  for (const m of text.matchAll(/\b(today|tonight|tomorrow)\b/gi)) {
    add(addDays(anchorDay, m[1]!.toLowerCase() === 'tomorrow' ? 1 : 0), m);
  }
  const anchorWeekday = new Date(Date.parse(`${anchorDay}T00:00:00Z`)).getUTCDay();
  for (const m of [...text.matchAll(WEEKDAY_FULL_RE), ...text.matchAll(WEEKDAY_ABBR_RE)]) {
    const qualifier = (m[1] ?? '').toLowerCase();
    const target = weekdayIndex(m[2] ?? '');
    if (target < 0 || qualifier === 'last' || qualifier === 'past') continue;
    if (besideExplicitDate(m.index!, m.index! + m[0].length)) continue;
    const ahead = (target - anchorWeekday + 7) % 7; // 0 = written on that weekday
    if (qualifier === 'next') {
      if (ahead === 0) add(addDays(anchorDay, 7), m);
      else {
        add(addDays(anchorDay, ahead), m, false);
        add(addDays(anchorDay, ahead + 7), m, false);
      }
    } else if (ahead === 0) {
      if (qualifier === 'this') add(anchorDay, m);
      else if (qualifier === 'coming') add(addDays(anchorDay, 7), m);
    } else {
      add(addDays(anchorDay, ahead), m);
    }
  }
  return hits;
}

/** Every date `text` names, as `YYYY-MM-DD`, earliest first. See `findDates`. */
export function mentionedDays(text: string, anchorDay: string): string[] {
  return [...new Set(findDates(text, anchorDay).map((h) => h.day))].sort();
}

export interface MentionedSlot {
  day: string;
  /** Minutes after midnight on `day`, on the clock of `timeZone` (else the reader's). */
  minutes: number;
  /**
   * The end of a written range ("10:30 AM – 12:00 PM"), same clock and same
   * midnight as `minutes`; past 1440 when the range runs over midnight.
   * Absent for a single time.
   */
  endMinutes?: number;
  /** The zone the writer named beside the time ("PT"), as an IANA name. */
  timeZone?: string;
}

/** How far from a date its time may be written: "9a on 10/26", "Oct 26 at 9:30 am". */
const TIME_REACH = 30;

/**
 * Zone abbreviations a writer puts beside a time, uppercase only (so "et" or
 * "eat" in prose is not one). Where one abbreviation names two zones the
 * commoner reading in mail wins: CST is US Central (not China), IST is India
 * (not Israel or Ireland). AST is left out (Atlantic and Arabia are both
 * common), and so is ART, which reads as a word ("ART 3pm").
 */
const ABBREVIATIONS: Record<string, string> = {
  PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles', PT: 'America/Los_Angeles',
  MST: 'America/Denver', MDT: 'America/Denver', MT: 'America/Denver',
  CST: 'America/Chicago', CDT: 'America/Chicago', CT: 'America/Chicago',
  EST: 'America/New_York', EDT: 'America/New_York', ET: 'America/New_York',
  AKST: 'America/Anchorage', AKDT: 'America/Anchorage', AKT: 'America/Anchorage',
  HST: 'Pacific/Honolulu', HT: 'Pacific/Honolulu',
  NST: 'America/St_Johns', NDT: 'America/St_Johns',
  BRT: 'America/Sao_Paulo',
  UTC: 'UTC', GMT: 'UTC',
  BST: 'Europe/London', WET: 'Europe/Lisbon', WEST: 'Europe/Lisbon',
  CET: 'Europe/Paris', CEST: 'Europe/Paris', EET: 'Europe/Athens', EEST: 'Europe/Athens',
  MSK: 'Europe/Moscow',
  SAST: 'Africa/Johannesburg', WAT: 'Africa/Lagos', EAT: 'Africa/Nairobi',
  GST: 'Asia/Dubai', PKT: 'Asia/Karachi', IST: 'Asia/Kolkata', NPT: 'Asia/Kathmandu',
  ICT: 'Asia/Bangkok', WIB: 'Asia/Jakarta', SGT: 'Asia/Singapore', HKT: 'Asia/Hong_Kong',
  PHT: 'Asia/Manila', JST: 'Asia/Tokyo', KST: 'Asia/Seoul',
  AWST: 'Australia/Perth', ACST: 'Australia/Adelaide', ACDT: 'Australia/Adelaide',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland', NZDT: 'Pacific/Auckland',
};

/**
 * Zone names, capitalised as written. The US ones may stand alone ("2pm
 * Eastern"); the rest need "Time" after them, and longer names come first so
 * "Central European Time" is not read as US Central.
 */
const NAMES_WITH_TIME: [string, string][] = [
  ['Central European', 'Europe/Paris'],
  ['Eastern European', 'Europe/Athens'],
  ['Western European', 'Europe/Lisbon'],
  ['Greenwich Mean', 'UTC'],
  ['Coordinated Universal', 'UTC'],
  ['British', 'Europe/London'],
  ['Moscow', 'Europe/Moscow'],
  ['Gulf', 'Asia/Dubai'],
  ['Pakistan', 'Asia/Karachi'],
  ['Indian?', 'Asia/Kolkata'],
  ['Singapore', 'Asia/Singapore'],
  ['Hong Kong', 'Asia/Hong_Kong'],
  ['China', 'Asia/Shanghai'],
  ['Japan', 'Asia/Tokyo'],
  ['Korea', 'Asia/Seoul'],
  ['Australian Eastern', 'Australia/Sydney'],
  ['Australian Central', 'Australia/Adelaide'],
  ['Australian Western', 'Australia/Perth'],
  ['New Zealand', 'Pacific/Auckland'],
  ['South Africa', 'Africa/Johannesburg'],
];
const US_NAMES: [string, string][] = [
  ['Pacific', 'America/Los_Angeles'],
  ['Mountain', 'America/Denver'],
  ['Central', 'America/Chicago'],
  ['Eastern', 'America/New_York'],
  ['Alaska', 'America/Anchorage'],
  ['Hawaii', 'Pacific/Honolulu'],
];

const SP = '[^\\S\\r\\n]';
const TIME_WORD = `(?:${SP}+(?:Standard${SP}+|Daylight${SP}+|Summer${SP}+)?Time)`;
/**
 * One zone as written: a UTC/GMT offset ("UTC+5:30", "GMT-8", "(UTC-08:00)"),
 * an abbreviation, a zone name, or "<city> time" ("3pm London time").
 * Groups: 1-3 offset, 4 abbreviation, 5 non-US name, 6 US name, 7 city.
 */
const ZONE_CORE =
  `(?:(?:UTC|GMT)${SP}?([+\\-−])${SP}?(\\d{1,2})(?::?([0-5]\\d))?(?![\\d:])` +
  `|(${Object.keys(ABBREVIATIONS).sort((a, b) => b.length - a.length).join('|')})\\b` +
  `|(${NAMES_WITH_TIME.map(([n]) => n).join('|')})${TIME_WORD}\\b` +
  `|(${US_NAMES.map(([n]) => n).join('|')})${TIME_WORD}?\\b` +
  `|((?:[A-Z][a-z]+${SP}){0,2}[A-Z][a-z]+)${SP}+time\\b)`;
const ZONE_AFTER_RE = new RegExp(`^${SP}*\\(?${SP}*${ZONE_CORE}\\)?`);
/** A zone written just before a time: "PT: 10:30", "(ET) 2pm", "Pacific Time - 9am". */
const ZONE_BEFORE_RE = new RegExp(`(?:^|[^A-Za-z])\\(?${ZONE_CORE}\\)?${SP}*[:\\-–—]?${SP}*$`);
/** A zone stated once for every time in the text: "All times are in Pacific Time", "times ET". */
const ZONE_DECLARED_RE = new RegExp(
  `\\b[Tt]imes?(?:${SP}+(?:are|is|listed|shown|below|above|given|quoted|here))*(?:${SP}+(?:in|are))?${SP}+(?:the${SP}+)?\\(?${ZONE_CORE}`,
  'g',
);

/** "+05:30" and the like as a zone Intl can use, or null. */
function offsetZone(sign: string, hours: string, minutes: string | undefined): string | null {
  const h = Number(hours);
  const m = Number(minutes ?? 0);
  if (h > 14) return null;
  const negative = sign !== '+';
  if (m === 0) return h === 0 ? 'UTC' : `Etc/GMT${negative ? '+' : '-'}${h}`; // Etc signs run backwards
  const fixed = `${negative ? '-' : '+'}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: fixed });
    return fixed;
  } catch {
    // Older Intl takes no offset zones: the places that keep these offsets
    // all year stand in for them.
    return HALF_HOUR_ZONES[fixed] ?? null;
  }
}
const HALF_HOUR_ZONES: Record<string, string> = {
  '+03:30': 'Asia/Tehran',
  '+04:30': 'Asia/Kabul',
  '+05:30': 'Asia/Kolkata',
  '+05:45': 'Asia/Kathmandu',
  '+06:30': 'Asia/Yangon',
  '+09:30': 'Australia/Darwin',
  '-09:30': 'Pacific/Marquesas',
};

function zoneOfMatch(m: RegExpExecArray): string | null {
  const [, sign, hours, minutes, abbr, name, usName, city] = m;
  if (sign && hours) return offsetZone(sign, hours, minutes);
  if (abbr) return ABBREVIATIONS[abbr] ?? null;
  const named = (list: [string, string][], word: string): string | null =>
    list.find(([n]) => new RegExp(`^${n}$`).test(word))?.[1] ?? null;
  if (name) return named(NAMES_WITH_TIME, name);
  if (usName) return named(US_NAMES, usName);
  if (city) {
    // "Lunch time" or "Office time" is not a place: only a city the place
    // table knows counts, tried from the longest run of words down.
    const words = city.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const zone = placeTimeZone(words.slice(i).join(' '));
      if (zone) return zone;
    }
  }
  return null;
}

/**
 * A US zone in lower case right after a time ("noon est", "2-4p pst").
 * Directly after a time it can only be a zone; anywhere else "est" is a word.
 */
const LOWER_ZONE_AFTER_RE = /^[^\S\r\n]*\(?(est|edt|cst|cdt|mst|mdt|pst|pdt|akst|akdt|hst)\b\)?/;

function zoneAfter(text: string, at: number): { zone: string; end: number } | null {
  const m = ZONE_AFTER_RE.exec(text.slice(at, at + 48));
  const zone = m && zoneOfMatch(m);
  if (zone) return { zone, end: at + m[0].length };
  const lower = LOWER_ZONE_AFTER_RE.exec(text.slice(at, at + 12));
  const lowerZone = lower ? ABBREVIATIONS[lower[1]!.toUpperCase()] : undefined;
  return lower && lowerZone ? { zone: lowerZone, end: at + lower[0].length } : null;
}

function zoneBefore(text: string, from: number, at: number): string | null {
  const m = ZONE_BEFORE_RE.exec(text.slice(Math.max(from, at - 32), at));
  return m ? zoneOfMatch(m) : null;
}

/** The one zone the text says all its times are in, or null (none stated, or two). */
function declaredZone(text: string): string | null {
  const zones = new Set<string>();
  for (const m of text.matchAll(ZONE_DECLARED_RE)) {
    const zone = zoneOfMatch(m);
    if (zone) zones.add(zone);
  }
  return zones.size === 1 ? [...zones][0]! : null;
}

const minutesOf = (hour12: number, mins: number, meridiem: string): number =>
  ((hour12 % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0)) * 60 + mins;

interface TimeToken {
  minutes: number;
  endMinutes?: number;
  timeZone?: string;
  start: number;
  end: number;
}

/**
 * A date written with a clock time beside it: "9a on 10/26" is 26 October at
 * 9:00, "this Sunday at noon" is that Sunday at 12:00.
 *
 * A time that says which half of the day it is in ("9a", "9 am", "2:30pm",
 * "noon", "14:30") is taken as written. A bare "at 3" is read as a
 * working-hours time only where one reading is the ordinary one: 8 to 11 is
 * the morning, 1 to 6 the afternoon. "at 7" and "at 12" are not guessed.
 * A day the words do not pin down ("next Friday") gets no slot at all.
 * "from 10-1" / "between 2 and 4" with no AM/PM is read the same way.
 *
 * A range ("10:30 AM – 12:00 PM", "11–1 PM") is one slot with an end, and a
 * zone written after a time ("PT", "Eastern Time") goes with it: an offer of
 * "11/10: 10:30 AM – 12:00 PM PT" is that window on the Pacific clock, not
 * 10:30 on the reader's. Times listed together after one date ("8 AM – 9:30
 * AM PT, 1 PM – 2 PM PT") all belong to it.
 */
export function mentionedSlots(text: string, anchorDay: string): MentionedSlot[] {
  const tokens: TimeToken[] = [];
  const overlaps = (start: number, end: number): boolean => tokens.some((t) => t.start < end && t.end > start);
  const push = (t: TimeToken): void => {
    const zone = zoneAfter(text, t.end);
    if (zone) {
      t.timeZone = zone.zone;
      t.end = zone.end;
    }
    tokens.push(t);
  };

  // Ranges first, so their two ends are not also read as two single times.
  // The first end may leave AM/PM off ("11–1 PM"); it takes the second's
  // unless that would put it after the end, when it is the other half.
  for (const m of text.matchAll(
    /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?(?:[^\S\r\n]?([ap])(?:\.?m\.?)?)?[^\S\r\n]*(?:[-–—]|to|until|till)[^\S\r\n]*(1[0-2]|0?[1-9])(?::([0-5]\d))?[^\S\r\n]?([ap])(?:\.?m\.?)?(?![a-z])/gi,
  )) {
    const endMin = minutesOf(Number(m[4]), Number(m[5] ?? 0), m[6]!);
    let startMin = minutesOf(Number(m[1]), Number(m[2] ?? 0), m[3] ?? m[6]!);
    if (!m[3] && startMin > endMin) startMin = minutesOf(Number(m[1]), Number(m[2] ?? 0), m[6]!.toLowerCase() === 'p' ? 'a' : 'p');
    push({
      minutes: startMin,
      endMinutes: endMin > startMin ? endMin : endMin + 24 * 60,
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  // A range with no AM/PM on either end, introduced as one: "free tomorrow
  // from 10-1", "between 2 and 4". Same working-hours reading as a bare
  // "at 3" for the start (8-11 morning, 12 noon, 1-6 afternoon), and the end
  // is the first matching clock time after it, within ten hours. Without the
  // "from"/"between" lead a bare "10-1" is a score or a count, so it stays
  // unread.
  for (const m of text.matchAll(
    /\b(?:from|between)[^\S\r\n]+(1[0-2]|0?[1-9])(?::([0-5]\d))?[^\S\r\n]*(?:[-–—]|to|until|till|and)[^\S\r\n]*(1[0-2]|0?[1-9])(?::([0-5]\d))?(?![\d:]|[^\S\r\n]?[ap]\.?m?\b)/gi,
  )) {
    const h1 = Number(m[1]);
    if (h1 === 7 || h1 > 12) continue;
    const startMin = (h1 >= 8 && h1 <= 11 ? h1 : h1 === 12 ? 12 : h1 + 12) * 60 + Number(m[2] ?? 0);
    const endBase = (Number(m[3]) % 12) * 60 + Number(m[4] ?? 0);
    const endMin = [endBase, endBase + 720].find((e) => e > startMin && e - startMin <= 600);
    if (endMin === undefined) continue;
    const start = m.index! + m[0].search(/\d/);
    const end = m.index! + m[0].length;
    if (overlaps(start, end)) continue;
    push({ minutes: startMin, endMinutes: endMin, start, end });
  }
  // 24-hour ranges ("14:00–15:30", "09:00 - 10:30"). Read as 24-hour only
  // when the clock says so: an hour past 12 on either end, or a start written
  // with a leading zero. "3:00-4:00" stays unread (3 AM or 3 PM?).
  for (const m of text.matchAll(
    /(?<![\d:])(0\d|1\d|2[0-3]|\d)[:h]([0-5]\d)[^\S\r\n]*(?:[-–—]|to|until|till)[^\S\r\n]*(0\d|1\d|2[0-4]|\d)[:h]([0-5]\d)(?![\d:]|[^\S\r\n]?[ap]\.?m?\b)/gi,
  )) {
    const startHour = Number(m[1]);
    const endHour = Number(m[3]);
    if (!(startHour > 12 || endHour > 12 || m[1]!.startsWith('0'))) continue;
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const startMin = startHour * 60 + Number(m[2]);
    const endMin = endHour * 60 + Number(m[4]);
    if (startMin >= 24 * 60 || endMin === startMin) continue;
    push({
      minutes: startMin,
      endMinutes: endMin > startMin ? endMin : endMin + 24 * 60,
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  for (const m of text.matchAll(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s?([ap])(?:\.?m\.?)?(?![a-z])/gi)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    push({ minutes: minutesOf(Number(m[1]), Number(m[2] ?? 0), m[3]!), start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(/\bnoon\b/gi)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    push({ minutes: 12 * 60, start: m.index!, end: m.index! + m[0].length });
  }
  for (const m of text.matchAll(/(?<![\d:])(1[3-9]|2[0-3]):([0-5]\d)(?![\d:])/g)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    push({ minutes: Number(m[1]) * 60 + Number(m[2]), start: m.index!, end: m.index! + m[0].length });
  }
  // "at 3", "at 9:30" with nothing after it saying AM or PM.
  for (const m of text.matchAll(/\bat\s+(1[01]|[1-68-9])(?::([0-5]\d))?(?![\d:/]|\s?[ap]\.?m?\b|\s?(?:o'?clock\s+)?(?:a|p)\b)/gi)) {
    const h = Number(m[1]);
    const hour = h >= 8 ? h : h + 12;
    const start = m.index!;
    const end = start + m[0].length;
    if (overlaps(start, end)) continue;
    push({ minutes: hour * 60 + Number(m[2] ?? 0), start, end });
  }
  tokens.sort((a, b) => a.start - b.start);
  // A zone written before a time ("PT: 10:30", "(ET) 2pm"), looking no
  // further back than the previous time so one time's zone is not read twice.
  tokens.forEach((t, i) => {
    if (t.timeZone) return;
    const zone = zoneBefore(text, i > 0 ? tokens[i - 1]!.end : 0, t.start);
    if (zone) t.timeZone = zone;
  });

  // Times written one after another on a line ("9am or 2pm ET", "8–9:30 AM
  // PT, 1–2 PM PT") are one run: they go with the same date, and a zone
  // written once at the end covers the ones before it.
  const runs: TimeToken[][] = [];
  for (const t of tokens) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && /^[^\S\r\n]*(?:[,;/&]|and|or)?[^\S\r\n]*$/i.test(text.slice(prev.end, t.start))) last!.push(t);
    else runs.push([t]);
  }
  for (const run of runs) {
    const zone = [...run].reverse().find((t) => t.timeZone)?.timeZone;
    if (zone) for (const t of run) t.timeZone ??= zone;
  }
  // "All times are Pacific Time": a time with no zone of its own is on that clock.
  const declared = declaredZone(text);
  if (declared) for (const t of tokens) t.timeZone ??= declared;

  // Each run of times takes the nearest date within reach. A date may hold
  // several runs: in "noon tomorrow? Or between 2-4p" both are tomorrow's.
  const slots = new Map<string, MentionedSlot>();
  const dates = findDates(text, anchorDay).filter((d) => d.certain);
  for (const run of runs) {
    const start = run[0]!.start;
    const end = run[run.length - 1]!.end;
    let best: { date: DateHit; gap: number } | null = null;
    for (const date of dates) {
      const between = end <= date.start ? text.slice(end, date.start) : start >= date.end ? text.slice(date.end, start) : '';
      // A time on the date's own line beats one as close on the next: in a
      // list of "date: times" lines, each line's times are its own.
      const gap = between.length + (/[\r\n]/.test(between) ? 15 : 0);
      if (gap <= TIME_REACH && (!best || gap < best.gap)) best = { date, gap };
    }
    if (!best) continue;
    const date = best.date;
    for (const t of run) {
      const slot: MentionedSlot = { day: date.day, minutes: t.minutes };
      if (t.endMinutes !== undefined) slot.endMinutes = t.endMinutes;
      if (t.timeZone) slot.timeZone = t.timeZone;
      slots.set(`${date.day}@${t.minutes}@${t.timeZone ?? ''}`, slot);
    }
  }
  return [...slots.values()].sort((a, b) => a.day.localeCompare(b.day) || a.minutes - b.minutes);
}

/** One clock time written with no date: every reading of it, and its zone. */
export interface ClockMention {
  /** Minutes after midnight; both halves of the day when AM/PM is not said. */
  readings: number[];
  timeZone?: string;
}

/**
 * The clock times a short reply names, with no date needed: "2:00 works, I
 * am in Seattle so 11:00 PST" names 2:00 (AM or PM) and 11:00 Pacific (AM or
 * PM). Meant to be matched against times already on offer, which decide the
 * day and the half of the day; never read as a slot on its own.
 */
export function mentionedClockTimes(text: string): ClockMention[] {
  const out: ClockMention[] = [];
  for (const m of text.matchAll(/(?<![\d.:/])(1[0-2]|0?[1-9])(?::([0-5]\d))?(?:[^\S\r\n]?([ap])(?:\.?m\.?)?)?(?![\d.:/]|[a-z])/gi)) {
    const hour = Number(m[1]);
    const mins = Number(m[2] ?? 0);
    const readings = m[3] ? [minutesOf(hour, mins, m[3])] : [(hour % 12) * 60 + mins, (hour % 12) * 60 + mins + 720];
    const zone = zoneAfter(text, m.index! + m[0].length);
    out.push({ readings, ...(zone ? { timeZone: zone.zone } : {}) });
  }
  for (const m of text.matchAll(/\bnoon\b/gi)) {
    const zone = zoneAfter(text, m.index! + m[0].length);
    out.push({ readings: [720], ...(zone ? { timeZone: zone.zone } : {}) });
  }
  return out;
}
