/**
 * IANA timezone → current UTC offset as `±HH:MM` (DST-correct for "now").
 * The anchor every datetime-normalization path shares: a bare LLM datetime
 * gets the acting user's offset appended, never a silent UTC assumption.
 */
/**
 * `date.toLocaleString('sv-SE', { timeZone })` without building a formatter per
 * call. Constructing an Intl.DateTimeFormat is the expensive part (tens of
 * microseconds against ~2 to format), and these helpers run several times per
 * bot turn, per mail extraction and per calendar pass: about 5% of server CPU
 * under load. One formatter per zone is kept (the set of zones is finite).
 *
 * Returns exactly what toLocaleString does, "YYYY-MM-DD HH:MM:SS" wall-clock in
 * the zone; throws RangeError for an unknown zone, as it does; and returns
 * "Invalid Date" for an invalid date rather than throwing, as it does.
 */
const svFormatters = new Map<string, Intl.DateTimeFormat>();
export function svWall(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  let f = svFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    svFormatters.set(timeZone, f);
  }
  return f.format(date);
}

/** IANA timezone → current UTC offset in minutes (e.g. -240 for EDT), or
 *  null when the zone is unknown. */
export function tzToOffsetMinutes(iana: string): number | null {
  try {
    const now = new Date();
    const localStr = svWall(now, iana);
    const utcStr = svWall(now, 'UTC');
    return Math.round(
      (Date.parse(localStr.replace(' ', 'T') + 'Z') - Date.parse(utcStr.replace(' ', 'T') + 'Z')) /
        60000,
    );
  } catch {
    return null;
  }
}

export function tzToOffset(iana: string): string {
  try {
    const now = new Date();
    const localStr = svWall(now, iana);
    const utcStr = svWall(now, 'UTC');
    const offsetMin = Math.round(
      (Date.parse(localStr.replace(' ', 'T') + 'Z') - Date.parse(utcStr.replace(' ', 'T') + 'Z')) /
        60000,
    );
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return '+00:00';
  }
}

/**
 * IANA timezone → UTC offset AT a specific local wall-clock date/time
 * (DST-correct for THAT date, not "now"). `localIso` is a bare
 * "YYYY-MM-DDTHH:mm:ss[.sss]" string with no zone.
 *
 * `tzToOffset` above answers "what's my clock reading right now" — correct
 * for that question, wrong for "what offset applies to this OTHER date the
 * user just named." A bot turn on, say, an October day (still daylight
 * saving in most US zones) creating "1pm on Dec 5" (already standard time)
 * used to get October's offset stamped onto a December instant — a
 * silent, exactly-one-hour error that only shows up once DST has flipped
 * between "now" and the target date.
 *
 * The offset is read at the instant the wall time names (`zonedWallToUtcMs`,
 * two passes). A single pass read it at the wall time taken as UTC, hours
 * away, so "8am Nov 1" in Los Angeles got summer time on the morning the
 * clocks fell back.
 */
