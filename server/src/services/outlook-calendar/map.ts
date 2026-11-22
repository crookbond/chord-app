/**
 * ADR 0228 — Microsoft Graph events ⇄ the sync engine's event shape. Pure.
 *
 * The engine was written against Google's event resource, so that is the
 * shape it reconciles. This file turns a Graph event into one, and turns the
 * body the engine would send Google into the one Graph accepts. Where the two
 * providers differ, the difference is settled here:
 *
 *   - Graph has no `sequence`. It is left undefined, and the engine then
 *     compares by modification time alone.
 *   - Graph returns times in UTC (we ask for that). They are restated in the
 *     reader's own zone, the form a Google pull stores.
 *   - Graph has no RRULE. A rule is rebuilt as its `recurrence` object, and
 *     removed occurrences (EXDATE) are returned for the transport to delete
 *     one by one, since Graph has no exception list on the master.
 *   - A delta lists an ordinary occurrence of a series with its id and times
 *     only; the rest is read off the series master.
 */
import { offsetForLocalDatetime, svWall } from '../../utils/tz.js';
import { visibleHtmlText } from '../../utils/visible-text.js';
import { parseRrule, type Weekday } from '../events/recurrence.js';
import { CHORD_UID_PROP, type GoogleDateTime, type GoogleEventResource } from '../google/two-way-sync.js';

export interface GraphDateTime {
  /** Wall time with no offset, e.g. `2026-10-08T15:00:00.0000000`. */
  dateTime: string;
  timeZone?: string;
}

export interface GraphEvent {
  id: string;
  '@odata.etag'?: string;
  '@removed'?: { reason?: string };
  iCalUId?: string;
  subject?: string;
  body?: { contentType?: string; content?: string };
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  showAs?: string;
  type?: 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster';
  seriesMasterId?: string;
  /** The start this occurrence had before anyone moved it (UTC instant). */
  originalStart?: string;
  originalStartTimeZone?: string;
  lastModifiedDateTime?: string;
  responseStatus?: { response?: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string } }>;
  transactionId?: string;
  recurrence?: unknown;
  /** ADR 0323 — set to ask Graph for a Teams meeting; Graph then fills the
   *  read-only `onlineMeeting`, and will not let either change again. */
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  /** Read-only. `onlineMeetingUrl` is deprecated; the join link is here. */
  onlineMeeting?: { joinUrl?: string } | null;
}

export interface GraphCalendar {
  id: string;
  name?: string;
  canEdit?: boolean;
  isDefaultCalendar?: boolean;
  hexColor?: string;
  owner?: { address?: string };
  /** ADR 0323 — which online-meeting providers this calendar can host.
   *  Microsoft's documented way to tell whether a Teams meeting is possible
   *  at all: a personal account's calendar does not list `teamsForBusiness`. */
  allowedOnlineMeetingProviders?: string[];
}

/** The Graph value for a Teams meeting, as `onlineMeetingProvider` and as an
 *  entry of a calendar's `allowedOnlineMeetingProviders`. */
export const TEAMS_PROVIDER = 'teamsForBusiness';

// ── Graph → engine ──────────────────────────────────────────────────────────

/** `YYYY-MM-DDTHH:mm:ss±hh:mm` for an instant, read on `tz`'s wall clock. */
export function zonedIso(instant: Date, tz: string): string {
  const wall = svWall(instant, tz).replace(' ', 'T');
  return `${wall}${offsetForLocalDatetime(tz, wall)}`;
}

function isIanaZone(tz: string | null | undefined): tz is string {
  if (!tz || !tz.includes('/')) return false;
  try {
    svWall(new Date(0), tz);
    return true;
  } catch {
    return false;
  }
}

