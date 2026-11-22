/**
 * The user's free/busy, rendered for a model to pick times from (ADR 0197).
 *
 * One rendering shared by the reply box's "compose a reply" and the chat
 * bot's `get_my_availability`, so "reply with times that work" gets the same
 * answer on both surfaces. What counts as busy is `busyIntervalsInWindow`'s
 * answer — the same one `find_conflicts` gives.
 */
import { describeWorkHours, formatClock, workDayOf, type WorkHours } from '@chord/kernel';
import type { Kysely } from 'kysely';

import { env } from '../config/env.js';
import type { DB } from '../db/schema.js';
import type { MentionedSlot } from '../utils/date-mentions.js';
import { addDays, dayOf, offsetForLocalDatetime, zonedDayEndUtc, zonedDayStartUtc } from '../utils/tz.js';
import { busyIntervalsInWindow, type BusyInterval } from './conflicts.service.js';
import { describeAway, userAwayDays, type AwayDay } from './whereabouts.service.js';
import { getWorkHours } from './work-hours.service.js';

export const DEFAULT_AVAILABILITY_DAYS = 10;

/** How far ahead a day someone asked about is still looked up. */
export const MAX_ASKED_DAY_AHEAD = 180;
/** How many asked-about days outside the window are listed. */
export const MAX_ASKED_DAYS = 5;
/**
 * How many asked-about times get a free/busy verdict. A scheduler offering a
 * fortnight of windows lists nine or ten; with three, the later ones were
 * never checked and so could never be picked.
 */
export const MAX_ASKED_SLOTS = 12;
/** A time someone asks about is taken to mean this long from then. */
const ASKED_SLOT_MINUTES = 60;
/** The shortest free stretch inside an offered window worth reporting. */
const MIN_FREE_MINUTES = 30;

export function zoneOrDefault(tz: string | null | undefined): string {
  for (const z of [tz, env.BRIEFING_DEFAULT_TZ]) {
    if (!z) continue;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: z });
      return z;
    } catch {
      // try the next one
    }
  }
  return 'UTC';
}