export function offsetForLocalDatetime(iana: string, localIso: string): string {
  try {
    const naive = Date.parse(`${localIso}Z`);
    if (Number.isNaN(naive)) return tzToOffset(iana);
    const offsetMin = Math.round((naive - zonedWallToUtcMs(localIso, iana)) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch {
    return tzToOffset(iana);
  }
}

const fmtOffset = (offsetMin: number): string => {
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

/** The zone's UTC offset in minutes at the instant `at`, or null for an unknown zone. */
function offsetMinutesAt(iana: string, at: Date): number | null {
  try {
    const wall = svWall(at, iana);
    const utc = svWall(at, 'UTC');
    return Math.round(
      (Date.parse(`${wall.replace(' ', 'T')}Z`) - Date.parse(`${utc.replace(' ', 'T')}Z`)) / 60000,
    );
  } catch {
    return null;
  }
}

/**
 * Fix a datetime stamped with the user's offset as of NOW when its own date
 * falls on the other side of a daylight-saving change (ADR 0244).
 *
 * A model is told the user's zone and its current offset, and stamps that
 * offset on every time it writes: on 12 October a New York "8:15 AM on
 * November 20" came back as `08:15:00-04:00`, an hour off, because New York
 * is on -05:00 by then. `normalizeDatetimes` only fixes a value with NO
 * offset; this is the value that carries the wrong one.
 *
 * The wall clock is kept and only the offset changes, and only when the
 * offset carried is exactly today's for `tz` while the zone's offset on that
 * date differs. Any other offset was chosen on purpose and is left alone. A
 * caller that knows the text named a zone outright ("3pm ET") must not call
 * this: a Chicago reader's today-offset in summer equals New York's in
 * winter, and that time would be moved wrongly (`namesATimeZone`).
 */
export function reanchorNowStampedOffset(
  iso: string,
  tz: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!tz) return iso;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(?:\.\d+)?([+-]\d{2}):?(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const nowOffset = offsetMinutesAt(tz, now);
  if (nowOffset === null) return iso;
  const carried = offsetMinutesOf(`${m[3]}:${m[4]}`);
  if (carried !== nowOffset) return iso;
  const wall = `${m[1]}${m[2] ?? ':00'}`;
  const onDate = offsetForLocalDatetime(tz, wall);
  return offsetMinutesOf(onDate) === carried ? iso : `${wall}${onDate}`;
}

/** `reanchorNowStampedOffset` over every string in a tool-args object. */
export function reanchorNowStampedOffsets(
  args: unknown,
  tz: string | null | undefined,
  now: Date = new Date(),
): unknown {
  if (!tz) return args;
  if (typeof args === 'string') return reanchorNowStampedOffset(args, tz, now);
  if (Array.isArray(args)) return args.map((v) => reanchorNowStampedOffsets(v, tz, now));
  if (args !== null && typeof args === 'object') {
    return Object.fromEntries(
      Object.entries(args as Record<string, unknown>).map(([k, v]) => [
        k,
        reanchorNowStampedOffsets(v, tz, now),
      ]),
    );
  }
  return args;
}

/**
 * Does this text state a time zone outright ("3pm ET", "10:00 PST",
 * "Eastern time", "UTC+2")? Then an offset on a time read from it may be that
 * zone's, not a stamp of the reader's own, and must be left as written.
 */
export function namesATimeZone(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /\b(?:[ECMP][SD]?T|AK[SD]?T|HST|A[SD]T|GMT|UTC|BST|IST|CES?T|EES?T|WES?T|AE[SD]T|JST|SGT)\b/.test(text) ||
    /\b(?:eastern|central|mountain|pacific|atlantic|greenwich)\s+(?:standard\s+|daylight\s+)?time\b/i.test(text) ||
    /\btime\s?zone\b/i.test(text)
  );
}

/**
 * The zone's UTC offset today and, when it changes within the next year,
 * the date it changes on and what it becomes: for a prompt, so a model
 * writing a date months out has that date's offset in front of it instead
 * of only today's.
 *
 *   "UTC-04:00 until 2026-11-01, UTC-05:00 from that date on"
 *   "UTC+05:30 all year"
 */
export function offsetScheduleNote(iana: string, now: Date = new Date()): string {
  const today = offsetMinutesAt(iana, now);
  if (today === null) return 'UTC+00:00 all year';
  let day: string;
  try {
    day = svWall(now, iana).slice(0, 10);
  } catch {
    return `UTC${fmtOffset(today)} all year`;
  }
  const startMs = Date.parse(`${day}T00:00:00Z`);
  for (let i = 1; i <= 370; i++) {
    const ymd = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
    const off = offsetForLocalDatetime(iana, `${ymd}T12:00:00`);
    if (offsetMinutesOf(off) !== today) {
      return `UTC${fmtOffset(today)} until ${ymd}, UTC${off} from that date on`;
    }
  }
  return `UTC${fmtOffset(today)} all year`;
}

/** True when the ISO string names an absolute instant (Z or numeric offset)
 *  rather than a floating wall-clock time. */
export const hasZone = (iso: string): boolean => /(Z|[+-]\d{2}:?\d{2})$/.test(iso);

/** The calendar date in the user's timezone. Zone-carrying instants convert
 *  into `tz`; floating strings are already wall-clock and slice as-is. */
export function dayOf(iso: string, tz?: string | null): string {
  if (tz && hasZone(iso)) {
    try {
      return svWall(new Date(iso), tz).slice(0, 10);
    } catch {
      // unknown zone -> wall-clock fallback below
    }
  }
  return iso.slice(0, 10);
}

/**
 * ADR 0158 §4 — a date whose day (in `tz`) is before `today` is history. The
 * one rule every email-derived travel/event write uses to drop what already
 * happened (`stageFlight`/`stageHotel`, and the attachment filer for files
 * copied out of email). `today` is the reader's local `YYYY-MM-DD`.
 */
export function isBeforeDay(iso: string, today: string, tz?: string | null): boolean {
  return dayOf(iso, tz) < today;
}

/**
 * The instant (ms) at which the wall clock in `tz` reads `localIso`
 * ("YYYY-MM-DDTHH:mm[:ss]"). Two passes: the offset read at the wall time
 * taken as UTC is measured up to 14 hours from the real instant, so across a
 * clock change it is the OLD offset (a 7:00 briefing on the morning US clocks
 * fell back was sent at 6:00); reading it again at the instant the first pass
 * gave lands on the right side. A wall time the clock skips (a spring-forward
 * gap, 00:00 where the change is at midnight) becomes the first one that
 * exists after it. Throws on an unknown zone.
 */
export function zonedWallToUtcMs(localIso: string, tz: string): number {
  const naive = Date.parse(`${localIso}Z`);
  if (Number.isNaN(naive)) return NaN;
  const wallAt = (ms: number) => Date.parse(`${svWall(new Date(ms), tz).replace(' ', 'T')}Z`);
  const driftAt = (ms: number) => wallAt(ms) - ms;
  const at = naive - driftAt(naive - driftAt(naive));
  const shown = wallAt(at);
  return shown < naive ? at + (naive - shown) : at;
}

/** UTC instant at which `day` (YYYY-MM-DD) starts in `tz`. */
export function zonedDayStartUtc(day: string, tz: string | null): Date {
  const naive = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(naive)) return new Date(NaN);
  if (!tz) return new Date(naive);
  try {
    return new Date(zonedWallToUtcMs(`${day}T00:00:00`, tz));
  } catch {
    return new Date(naive);
  }
}

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000,
  );
}