function graphInstant(dt: GraphDateTime): Date | null {
  const wall = dt.dateTime.slice(0, 19);
  const zone = dt.timeZone ?? 'UTC';
  const iso = zone === 'UTC' || !isIanaZone(zone) ? `${wall}Z` : `${wall}${offsetForLocalDatetime(zone, wall)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function graphDateToGoogle(
  dt: GraphDateTime | undefined,
  allDay: boolean,
  displayTz: string | null,
): GoogleDateTime | undefined {
  if (!dt?.dateTime) return undefined;
  if (allDay) return { date: dt.dateTime.slice(0, 10) };
  const instant = graphInstant(dt);
  if (!instant) return undefined;
  if (isIanaZone(displayTz)) return { dateTime: zonedIso(instant, displayTz), timeZone: displayTz };
  return { dateTime: instant.toISOString().replace('.000Z', 'Z') };
}

/** Graph's own answer for the mailbox owner → Google's `responseStatus`. */
function selfResponse(response: string | undefined): string | null {
  switch (response) {
    case 'accepted':
      return 'accepted';
    case 'tentativelyAccepted':
      return 'tentative';
    case 'declined':
      return 'declined';
    case 'notResponded':
      return 'needsAction';
    default:
      return null; // 'none' / 'organizer': there is nothing to answer
  }
}

/**
 * Graph's `bodyPreview` stops at "up to 255" characters, but counts whitespace
 * the preview collapses: the prod preview that started this was cut at 222.
 * Any preview this long may be cut; a shorter one is the whole body.
 */
const PREVIEW_MAYBE_CUT = 200;

function fullBodyText(ev: GraphEvent): string | undefined {
  const content = ev.body?.content;
  if (!content?.trim()) return undefined;
  // The Prefer header asks for text; an HTML body that comes anyway is read as
  // what a person sees, never kept as markup.
  return ev.body?.contentType?.toLowerCase() === 'html' ? visibleHtmlText(content) : content;
}

/**
 * The event arrived with only its preview and the preview fills the cap, so
 * the description would be cut off mid-text: the transport fetches the body.
 */
export function needsFullBody(ev: GraphEvent): boolean {
  if (ev['@removed'] || fullBodyText(ev) !== undefined) return false;
  return (ev.bodyPreview ?? '').trim().length >= PREVIEW_MAYBE_CUT;
}

function plainBody(ev: GraphEvent): string | undefined {
  const raw = fullBodyText(ev) ?? ev.bodyPreview;
  const text = (raw ?? '').replace(/\r\n/g, '\n').trim();
  return text || undefined;
}

/**
 * One Graph event as the engine's resource. `master` supplies the content of
 * an ordinary occurrence, which a delta lists with its id and times only.
 */
export function graphEventToResource(
  ev: GraphEvent,
  displayTz: string | null,
  master?: GraphEvent,
): GoogleEventResource {
  if (ev['@removed']) return { id: ev.id, status: 'cancelled' };

  const src: GraphEvent = master ? { ...master, ...definedProps(ev) } : ev;
  const allDay = src.isAllDay === true;
  const isInstance = ev.type === 'occurrence' || ev.type === 'exception' || !!ev.seriesMasterId;
  const start = graphDateToGoogle(ev.start ?? src.start, allDay, displayTz);
  const end = graphDateToGoogle(ev.end ?? src.end, allDay, displayTz);

  let originalStartTime: GoogleDateTime | undefined;
  if (isInstance) {
    originalStartTime = ev.originalStart
      ? allDay
        ? { date: ev.originalStart.slice(0, 10) }
        : graphDateToGoogle({ dateTime: ev.originalStart.slice(0, 19), timeZone: 'UTC' }, false, displayTz)
      : start;
  }

  const response = selfResponse(src.responseStatus?.response);
  const chordUid = src.transactionId?.startsWith('ce_') ? src.transactionId : null;

  return {
    id: ev.id,
    iCalUID: src.iCalUId,
    status: src.isCancelled ? 'cancelled' : 'confirmed',
    summary: src.subject,
    description: plainBody(src),
    location: src.location?.displayName?.trim() || undefined,
    start,
    end,
    updated: ev.lastModifiedDateTime ?? src.lastModifiedDateTime,
    etag: ev['@odata.etag'] ?? undefined,
    transparency: src.showAs === 'free' || src.showAs === 'workingElsewhere' ? 'transparent' : 'opaque',
    ...(src.onlineMeeting?.joinUrl ? { videoCallLink: src.onlineMeeting.joinUrl } : {}),
    ...(isInstance ? { recurringEventId: ev.seriesMasterId ?? master?.id, originalStartTime } : {}),
    ...(chordUid ? { extendedProperties: { private: { [CHORD_UID_PROP]: chordUid } } } : {}),
    ...(guestsOrSelf(src, response) ?? {}),
    ...(typeof src.isOrganizer === 'boolean' || src.organizer?.emailAddress?.address
      ? {
          organizer: {
            ...(typeof src.isOrganizer === 'boolean' ? { self: src.isOrganizer } : {}),
            ...(src.organizer?.emailAddress?.address ? { email: src.organizer.emailAddress.address } : {}),
          },
        }
      : {}),
  };
}

/** The event's guests (ADR 0295) plus the user's own answer, which Graph keeps
 *  apart from the guest list and the engine reads as the `self` entry. */
function guestsOrSelf(
  ev: GraphEvent,
  response: string | null,
): { attendees: NonNullable<GoogleEventResource['attendees']> } | null {
  const guests = (ev.attendees ?? [])
    .filter((a) => !!a.emailAddress?.address)
    .map((a) => ({
      email: a.emailAddress!.address!,
      ...(a.emailAddress?.name ? { displayName: a.emailAddress.name } : {}),
      responseStatus: selfResponse(a.status?.response) ?? 'needsAction',
    }));
  const self = response ? [{ self: true, responseStatus: response }] : [];
  return guests.length || self.length ? { attendees: [...guests, ...self] } : null;
}

function definedProps<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

/**
 * A page set from `calendarView/delta` as engine resources: series masters
 * are dropped (the engine works on occurrences, as it does with Google's
 * `singleEvents`), and each plain occurrence takes its content from its master.
 * `missingMasters` names the masters an occurrence needs that the pages did
 * not carry — the caller fetches them and calls again.
 */
export function graphDeltaToResources(
  events: GraphEvent[],
  displayTz: string | null,
  extraMasters: Map<string, GraphEvent> = new Map(),
): { items: GoogleEventResource[]; missingMasters: string[] } {
  const masters = new Map(extraMasters);
  for (const e of events) if (e.type === 'seriesMaster' && !e['@removed']) masters.set(e.id, e);

  const items: GoogleEventResource[] = [];
  const missing = new Set<string>();
  for (const e of events) {
    if (e['@removed']) {
      items.push({ id: e.id, status: 'cancelled' });
      continue;
    }
    if (e.type === 'seriesMaster') continue;
    // Only an ordinary occurrence arrives stripped; an exception or a one-off
    // carries its own subject.
    const needsMaster = !!e.seriesMasterId && e.subject === undefined;
    const master = e.seriesMasterId ? masters.get(e.seriesMasterId) : undefined;
    if (needsMaster && !master) {
      missing.add(e.seriesMasterId!);
      continue;
    }
    items.push(graphEventToResource(e, displayTz, needsMaster ? master : undefined));
  }
  return { items, missingMasters: [...missing] };
}

// ── engine → Graph ──────────────────────────────────────────────────────────

const GRAPH_DAY: Record<Weekday, string> = {
  MO: 'monday',
  TU: 'tuesday',
  WE: 'wednesday',
  TH: 'thursday',
  FR: 'friday',
  SA: 'saturday',
  SU: 'sunday',
};
const JS_DAY: Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const GRAPH_INDEX: Record<string, string> = {
  '1': 'first',
  '2': 'second',
  '3': 'third',
  '4': 'fourth',
  '-1': 'last',
};

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The engine's start/end → Graph's, plus the local wall time it stands for. */
function googleDateToGraph(dt: GoogleDateTime): { graph: GraphDateTime; wall: string; tz: string } {
  if (dt.date) {
    const wall = `${dt.date}T00:00:00`;
    return { graph: { dateTime: wall, timeZone: 'UTC' }, wall, tz: 'UTC' };
  }
  const iso = dt.dateTime ?? '';
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (zoned && isIanaZone(dt.timeZone)) {
    const wall = svWall(new Date(iso), dt.timeZone).replace(' ', 'T');
    return { graph: { dateTime: wall, timeZone: dt.timeZone }, wall, tz: dt.timeZone };
  }
  const wall = zoned ? new Date(iso).toISOString().slice(0, 19) : iso.slice(0, 19);
  return { graph: { dateTime: wall, timeZone: 'UTC' }, wall, tz: 'UTC' };
}

/**
 * An RRULE line (as the engine writes it for Google) → Graph's recurrence.
 * `startWall` is the first occurrence's local wall time, `tz` its zone.
 */
export function rruleToGraphRecurrence(
  rruleLine: string,
  startWall: string,
  tz: string,
): Record<string, unknown> {
  const rule = parseRrule(rruleLine);
  const startDate = startWall.slice(0, 10);
  const startDay = JS_DAY[new Date(`${startDate}T00:00:00Z`).getUTCDay()]!;
  const days = (rule.byDay.length ? rule.byDay : [startDay]).map((d) => GRAPH_DAY[d]);

  let pattern: Record<string, unknown>;
  switch (rule.freq) {
    case 'DAILY':
      pattern = { type: 'daily', interval: rule.interval };
      break;
    case 'WEEKLY':
      pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: days, firstDayOfWeek: 'sunday' };
      break;
    case 'MONTHLY':
      pattern =
        rule.byDayOrdinal !== null && rule.byDay.length
          ? {
              type: 'relativeMonthly',
              interval: rule.interval,
              daysOfWeek: days,
              index: GRAPH_INDEX[String(rule.byDayOrdinal)] ?? 'first',
            }
          : {
              type: 'absoluteMonthly',
              interval: rule.interval,
              dayOfMonth: rule.byMonthDay ?? Number(startDate.slice(8, 10)),
            };
      break;
    default:
      pattern = {
        type: 'absoluteYearly',
        interval: rule.interval,
        dayOfMonth: Number(startDate.slice(8, 10)),
        month: Number(startDate.slice(5, 7)),
      };
  }

  // The engine restates a timed rule's UNTIL as a UTC instant (Google wants
  // that); Graph wants the last local DATE, so it is read back on `tz`.
  const untilInstant = /UNTIL=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(rruleLine);
  const endDate = untilInstant
    ? svWall(
        new Date(
          `${untilInstant[1]}-${untilInstant[2]}-${untilInstant[3]}T${untilInstant[4]}:${untilInstant[5]}:${untilInstant[6]}Z`,
        ),
        isIanaZone(tz) ? tz : 'UTC',
      ).slice(0, 10)
    : rule.untilDate;

  const range: Record<string, unknown> = endDate
    ? { type: 'endDate', startDate, endDate }
    : rule.count
      ? { type: 'numbered', startDate, numberOfOccurrences: rule.count }
      : { type: 'noEnd', startDate };
  if (tz !== 'UTC') range.recurrenceTimeZone = tz;
  return { pattern, range };
}

/** One removed occurrence of a series, as the UTC window it starts in. */
export interface RemovedOccurrence {
  /** UTC bounds to list instances between. */
  from: string;
  to: string;
  /** The occurrence's start instant; null for an all-day one (any instance
   *  inside the window is it). */
  startMs: number | null;
}

/** EXDATE lines (as the engine writes them for Google) → the windows to
 *  find and delete each removed occurrence in. */
export function exdatesToRemovals(lines: string[]): RemovedOccurrence[] {
  const out: RemovedOccurrence[] = [];
  for (const line of lines) {
    const allDay = /^EXDATE;VALUE=DATE:(\d{4})(\d{2})(\d{2})$/.exec(line);
    if (allDay) {
      const day = `${allDay[1]}-${allDay[2]}-${allDay[3]}`;
      out.push({ from: `${day}T00:00:00Z`, to: `${addDays(day, 1)}T00:00:00Z`, startMs: null });
      continue;
    }
    const timed = /^EXDATE;TZID=([^:]+):(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(line);
    if (!timed) continue;
    const tz = timed[1]!;
    const wall = `${timed[2]}-${timed[3]}-${timed[4]}T${timed[5]}:${timed[6]}:${timed[7]}`;
    const startMs = Date.parse(`${wall}${isIanaZone(tz) ? offsetForLocalDatetime(tz, wall) : 'Z'}`);
    if (!Number.isFinite(startMs)) continue;
    out.push({
      from: new Date(startMs - 60_000).toISOString(),
      to: new Date(startMs + 60_000).toISOString(),
      startMs,
    });
  }
  return out;
}

export interface GraphWrite {
  body: Record<string, unknown>;
  /** Occurrences to delete after the master is written. */
  removals: RemovedOccurrence[];
}

/**
 * The body the engine built for Google → the one Graph accepts.
 *
 * `showAs` and `transactionId` are sent on create only. `showAs` because a
 * later edit from Chord must not flatten "tentative" or "out of office" to
 * busy; `transactionId` because Graph accepts it only when the event is made.
 */
export function googleBodyToGraph(body: Record<string, unknown>, create: boolean): GraphWrite {
  const out: Record<string, unknown> = {};
  if (typeof body.summary === 'string') out.subject = body.summary;
  if (typeof body.description === 'string') out.body = { contentType: 'text', content: body.description };
  if (typeof body.location === 'string') out.location = { displayName: body.location };

  const start = body.start as GoogleDateTime | undefined;
  const end = body.end as GoogleDateTime | undefined;
  let startWall = '';
  let tz = 'UTC';
  if (start) {
    const allDay = !!start.date;
    const s = googleDateToGraph(start);
    startWall = s.wall;
    tz = s.tz;
    out.start = s.graph;
    out.isAllDay = allDay;
    if (allDay) {
      // Graph needs an all-day event to end on a later midnight.
      const endDate = end?.date && end.date > start.date! ? end.date : addDays(start.date!, 1);
      out.end = { dateTime: `${endDate}T00:00:00`, timeZone: 'UTC' };
    } else if (end) {
      out.end = googleDateToGraph(end).graph;
    }
  }

  if (create) {
    out.showAs = body.transparency === 'transparent' ? 'free' : 'busy';
    const chordUid = (body.extendedProperties as { private?: Record<string, string> } | undefined)?.private?.[
      CHORD_UID_PROP
    ];
    if (chordUid) out.transactionId = chordUid;
  }

  // An empty list is sent too: it is how the last guest comes off (ADR 0295).
  const attendees = body.attendees as Array<{ email?: string }> | undefined;
  if (Array.isArray(attendees)) {
    out.attendees = attendees
      .filter((a) => !!a.email)
      .map((a) => ({ emailAddress: { address: a.email }, type: 'required' }));
  }

  let removals: RemovedOccurrence[] = [];
  const recurrence = body.recurrence as string[] | undefined;
  if (recurrence?.length && startWall) {
    const rule = recurrence.find((l) => l.startsWith('RRULE:'));
    if (rule) out.recurrence = rruleToGraphRecurrence(rule, startWall, tz);
    removals = exdatesToRemovals(recurrence.filter((l) => l.startsWith('EXDATE')));
  }
  return { body: out, removals };
}

/** Graph's calendar → the access role the Block default is judged from. */
export function graphCalendarRole(cal: GraphCalendar, accountEmail: string): 'owner' | 'writer' | 'reader' {
  if (!cal.canEdit) return 'reader';
  const owner = cal.owner?.address?.toLowerCase();
  return !owner || owner === accountEmail.toLowerCase() ? 'owner' : 'writer';
}