function fmtTime(ms: number, tz: string): string {
  return new Date(ms).toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

/** The zone's short name at that instant: "PST", "EDT", or "GMT+5:30" where it has none. */
function fmtZone(ms: number, tz: string): string {
  return (
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value ?? tz
  );
}

/** The parts of [startMs, endMs) no busy block covers, at least MIN_FREE_MINUTES long. */
function freeStretches(startMs: number, endMs: number, busy: BusyInterval[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = startMs;
  for (const iv of [...busy].sort((a, b) => a.startMs - b.startMs)) {
    if (iv.startMs > at) out.push([at, Math.min(iv.startMs, endMs)]);
    at = Math.max(at, iv.endMs);
    if (at >= endMs) break;
  }
  if (at < endMs) out.push([at, endMs]);
  return out.filter(([s, e]) => e - s >= MIN_FREE_MINUTES * 60_000);
}

function fmtDay(day: string, tz: string): string {
  // Noon avoids a DST edge moving the label onto the neighbouring date.
  return new Date(zonedDayStartUtc(day, tz).getTime() + 12 * 3600_000).toLocaleDateString(
    'en-US',
    { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' },
  );
}

/** The local day after `day` in `tz`. */
function nextDay(day: string, tz: string): string {
  return dayOf(new Date(zonedDayStartUtc(day, tz).getTime() + 36 * 3600_000).toISOString(), tz);
}

/** The AWAY note a trip puts on a day's line (ADR 0245), or ''. */
function awayTag(away: AwayDay | undefined): string {
  return away ? ` | AWAY: ${describeAway(away)}` : '';
}

/** The instant of `minutes` after local midnight on `day` in `tz`. */
function localInstant(day: string, minutes: number, tz: string): number {
  const d = minutes >= 24 * 60 ? addDays(day, 1) : day;
  const m = minutes % (24 * 60);
  const wall = `${d}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  return Date.parse(`${wall}${offsetForLocalDatetime(tz, wall)}`);
}

/**
 * ADR 0330 - what a day's line says about work hours, FIRST on the line (a
 * model reads the first words, ADR 0245): "NOT A WORK DAY (Sunday)", or the
 * work window with its free stretches worked out here, never by the model.
 */
function workLead(intervals: BusyInterval[], day: string, tz: string, work: WorkHours, fromMs?: number): string {
  const wd = workDayOf(day, tz, work);
  if (!wd.work) return `NOT A WORK DAY (${wd.reason}); `;
  const winStart = localInstant(day, wd.startMinutes, tz);
  const winEnd = localInstant(day, wd.endMinutes, tz);
  const hours = `work hours ${formatClock(wd.startMinutes)}–${formatClock(wd.endMinutes)}`;
  const from = fromMs !== undefined ? Math.max(winStart, fromMs) : winStart;
  if (from >= winEnd) return `${hours}, over for today; `;
  const free = freeStretches(from, winEnd, intervals.filter((iv) => iv.startMs < winEnd && iv.endMs > from));
  return `${hours}, free in work hours: ${
    free.length ? free.map(([s, e]) => `${fmtTime(s, tz)}–${fmtTime(e, tz)}`).join(', ') : 'none'
  }; `;
}

/** `ms` rounded up to the next :00 or :30. */
function nextHalfHour(ms: number): number {
  const step = 30 * 60_000;
  return Math.ceil(ms / step) * step;
}

/** How many closest free times are offered. */
export const NEXT_FREE_SLOTS = 3;
/** How many days ahead the closest free times are looked for. */
const NEXT_FREE_SEARCH_DAYS = 14;

/**
 * One local day's busy blocks: "Mon, Oct 26: busy 9:00 AM–10:00 AM" / "…:
 * nothing scheduled". With `fromMs` (today), the line covers only what is
 * left of the day and says so, so an hour already gone is never offered.
 */
function dayLine(
  intervals: BusyInterval[],
  day: string,
  tz: string,
  away?: AwayDay,
  fromMs?: number,
  work?: WorkHours,
): string {
  const dayStartMs = zonedDayStartUtc(day, tz).getTime();
  const startMs = fromMs !== undefined && fromMs > dayStartMs ? fromMs : dayStartMs;
  const endMs = zonedDayStartUtc(nextDay(day, tz), tz).getTime();
  const busy = intervals
    .filter((iv) => iv.startMs < endMs && iv.endMs > startMs)
    .map((iv) => {
      const s = Math.max(iv.startMs, startMs);
      const e = Math.min(iv.endMs, endMs);
      const partial = startMs !== dayStartMs;
      if (s === startMs && e === endMs) return partial ? 'all of the rest of today' : 'all day';
      const from = s === startMs ? (partial ? 'now' : 'start of day') : fmtTime(s, tz);
      const to = e === endMs ? 'end of day' : fmtTime(e, tz);
      return `${from}–${to}`;
    });
  const label =
    startMs !== dayStartMs ? `${fmtDay(day, tz)} (rest of today, from ${fmtTime(startMs, tz)})` : fmtDay(day, tz);
  const lead = work ? workLead(intervals, day, tz, work, startMs !== dayStartMs ? startMs : undefined) : '';
  return `${label}: ${lead}${busy.length ? `busy ${busy.join(', ')}` : 'nothing scheduled'}${awayTag(away)}`;
}

/**
 * The user's busy blocks per local day, starting today. A day with nothing
 * says so explicitly, so the model can tell "free" from "not listed".
 */
export function renderAvailability(
  intervals: BusyInterval[],
  opts: { tz: string; nowMs: number; days: number; away?: Map<string, AwayDay>; work?: WorkHours },
): string {
  const { tz, nowMs, days } = opts;
  const lines: string[] = [];
  let day = dayOf(new Date(nowMs).toISOString(), tz);
  for (let i = 0; i < days; i++) {
    lines.push(dayLine(intervals, day, tz, opts.away?.get(day), i === 0 ? nowMs : undefined, opts.work));
    day = nextDay(day, tz);
  }
  return lines.join('\n');
}

export interface UserAvailability {
  tz: string;
  days: number;
  /** False when there is no calendar to read, or too much on it to list —
   *  the caller must not propose specific times then. */
  known: boolean;
  /** Per-day lines, or a one-line reason when `known` is false. */
  text: string;
  /**
   * The same per-day lines for days someone asked about that fall AFTER the
   * window (ADR 0244): "are you free on the 26th" must be answerable when
   * the 26th is two weeks out. Absent when none were asked for or `known`
   * is false.
   */
  askedDaysText?: string;
  /**
   * A verdict per time someone asked about, worked out here and not left to
   * the model: "Mon, Oct 26 at 9:00 AM: FREE (…)" / "…: BUSY (…)". A model
   * handed only the day's line said "not available at 9 AM" on an empty day.
   */
  askedSlotsText?: string;
  /** How many verdicts `askedSlotsText` holds: more than one means the sender offered a choice. */
  askedSlotCount?: number;
  /**
   * Set when a trip puts the user away on a listed day (ADR 0245): the days
   * and cities, in one sentence. Those days carry `| AWAY: …` on their
   * lines. An in-person time must not be offered on one unless the meeting
   * is in that city.
   */
  awayText?: string;
  /** The cities the user is away in on listed days, for matching against
   *  where a meeting is. */
  awayPlaces?: string[];
  /** True when a time that was asked about falls on a day the user is away. */
  askedSlotAway?: boolean;
  /**
   * ADR 0330 - the work hours the lines were read against, in one sentence,
   * saying whether they are the user's own or the default.
   */
  workHoursText?: string;
  /**
   * ADR 0330 - the next free times inside work hours, soonest first, worked
   * out here: one per free stretch, at most `NEXT_FREE_SLOTS`, from the first
   * time asked about (or now). What to offer when the asked time does not work.
   */
  nextFreeText?: string;
}

export async function userAvailability(
  db: Kysely<DB>,
  userId: string,
  opts: {
    days?: number;
    nowMs?: number;
    /** `YYYY-MM-DD` days in the user's zone to cover as well, wherever they fall. */
    alsoDays?: string[];
    /** Specific times asked about, in the user's zone; each gets a verdict. */
    askedSlots?: MentionedSlot[];
    /** ADR 0346 - the thread being answered: its own meeting's hold is not busy. */
    exceptThreadKey?: string;
  } = {},
): Promise<UserAvailability> {
  const days = opts.days ?? DEFAULT_AVAILABILITY_DAYS;
  const nowMs = opts.nowMs ?? Date.now();
  const me = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  const tz = zoneOrDefault(me?.last_tz);
  const { hours: work, isDefault: workIsDefault } = await getWorkHours(db, userId);
  const workHoursText = `Work hours: ${describeWorkHours(work)}${
    workIsDefault ? ' (the default; the user has not said theirs)' : ' (set by the user)'
  }.`;

  const calendars = await db
    .selectFrom('calendar_sources')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (Number(calendars?.n ?? 0) === 0) {
    return { tz, days, known: false, text: 'unknown (no calendar connected)', workHoursText };
  }
  // Calendar days, not 24-hour steps: across a clock change those skip or
  // repeat a day and the busy window stops an hour short of the last one.
  const today = dayOf(new Date(nowMs).toISOString(), tz);
  const windowEnd = addDays(today, days - 1);
  const busy = await busyIntervalsInWindow(db, {
    userId,
    startIso: new Date(nowMs).toISOString(),
    endIso: zonedDayEndUtc(windowEnd, tz).toISOString(),
    exceptThreadKey: opts.exceptThreadKey,
  });
  if (busy.truncated) {
    return { tz, days, known: false, text: 'unknown (too many events to list)', workHoursText };
  }

  // Days asked about beyond the window. Each is read on its own: one query
  // spanning to the furthest would hit the scan cap on a busy calendar and
  // turn a listed answer into "unknown".
  const horizon = addDays(today, MAX_ASKED_DAY_AHEAD);
  const inReach = (d: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= today && d <= horizon;
  // Each asked time as instants, read on the clock it was written on: "10:30
  // AM PT" is 1:30 PM for a reader in New York, and checking 10:30 on the
  // reader's clock answered a question nobody asked. `day` is then the
  // READER's day the time falls on, which is what every line below is keyed by.
  const slots = (opts.askedSlots ?? [])
    .filter((s) => s.minutes >= 0 && s.minutes < 24 * 60)
    .map((s) => {
      const zone = s.timeZone ? zoneOrDefault(s.timeZone) : tz;
      const at = (minutes: number): number => {
        const day = minutes >= 24 * 60 ? addDays(s.day, 1) : s.day;
        const m = minutes % (24 * 60);
        const wall = `${day}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
        return Date.parse(`${wall}${offsetForLocalDatetime(zone, wall)}`);
      };
      const startMs = at(s.minutes);
      const window = s.endMinutes !== undefined && s.endMinutes > s.minutes;
      const endMs = window ? at(s.endMinutes!) : startMs + ASKED_SLOT_MINUTES * 60_000;
      return { day: dayOf(new Date(startMs).toISOString(), tz), startMs, endMs, window, zone };
    })
    .filter((s) => inReach(s.day))
    .sort((a, b) => a.startMs - b.startMs)
    .filter((s, i, all) => i === 0 || s.startMs !== all[i - 1]!.startMs || s.endMs !== all[i - 1]!.endMs)
    .slice(0, MAX_ASKED_SLOTS);
  const asked = [...new Set([...(opts.alsoDays ?? []), ...slots.map((s) => s.day)])]
    .filter((d) => inReach(d) && d > windowEnd)
    .sort()
    .slice(0, MAX_ASKED_DAYS);

  // ADR 0245 — where the user's trips put them, for every day that could be
  // listed. Trip data only; a cancelled or deleted trip is not in it.
  const away = await userAwayDays(db, userId, { fromDay: today, toDay: horizon });

  const dayBusy = new Map<string, BusyInterval[] | null>();
  const busyOn = async (day: string): Promise<BusyInterval[] | null> => {
    if (dayBusy.has(day)) return dayBusy.get(day)!;
    const startMs = zonedDayStartUtc(day, tz).getTime();
    const endMs = zonedDayStartUtc(nextDay(day, tz), tz).getTime();
    const there = await busyIntervalsInWindow(db, {
      userId,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
      exceptThreadKey: opts.exceptThreadKey,
    });
    const found = there.truncated ? null : there.intervals;
    dayBusy.set(day, found);
    return found;
  };

  // Days listed beyond the window: the asked-about ones, plus the day either
  // side of a time that turned out BUSY, so the alternatives offered instead
  // are read off the calendar too and not made up for an unlisted day.
  const extraDays = new Set(asked);
  // "After they are back" needs days to point at: for each asked-about day
  // a trip covers, the first two days at home after that stretch away are
  // listed as well (ADR 0245).
  for (const day of [...asked, ...slots.map((s) => s.day)]) {
    if (!away.has(day)) continue;
    let d = day;
    while (away.has(d) && d <= horizon) d = nextDay(d, tz);
    for (let i = 0; i < 2 && d <= horizon; i++, d = nextDay(d, tz)) {
      if (!away.has(d) && d > windowEnd) extraDays.add(d);
    }
  }
  const slotLines: string[] = [];
  let askedSlotAway = false;
  for (const slot of slots) {
    const { window, zone } = slot;
    const endMs = slot.endMs;
    // As the writer wrote it, when that was another clock, so the reply can
    // name the time both ways.
    const written =
      zone !== tz && fmtZone(slot.startMs, zone) !== fmtZone(slot.startMs, tz)
        ? ` (written as ${fmtTime(slot.startMs, zone)}${window ? `–${fmtTime(endMs, zone)}` : ''} ${fmtZone(slot.startMs, zone)})`
        : '';
    const label = window
      ? `${fmtDay(slot.day, tz)} ${fmtTime(slot.startMs, tz)}–${fmtTime(endMs, tz)}${written}`
      : `${fmtDay(slot.day, tz)} at ${fmtTime(slot.startMs, tz)}${written}`;
    // Earlier today: neither free nor busy, just gone. A window under way
    // counts only from now.
    if (window ? endMs <= nowMs : slot.startMs < nowMs) {
      slotLines.push(`${label}: ALREADY PAST (it is now ${fmtTime(nowMs, tz)}); do not offer it`);
      continue;
    }
    const startMs = Math.max(slot.startMs, nowMs);
    // A window written on another clock can run into the reader's next day.
    const lastDay = dayOf(new Date(endMs - 1).toISOString(), tz);
    const first = await busyOn(slot.day);
    const second = lastDay !== slot.day ? await busyOn(lastDay) : [];
    if (!first || !second) {
      slotLines.push(`${label}: unknown (too many events to list)`);
      continue;
    }
    const clash = [...first, ...second].filter((iv) => iv.startMs < endMs && iv.endMs > startMs);
    const slotAway = away.get(slot.day);
    // Away comes FIRST on the line. Written after "FREE", a live model read
    // the first word and agreed to coffee in New York on a day in Denver.
    const awayLead = slotAway
      ? `AWAY that day (${describeAway(slotAway)}), in person only if the meeting is there; calendar `
      : '';
    if (slotAway) askedSlotAway = true;
    if (clash.length) {
      const dayStart = zonedDayStartUtc(slot.day, tz).getTime();
      const before = dayOf(new Date(dayStart - 12 * 3600_000).toISOString(), tz);
      for (const d of [before, nextDay(slot.day, tz)]) {
        if (inReach(d) && d > windowEnd) extraDays.add(d);
      }
    }
    // ADR 0330 - said after the verdict, not instead of it: a personal
    // brunch on a Sunday is fine, a work call is not; the caller decides.
    const wd = workDayOf(slot.day, tz, work);
    let workNote = '';
    if (!wd.work) workNote = `; OUTSIDE WORK HOURS (not a work day: ${wd.reason})`;
    else {
      const ws = localInstant(slot.day, wd.startMinutes, tz);
      const we = localInstant(slot.day, wd.endMinutes, tz);
      const span = `${formatClock(wd.startMinutes)}–${formatClock(wd.endMinutes)}`;
      if (endMs <= ws || slot.startMs >= we) workNote = `; OUTSIDE WORK HOURS (${span})`;
      else if (slot.startMs < ws || endMs > we) workNote = `; partly outside work hours (${span})`;
    }
    const taken = clash.map((iv) => `${fmtTime(iv.startMs, tz)}–${fmtTime(iv.endMs, tz)}`).join(', ');
    // Inside an offered window, the part that is still open is the answer: a
    // two-hour window with one meeting in it is not "busy".
    const open = window && clash.length ? freeStretches(startMs, endMs, clash) : [];
    slotLines.push(
      !clash.length
        ? `${label}: ${awayLead}FREE (nothing on the calendar from ${fmtTime(startMs, tz)} to ${fmtTime(endMs, tz)})`
        : open.length
          ? `${label}: ${awayLead}PARTLY FREE (free ${open.map(([s, e]) => `${fmtTime(s, tz)}–${fmtTime(e, tz)}`).join(', ')}; ${taken} is taken)`
          : `${label}: ${awayLead}BUSY (${taken} is taken)`,
    );
    slotLines[slotLines.length - 1] += workNote;
  }

  // ADR 0330 - the closest free work-hours times, from the first asked time
  // (else now), each long enough for the meeting asked about (an hour by
  // default). An AWAY day keeps its tag so a call can still go there.
  const firstSlot = slots[0];
  const meetingMs =
    firstSlot && firstSlot.window ? Math.min(firstSlot.endMs - firstSlot.startMs, 120 * 60_000) : ASKED_SLOT_MINUTES * 60_000;
  const searchFrom = Math.max(nowMs, firstSlot?.startMs ?? nowMs);
  const nextFree: string[] = [];
  for (
    let i = 0, d = dayOf(new Date(searchFrom).toISOString(), tz);
    i < NEXT_FREE_SEARCH_DAYS && nextFree.length < NEXT_FREE_SLOTS && d <= horizon;
    i++, d = nextDay(d, tz)
  ) {
    const wd = workDayOf(d, tz, work);
    if (!wd.work) continue;
    const ws = Math.max(localInstant(d, wd.startMinutes, tz), searchFrom);
    const we = localInstant(d, wd.endMinutes, tz);
    if (ws >= we) continue;
    const there = await busyOn(d);
    if (!there) break;
    for (const [s0, e0] of freeStretches(ws, we, there.filter((iv) => iv.startMs < we && iv.endMs > ws))) {
      const at = nextHalfHour(s0);
      if (at + meetingMs > e0) continue;
      nextFree.push(`${fmtDay(d, tz)} at ${fmtTime(at, tz)}${awayTag(away.get(d))}`);
      if (nextFree.length >= NEXT_FREE_SLOTS) break;
    }
  }

  const askedLines: string[] = [];
  for (const day of [...extraDays].sort()) {
    const there = await busyOn(day);
    askedLines.push(
      there
        ? dayLine(there, day, tz, away.get(day), undefined, work)
        : `${fmtDay(day, tz)}: unknown (too many events to list)${awayTag(away.get(day))}`,
    );
  }

  // The stretches away among the days actually listed, in one sentence.
  const listed: string[] = [];
  for (let i = 0, d = today; i < days; i++, d = nextDay(d, tz)) listed.push(d);
  listed.push(...extraDays, ...slots.map((s) => s.day));
  const awayListed = [...new Set(listed)].filter((d) => away.has(d)).sort();
  const runs: Array<{ from: string; to: string; places: Set<string> }> = [];
  for (const d of awayListed) {
    // A run follows the trip, not just the listed days, so "away until" is true.
    if (runs.some((r) => d >= r.from && d <= r.to)) continue;
    let from = d;
    while (away.has(dayOf(new Date(zonedDayStartUtc(from, tz).getTime() - 12 * 3600_000).toISOString(), tz))) {
      from = dayOf(new Date(zonedDayStartUtc(from, tz).getTime() - 12 * 3600_000).toISOString(), tz);
    }
    let to = d;
    while (away.has(nextDay(to, tz))) to = nextDay(to, tz);
    const places = new Set<string>();
    for (let x = from; x <= to; x = nextDay(x, tz)) {
      const a = away.get(x);
      if (a && !a.travel) a.places.forEach((p) => places.add(p));
    }
    if (places.size === 0) {
      for (let x = from; x <= to; x = nextDay(x, tz)) {
        const travel = away.get(x)?.travel;
        if (travel) places.add(travel.to);
      }
    }
    runs.push({ from, to, places });
  }
  const awayText = runs
    .map(
      (r) =>
        `away ${r.from === r.to ? fmtDay(r.from, tz) : `${fmtDay(r.from, tz)} to ${fmtDay(r.to, tz)}`} (${[...r.places].join(', ')}), back from ${fmtDay(nextDay(r.to, tz), tz)}`,
    )
    .join('; ');

  return {
    tz,
    days,
    known: true,
    text: renderAvailability(busy.intervals, { tz, nowMs, days, away, work }),
    workHoursText,
    ...(nextFree.length
      ? {
          nextFreeText: `Closest free times in work hours (${Math.round(meetingMs / 60_000)} min each, soonest first): ${nextFree.join('; ')}`,
        }
      : {}),
    ...(askedLines.length ? { askedDaysText: askedLines.join('\n') } : {}),
    ...(slotLines.length ? { askedSlotsText: slotLines.join('\n'), askedSlotCount: slotLines.length } : {}),
    ...(awayText
      ? {
          awayText: `The user is ${awayText}.`,
          awayPlaces: [...new Set(runs.flatMap((r) => [...r.places]))],
          ...(askedSlotAway ? { askedSlotAway: true } : {}),
        }
      : {}),
  };
}