/** `ymd` moved by `n` calendar days. Steps the DATE, never 24 hours of time:
 *  a local day is 23 or 25 hours long when the clocks change, so "now + 24h"
 *  skips or repeats a day across one. */
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The instant the local day `ymd` ends in `tz` (the next day's midnight). */
export function zonedDayEndUtc(ymd: string, tz: string | null): Date {
  return zonedDayStartUtc(addDays(ymd, 1), tz);
}

/**
 * The first and last local days an event covers. An end exactly at local
 * midnight is exclusive - an all-day event ending `2026-10-23T00:00:00` was
 * over on the 22nd.
 */
export function eventLocalDays(
  startsAt: string,
  endsAt: string | null | undefined,
  tz: string | null | undefined,
): { first: string; last: string } {
  const first = dayOf(startsAt, tz);
  if (!endsAt) return { first, last: first };
  const endDay = dayOf(endsAt, tz);
  if (endDay <= first) return { first, last: first };
  let endWall = endsAt.slice(11, 16);
  if (tz && hasZone(endsAt)) {
    try {
      endWall = svWall(new Date(endsAt), tz).slice(11, 16);
    } catch {
      // unknown zone -> the value's own wall clock
    }
  }
  return { first, last: endWall === '' || endWall === '00:00' ? addDays(endDay, -1) : endDay };
}

/** A date, or floating local midnight: how an all-day event is stored (ADR 0040). */
export function isAllDayValue(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T00:00(:00(\.0+)?)?)?$/.test(iso.trim());
}

/**
 * An event time as an instant, reading a floating value as wall time in the
 * user's zone (Date.parse would read it in the server's).
 */
export function instantInZoneMs(iso: string, tz: string | null | undefined): number {
  if (hasZone(iso)) return Date.parse(iso);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return zonedDayStartUtc(iso, tz ?? null).getTime();
  const local = iso.length === 16 ? `${iso}:00` : iso;
  if (!tz) return Date.parse(`${local}Z`);
  return Date.parse(`${local}${offsetForLocalDatetime(tz, local)}`);
}

/** "9:05 AM" in the user's zone. */
export function fmtTimeOnly(iso: string, tz?: string | null): string {
  if (tz && hasZone(iso)) {
    try {
      return new Date(iso).toLocaleString('en-US', {
        timeZone: tz,
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      // unknown zone -> wall-clock fallback below
    }
  }
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso;
  let h = Number(m[1]);
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${m[2]} ${ampm}`;
}

/**
 * A datetime for LLM context that KEEPS the zone it was stored with. The
 * model must report a booked time (a flight, a calendar event) exactly as
 * booked — not re-interpreted in the server's zone, and not stripped of its
 * offset and then guessed at.
 *
 *   `2026-09-08T06:15:00-04:00`  → `2026-09-08 06:15 (UTC-04:00)`
 *   `2026-09-08T06:15:00Z`       → `2026-09-08 06:15 (UTC)`
 *   `2026-09-08T06:15:00`        → `2026-09-08 06:15`   (floating wall-clock)
 *   `2026-09-08`                 → `2026-09-08`
 *
 * Nothing here converts between zones — that is the point. `new Date(iso)`
 * followed by `toLocaleString()` (no `timeZone`) renders in the process zone,
 * which on a UTC VM silently shifts every offset-carrying time; `.slice(0,16)`
 * drops the offset entirely and leaves the model to invent one.
 */
export function fmtWhenWithZone(iso: string): string {
  const m =
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      iso.trim(),
    );
  if (!m) return iso;
  const [, date, hh, mm, zone] = m;
  if (hh === undefined) return date;
  const time = `${hh}:${mm}`;
  if (!zone) return `${date} ${time}`;
  if (zone === 'Z') return `${date} ${time} (UTC)`;
  const norm = zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${date} ${time} (UTC${norm})`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Weekday name of a calendar date (`YYYY-MM-DD`); '' when unparseable. */
export function weekdayOf(ymd: string): string {
  const ms = Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? '' : WEEKDAYS[new Date(ms).getUTCDay()];
}

/**
 * The next `days` dates from `todayYmd`, each with its weekday, for the
 * prompt. A model handed only "2026-09-27" works out "Monday" itself and gets
 * it wrong; handed the table it only has to look it up.
 */
export function upcomingDatesTable(todayYmd: string, days = 14): string {
  const start = Date.parse(`${todayYmd}T00:00:00Z`);
  if (Number.isNaN(start)) return '';
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    const ymd = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow)' : '';
    out.push(`${weekdayOf(ymd).slice(0, 3)} ${ymd}${tag}`);
  }
  return out.join(', ');
}

/**
 * A stored event time as the user's own wall clock, with the weekday:
 * `Monday 2026-09-28 09:15`. Zoned values are converted to `tz`; floating and
 * date-only values are already wall-clock and are only labelled. Handing the
 * model the raw `…Z` string is how "9:15 AM UTC" reached a user.
 */
export function localWhen(iso: string, tz: string | null | undefined): string {
  return renderWhen(iso, tz, false);
}

/**
 * A travel time as the traveller reads it on the ticket: the wall clock in the
 * value's OWN offset (a Tokyo departure stays Tokyo time), with the weekday.
 * Only a bare `Z` value, which has no place attached, is shown in `tz`.
 */
export function ownWhen(iso: string, tz: string | null | undefined): string {
  return renderWhen(iso, tz, true);
}

/** `localWhen` for a nullable column. */
export function localWhenOrNull(iso: string | null | undefined, tz: string | null | undefined): string | null {
  return iso ? localWhen(iso, tz) : null;
}

function renderWhen(iso: string, tz: string | null | undefined, keepOffset: boolean): string {
  const s = iso.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${weekdayOf(s)} ${s} (all day)`;
  let wall: string | null = null;
  const ownOffset = keepOffset && hasZone(s) && !/Z$/i.test(s);
  if (hasZone(s) && !ownOffset) {
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return iso;
    try {
      wall = svWall(new Date(ms), tz && tz.trim() ? tz : 'UTC');
    } catch {
      wall = svWall(new Date(ms), 'UTC');
    }
  } else {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(s);
    if (!m) return iso;
    wall = `${m[1]} ${m[2]}`;
  }
  const day = wall.slice(0, 10);
  const out = `${weekdayOf(day)} ${day} ${wall.slice(11, 16)}`;
  if (!ownOffset) return out;
  const off = /([+-]\d{2}):?(\d{2})$/.exec(s);
  return off ? `${out} local (UTC${off[1]}:${off[2]})` : out;
}

/** Minutes east of UTC for a `+HH:MM` / `-HHMM` offset string. */
export function offsetMinutesOf(offset: string): number {
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim());
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

/** The YYYY-MM-DD the instant falls on for a user at `offsetMinutes`. Floating
 *  strings are already wall-clock in that zone and slice as-is. */
export function localDay(iso: string, offsetMinutes: number): string | null {
  if (!hasZone(iso)) return /^(\d{4}-\d{2}-\d{2})/.exec(iso)?.[1] ?? null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/**
 * True when a proposed event starts on a date the user has already lived
 * through. Nothing in the product needs Chord to file history, so a past start
 * is nearly always a typo — a wrong year, or a weekday that already went by
 * ("Friday" said on a Saturday) — or, in mail, a confirmation for something
 * that is simply over.
 *
 * The boundary is the START OF THE USER'S LOCAL DAY, not `now`. An all-day
 * event for today arrives as floating midnight (ADR 0040) and would trip a
 * strict `< now` test every time; "lunch at noon" typed at 2pm is someone
 * recording a live day, not making a mistake. Only a date that has actually
 * turned over is treated as suspect.
 *
 * Lives here rather than beside either caller: ADR 0100 asks it of a bot turn
 * and ADR 0137 of an email proposal, and two copies of one predicate is how
 * ADR 0085's promise stopped being true once already.
 */
/**
 * A start that has already come, to the minute: for a meeting that sends
 * invitations, where "earlier today" is as gone as yesterday (prod
 * 2026-11-17: an invite for 2pm sent at 4:33pm). An event nobody is invited
 * to keeps the day rule above ("lunch at noon" typed at 2pm is a record).
 */
export function hasStarted(startsAt: string, now: Date = new Date()): boolean {
  const ms = Date.parse(startsAt);
  return Number.isFinite(ms) && /(?:Z|[+-]\d{2}:?\d{2})$/.test(startsAt) && ms <= now.getTime();
}

export function isPastEventStart(
  startsAt: string,
  tzOffset: string | undefined,
  now: Date = new Date(),
): boolean {
  const offsetMinutes = offsetMinutesOf(tzOffset ?? '+00:00');
  const day = localDay(startsAt, offsetMinutes);
  // Unparseable: the zod schema is the guard for shape, not this.
  if (!day) return false;
  return day < localDay(now.toISOString(), offsetMinutes)!;
}
