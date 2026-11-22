import { sql, type InsertObject, type Insertable, type Kysely, type Selectable } from 'kysely';

import { normalizeText, type GroupEvent, type Rsvp } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB, EventsTable, RsvpsTable } from '../db/schema.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { newId } from '../utils/ids.js';
import { likeContains } from '../utils/like.js';
import { zonedDayStartUtc } from '../utils/tz.js';
import { byInstant, textInstant, validZone } from '../db/text-instant.js';
import {
  calendarDisplayColors,
  calendarSourceLabel,
  resolveTargetCalendarId,
} from './calendar-sources.service.js';
import { buildEventContextExcerpt } from './events/context-excerpt.js';
import { retireTasksForRemovedEvents } from './events/retire-event-tasks.js';
import {
  TRAVEL_LEG_EXTERNAL_UID_PREFIX,
  flightFacts,
  isSameEvent,
  mergeEventDetails,
  type EventLike,
} from './events/same-event.js';
import { createSeriesFromCopies, deleteOccurrence, firstOccurrence } from './events/series.service.js';
import { pushDirtyEvents } from './google/two-way-sync.service.js';
import { computeTransparency, nextSequenceOnLocalEdit } from './google/two-way-sync.js';
import { TrustError, isTrusted, isTrustedForPersona } from './trust.service.js';
import { displayTravelerName } from './trips/chain.js';
import { loadTripTravelers } from './trips/trip-conflict.js';
import { runAfterCommit } from '../db/after-commit.js';
import { env } from '../config/env.js';
import { inviteAddressFor, organizerAddress, organizerInviteVia, type InviteVia } from './events/invite-plan.js';
import { rememberFamilyInvites } from './events/family-invite-tracker.js';

/** `events.starts_at` as a real instant (see db/text-instant.ts). */
export function eventStartInstant(tz: string | null | undefined) {
  return textInstant('events.starts_at', tz);
}

/**
 * The event is on at some point in [lo, hi): it starts before the range ends
 * and has not ended when it begins. A trip block or conference that started
 * earlier is still on; an end at the range's first midnight (an all-day
 * event's exclusive end) is not. A row with no end counts by its start.
 */
export function eventOverlapsRange(tz: string | null | undefined, lo: string, hi: string) {
  const startsAt = eventStartInstant(tz);
  const endsAt = textInstant('events.ends_at', tz);
  return sql<boolean>`(${startsAt} < ${hi}::timestamptz
    and (${startsAt} >= ${lo}::timestamptz or coalesce(${endsAt}, ${startsAt}) > ${lo}::timestamptz))`;
}

/** Default read window around today (owner call): a week back, a month on. */
export const EVENT_WINDOW_PAST_DAYS = 7;
export const EVENT_WINDOW_FUTURE_DAYS = 30;
/** A safety net only - the window is what bounds a read. */
const EVENT_WINDOW_MAX_ROWS = 3000;

export interface EventWindow {
  /** Days before now; default EVENT_WINDOW_PAST_DAYS. */
  pastDays?: number;
  /** Days after now; default EVENT_WINDOW_FUTURE_DAYS. */
  futureDays?: number;
  /** The reader's zone, for floating (all-day) values. */
  tz?: string | null;
}

/**
 * Keep an event that overlaps [now - pastDays, now + futureDays]: it starts
 * before the far edge and has not ended (or, with no end, not started) before
 * the near one - so a trip-long all-day block that began last month still
 * shows today. Replaces "oldest 500 ever": for a calendar synced back to 2021
 * that returned only 2021 and none of today.
 */
function inEventWindow(win: EventWindow | undefined) {
  const now = Date.now();
  const lo = new Date(now - (win?.pastDays ?? EVENT_WINDOW_PAST_DAYS) * 86_400_000).toISOString();
  const hi = new Date(now + (win?.futureDays ?? EVENT_WINDOW_FUTURE_DAYS) * 86_400_000).toISOString();
  const start = textInstant('events.starts_at', win?.tz);
  const end = textInstant('events.ends_at', win?.tz);
  return sql<boolean>`(${startsAtTextNoLaterThan(hi)} AND ${start} <= ${hi}::timestamptz AND coalesce(${end}, ${start}) >= ${lo}::timestamptz)`;
}

/**
 * An index-usable outer bound for the exact instant test beside it, which
 * (an expression over the text) cannot use (owner_user_id|group_id,
 * starts_at). Not a time comparison in its own right: every stored shape
 * begins with its own local date, and that date is within 14 hours of the
 * instant whatever the offset or reader zone, so a value whose instant is at
 * or before `hi` has a date no later than hi's UTC date + 1. Anything it
 * keeps is still decided by the instant test. It mostly drops the repeating
 * series written out a year ahead (ADR 0217) from a 30-day read.
 */
function startsAtTextNoLaterThan(hi: string) {
  const bound = new Date(Date.parse(hi) + 2 * 86_400_000).toISOString().slice(0, 10);
  return sql<boolean>`events.starts_at < ${bound}`;
}

/** [start of `startDate`, start of the day after `endDate`) in `tz`, as UTC. */
export function zonedDayRange(
  startDate: string,
  endDate: string,
  tz: string | null | undefined,
): { lo: string; hi: string } {
  const zone = validZone(tz);
  const next = new Date(Date.parse(`${endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return {
    lo: zonedDayStartUtc(startDate, zone).toISOString(),
    hi: zonedDayStartUtc(next, zone).toISOString(),
  };
}

/** Owner of an event copy — the assignee's calendar wins, else the creator's. */
function ownerOf(row: {
  owner_user_id?: string | null;
  assignee_id?: string | null;
  created_by: string | null;
}): string | null {
  return row.owner_user_id ?? row.assignee_id ?? row.created_by;
}

/** Every member user id of a group (the fan-out target set, ADR 0040 §7). */
async function groupMemberIds(db: Kysely<DB>, groupId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .execute();
  return rows.map((r) => r.user_id);
}

/**
 * The Google linkage encoded in a legacy `external_uid` (`gcal:<id>` for the
 * primary calendar, `gcal:<calId>:<id>` for a secondary). Lets edit/delete of a
 * row synced before two-way support still target the right Google event/calendar
 * instead of POSTing a duplicate. Returns null for non-gcal rows.
 */
function gcalLinkFromExternalUid(
  externalUid: string | null | undefined,
): { eventId: string; calendarId: string } | null {
  if (!externalUid?.startsWith('gcal:')) return null;
  const rest = externalUid.slice('gcal:'.length);
  const i = rest.indexOf(':');
  return i === -1
    ? { eventId: rest, calendarId: 'primary' }
    : { calendarId: rest.slice(0, i), eventId: rest.slice(i + 1) };
}

const pushesInFlight = new Map<string, Promise<unknown>>();

/**
 * Push the owner's dirty events without waiting. Inside a transaction the
 * push waits for the commit (ADR 0313 addendum): started on the transaction
 * it claimed the row there and could not record the Google id after commit.
 * A transaction with no after-commit leaves the row dirty for the next sync.
 */
function firePush(db: Kysely<DB>, owner: string, op: string, eventId: string): void {
  runAfterCommit(db, (h) => trackPush(h, owner, op, eventId), `two-way push (${op})`);
}

function trackPush(db: Kysely<DB>, owner: string, op: string, eventId: string): Promise<void> {
  const run = pushDirtyEvents(db, owner).then(
    () => undefined,
    (err) => {
      logger.warn(`two-way push (${op}) failed`, { err: String(err), eventId });
    },
  );
  const chained = Promise.all([pushesInFlight.get(owner), run]).finally(() => {
    if (pushesInFlight.get(owner) === chained) pushesInFlight.delete(owner);
  });
  pushesInFlight.set(owner, chained);
  return run;
}

/** Push `owner`'s dirty events in the background (after commit inside a
 *  transaction). For callers outside this file that just made rows dirty. */
export function queueOwnerPush(db: Kysely<DB>, owner: string, op: string, eventId: string): void {
  firePush(db, owner, op, eventId);
}

/** ADR 0328 — send a group event's invitations, recording the outcome at
 *  once (before the lazy import resolves) for the turn that made the event. */
function startFamilyInvites(db: Kysely<DB>, organizerEventId: string): Promise<void> {
  const run = import('./events/family-invites.js')
    .then((m) => m.sendFamilyInvites(db, organizerEventId))
    .catch((err) => {
      logger.error('family invites failed', { err: String(err), eventId: organizerEventId });
      return null;
    });
  rememberFamilyInvites(organizerEventId, run);
  return run.then(() => undefined);
}

/** Resolves once every background push started for this user has finished
 *  (ADR 0295: guests can only be added once the event exists on the
 *  provider). Never rejects. */
export async function waitForBackgroundPush(owner: string): Promise<void> {
  await pushesInFlight.get(owner);
}

function rowToEvent(row: Selectable<EventsTable>): GroupEvent {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    location: row.location ?? undefined,
    startsAt: row.starts_at,
    endsAt: row.ends_at ?? undefined,
    createdBy: row.created_by,
    ownerUserId: row.owner_user_id ?? undefined,
    assigneePersonaId: row.assignee_persona_id ?? undefined,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
    description: row.description ?? undefined,
    meetingContext: row.meeting_context ?? undefined,
    externalUid: row.external_uid ?? undefined,
    transparency: (row.transparency as 'opaque' | 'transparent' | undefined) ?? 'opaque',
    seriesId: row.series_id ?? undefined,
    tripId: row.trip_id ?? undefined,
    timeZone: row.start_tz ?? undefined,
  };
}

const LEG_UID_PREFIX = 'chord:travel_leg:';

/**
 * ADR 0289 — name the trip an entry is part of, and who travels on it. A
 * ticket's own entry (`chord:travel_leg:<legId>`) is its leg's trip; any other
 * carries the trip stored on it. Cancelled and deleted trips are not named.
 */
async function withTrips(db: Kysely<DB>, events: GroupEvent[]): Promise<GroupEvent[]> {
  const legIds = [
    ...new Set(
      events
        .filter((e) => !e.tripId && e.externalUid?.startsWith(LEG_UID_PREFIX))
        .map((e) => e.externalUid!.slice(LEG_UID_PREFIX.length)),
    ),
  ];
  const tripOfLeg = new Map<string, string>();
  if (legIds.length > 0) {
    for (const l of await db.selectFrom('travel_legs').select(['id', 'trip_id']).where('id', 'in', legIds).execute()) {
      tripOfLeg.set(l.id, l.trip_id);
    }
  }
  const tripOf = (e: GroupEvent): string | undefined =>
    e.tripId ??
    (e.externalUid?.startsWith(LEG_UID_PREFIX) ? tripOfLeg.get(e.externalUid.slice(LEG_UID_PREFIX.length)) : undefined);
  const tripIds = [...new Set(events.map(tripOf).filter((id): id is string => !!id))];
  if (tripIds.length === 0) return events;
  const [trips, travelers] = await Promise.all([
    db
      .selectFrom('trips')
      .select(['id', 'name'])
      .where('id', 'in', tripIds)
      .where('deleted_at', 'is', null)
      .where('cancelled_at', 'is', null)
      .execute(),
    loadTripTravelers(db, tripIds, null),
  ]);
  const nameOf = new Map(trips.map((t) => [t.id, t.name]));
  return events.map((e) => {
    const id = tripOf(e);
    const name = id ? nameOf.get(id) : undefined;
    if (!id || !name) return e.tripId ? { ...e, tripId: undefined } : e;
    const who = [
      ...new Set((travelers.get(id) ?? []).map((t) => (t.name ? displayTravelerName(t.name) : null)).filter((n): n is string => !!n)),
    ];
    return { ...e, tripId: id, tripName: name, ...(who.length ? { tripTravelers: who } : {}) };
  });
}

/**
 * Fill `assigneePersonaName` on any DTOs carrying an `assigneePersonaId`
 * (ADR 0151). One batched lookup; a no-op when nothing is persona-assigned.
 */
async function withPersonaNames(db: Kysely<DB>, events: GroupEvent[]): Promise<GroupEvent[]> {
  events = await withTrips(db, events);
  const ids = [...new Set(events.map((e) => e.assigneePersonaId).filter((x): x is string => !!x))];
  if (ids.length === 0) return events;
  const rows = await db.selectFrom('personas').select(['id', 'name']).where('id', 'in', ids).execute();
  const names = new Map(rows.map((r) => [r.id, r.name]));
  return events.map((e) =>
    e.assigneePersonaId ? { ...e, assigneePersonaName: names.get(e.assigneePersonaId) } : e,
  );
}

/**
 * Every live copy of a logical event (all rows sharing `ical_uid`), for
 * per-owner SSE fan-out: the caller broadcasts one event per copy so each
 * member's client receives its own owner-tagged copy. A row with no ical_uid
 * (legacy / single-copy) yields just itself.
 */
/**
 * The subset of `ids` that are still live events of this user's - the same
 * predicate `/me/events` lists by, without its date window, so a device copy
 * of a far-off event is not mistaken for a deleted one.
 */
export async function liveEventIdsForUser(
  db: Kysely<DB>,
  userId: string,
  ids: string[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .selectFrom('events')
    .select('id')
    .where('id', 'in', ids)
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .execute();
  return rows.map((r) => r.id);
}

export async function listEventCopies(db: Kysely<DB>, eventId: string): Promise<GroupEvent[]> {
  const head = await db
    .selectFrom('events')
    .select(['ical_uid'])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!head) return [];
  if (!head.ical_uid) {
    const one = await getEvent(db, eventId);
    return one ? [one] : [];
  }
  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('ical_uid', '=', head.ical_uid)
    .where('deleted_at', 'is', null)
    .execute();
  return withPersonaNames(db, rows.map(rowToEvent));
}

function rowToRsvp(row: RsvpsTable): Rsvp {
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id ?? undefined,
    displayName: row.display_name,
    status: row.status,
    solo: row.solo === 1,
    dish: row.dish ?? undefined,
    notes: row.notes ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Collapse fan-out copies (ADR 0040 §7 — one row per member) to **one row
 * per logical event** (`ical_uid`, or the row's own id when absent),
 * preferring the organizer's copy. Shared by `listEvents` and the
 * direct-SQL event-default lookups below (`findNearestEvent`/
 * `findLatestEvent`) so both read the "one event, not N per-seat copies"
 * rule from the same place rather than two copies that can drift.
 */
function dedupeByIcalUid(rows: Selectable<EventsTable>[]): Selectable<EventsTable>[] {
  const byUid = new Map<string, Selectable<EventsTable>>();
  for (const r of rows) {
    const key = r.ical_uid ?? r.id;
    const cur = byUid.get(key);
    if (!cur || (r.role === 'organizer' && cur.role !== 'organizer')) byUid.set(key, r);
  }
  return [...byUid.values()];
}

/**
 * God-view of a group's events: every copy across all members. Fan-out
 * (ADR 0040 §7) stores one row per member, so this collapses to **one logical
 * event per `ical_uid`** — preferring the organizer copy — for callers that
 * want the group's schedule, not per-seat copies (bot context). The
 * per-viewer group calendar uses `listEventsForUserInGroup` instead.
 */
export async function listEvents(
  db: Kysely<DB>,
  groupId: string,
  win?: EventWindow,
): Promise<GroupEvent[]> {
  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where(inEventWindow(win))
    .orderBy(eventStartInstant(win?.tz), 'asc')
    .limit(EVENT_WINDOW_MAX_ROWS)
    .execute();
  return withPersonaNames(
    db,
    dedupeByIcalUid(rows)
      .sort(byInstant((r) => r.starts_at))
      .map(rowToEvent),
  );
}

/**
 * The nearest upcoming event in a group, or (if none) the single most
 * recent past one — `get_event_status`'s "no eventId given" default.
 * Queried bounded by time direction directly in SQL (a small batch each
 * way, deduped by `dedupeByIcalUid` exactly like `listEvents`) instead of
 * scanning `listEvents`' unbounded-into-the-past, 500-row-capped window and
 * filtering in JS. That old path let a years-old past event win "nearest
 * upcoming" purely because it sorted into the kept window and a real
 * upcoming event (ranked past row 500 in a long-lived account) didn't — see
 * `findEventsByTitle`'s doc comment for the same root cause on the
 * `update_event`/`delete_event` title-match path.
 */
export async function findNearestEvent(
  db: Kysely<DB>,
  groupId: string,
  nowIso: string,
  tz: string | null = null,
): Promise<GroupEvent | null> {
  const scope = () =>
    db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('deleted_at', 'is', null)
      .where('status', '!=', 'cancelled');
  // Compare instants, not strings: "10:00-04:00" is two hours AFTER a
  // "12:00Z" now, but sorts before it as text.
  // A floating (all-day) value is wall time in the user's zone. An event not
  // yet over counts: the meeting happening now is the one being asked about.
  const startsAt = eventStartInstant(tz);
  const endsAt = textInstant('events.ends_at', tz);
  const asc = byInstant<{ starts_at: string }>((r) => r.starts_at);
  const upcomingRows = await scope()
    .where(sql<boolean>`coalesce(${endsAt}, ${startsAt}) > ${nowIso}::timestamptz or ${startsAt} >= ${nowIso}::timestamptz`)
    .orderBy(startsAt, 'asc')
    .limit(50)
    .execute();
  let rows = dedupeByIcalUid(upcomingRows).sort(asc);
  if (rows.length === 0) {
    const pastRows = await scope().orderBy(startsAt, 'desc').limit(50).execute();
    rows = dedupeByIcalUid(pastRows).sort((a, b) => asc(b, a));
  }
  if (rows.length === 0) return null;
  const [event] = await withPersonaNames(db, [rowToEvent(rows[0]!)]);
  return event ?? null;
}

/**
 * ADR 0040 §8 — the single owner-scoped read primitive. A user's calendar is
 * exactly *their own copies* (`owner_user_id = me`), across every group plus
 * personal Google pulls (`group_ids = []`). Tombstones (deleted/cancelled) are
 * excluded. The `events → group_members` join is retired: with per-member
 * copies it would return N duplicates per logical event.
 */
export async function listEventsForUser(
  db: Kysely<DB>,
  userId: string,
  win?: EventWindow,
): Promise<GroupEvent[]> {
  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where(inEventWindow(win))
    .orderBy(eventStartInstant(win?.tz), 'asc')
    .limit(EVENT_WINDOW_MAX_ROWS)
    .execute();
  const colorOf = await calendarColorResolver(db, userId);
  return withPersonaNames(db, rows.map((r) => ({ ...rowToEvent(r), ...colorOf(r) })));
}

/**
 * ADR 0072 — map each event row to its source calendar's display color so the
 * client can render by-calendar colors. Resolution mirrors conflicts.service
 * `calIdOf`: explicit `google_calendar_id` wins; else the `gcal:`/`device:`
 * external_uid encodes the calendar (a bare `gcal:<eventId>` means primary).
 * Chord-native events resolve to null (clients use the accent).
 */
async function calendarColorResolver(
  db: Kysely<DB>,
  userId: string,
): Promise<
  (row: { google_calendar_id: string | null; external_uid: string | null }) => {
    color: string | null;
    calendarName: string | null;
  }
> {
  const sources = await db
    .selectFrom('calendar_sources')
    .select(['id', 'google_calendar_id', 'summary', 'provider', 'color', 'color_choice', 'is_primary', 'first_seen_at'])
    .where('user_id', '=', userId)
    .execute();
  if (sources.length === 0) return () => ({ color: null, calendarName: null });
  // ADR 0278 — the same colors the Settings list shows.
  const display = calendarDisplayColors(sources);
  const byCal = new Map(
    sources.map((s) => [
      s.google_calendar_id,
      { color: display.get(s.id) ?? null, calendarName: calendarSourceLabel(s) },
    ]),
  );
  const primaryId =
    sources.find((s) => Number(s.is_primary) === 1)?.google_calendar_id ?? null;
  return (row) => {
    let calId: string | null = row.google_calendar_id;
    const uid = row.external_uid ?? '';
    if (!calId && uid.startsWith('gcal:')) {
      const rest = uid.slice('gcal:'.length);
      const sep = rest.indexOf(':');
      calId = sep === -1 ? primaryId : rest.slice(0, sep);
    } else if (!calId && uid.startsWith('device:')) {
      // device:<calendarId>:<eventId[:occurrence]> — the event id may itself
      // contain colons (ISO occurrence suffix), so split at the FIRST one.
      const rest = uid.slice('device:'.length);
      const sep = rest.indexOf(':');
      if (sep !== -1) calId = rest.slice(0, sep);
    }
    return (calId ? byCal.get(calId) : undefined) ?? { color: null, calendarName: null };
  };
}

/**
 * ADR 0040 §8 — the group calendar from one viewer's seat: their own copies
 * tagged for this group (`owner_user_id = me AND group_ids ? 'G'`). Because
 * fan-out covers every current member, this *is* the complete group schedule
 * from that seat — no dedup needed. Also the strict per-group scope of ADR 0032,
 * expressed without a group-members join.
 */
export async function listEventsForUserInGroup(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  win?: EventWindow,
): Promise<GroupEvent[]> {
  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', userId)
    .where(sql<boolean>`group_ids ? ${groupId}`)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where(inEventWindow(win))
    .orderBy(eventStartInstant(win?.tz), 'asc')
    .limit(EVENT_WINDOW_MAX_ROWS)
    .execute();
  const colorOf = await calendarColorResolver(db, userId);
  return withPersonaNames(db, rows.map((r) => ({ ...rowToEvent(r), ...colorOf(r) })));
}

/**
 * Title-match an event for `update_event`/`delete_event`'s `titleContains`
 * resolution. Filters in SQL rather than reusing `listEvents`/
 * `listEventsForUser` — those two are a bounded *chronological* window
 * (ascending `starts_at`, capped at `opts.limit ?? 500`) meant for "give me
 * the calendar", and a long-lived account accumulates past events that are
 * never pruned (ADR 0092 keeps completed/history rows on purpose). Once a
 * group or user passes 500 live rows, everything ranked past that cutoff —
 * including a near-term appointment — silently never reached the client-side
 * `.filter()` those callers used to do. Matching in SQL instead means a
 * title hit is found regardless of how much older history sits ahead of it.
 * Capped at 50 candidates: high enough for any real disambiguation, low
 * enough to keep a generic needle ("meeting") from ballooning the result.
 *
 * A group-scoped match is deduped by `dedupeByIcalUid` exactly like
 * `listEvents` — a shared event fanned out to N members (ADR 0040 §7) is one
 * logical event, not N "ambiguous" candidates all sharing the same title and
 * start time. Owner-scoped matches need no dedup: fan-out gives each member
 * exactly one copy per logical event, so `owner_user_id = X` can't return two
 * rows for the same one.
 */
export async function findEventsByTitle(
  db: Kysely<DB>,
  scope: { groupId: string } | { ownerUserId: string },
  titleContains: string,
  date?: string,
  tz?: string | null,
): Promise<GroupEvent[]> {
  const pat = likeContains(titleContains.toLowerCase());
  const startsAt = eventStartInstant(tz);
  let q = db
    .selectFrom('events')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where((eb) => eb(eb.fn('lower', ['title']), 'like', pat));
  q =
    'groupId' in scope
      ? q.where('group_id', '=', scope.groupId)
      : q.where('owner_user_id', '=', scope.ownerUserId);
  // The user's day, compared as instants: a text prefix put a 9pm event
  // stored in UTC ("…T01:00Z" next day) on the wrong date.
  if (date) {
    const { lo, hi } = zonedDayRange(date, date, tz);
    q = q.where(startsAt, '>=', lo).where(startsAt, '<', hi);
  }
  // Nearest to now first: a recurring title since 2021 has hundreds of
  // matches, and taking them oldest-first left out the one coming up - the
  // one someone asking to move or delete "soccer practice" means.
  const rows = await q
    .orderBy(sql`abs(extract(epoch from (${startsAt} - now())))`, 'asc')
    .limit(200)
    .execute();
  const deduped = 'groupId' in scope ? dedupeByIcalUid(rows) : rows;
  const nearest = deduped.slice(0, 50);
  return withPersonaNames(db, nearest.sort(byInstant((r) => r.starts_at)).map(rowToEvent));
}

/**
 * Direct-SQL keyword search for the `search` bot tool's events category —
 * matches title OR location by literal substring (events has no
 * `search_tsv`), scoped by group_id or owner_user_id exactly like
 * `findEventsByTitle`, deduped by `dedupeByIcalUid` for a group-scoped
 * search (a shared event fanned out to N members must surface once). Not
 * `listEvents(ForUser)`'s 500-row, ascending-from-the-beginning-of-time
 * window — see that function's doc comment for the root-cause writeup this
 * and `findEventsByTitle` both replace.
 */
export async function searchEventsScoped(
  db: Kysely<DB>,
  scope: { groupId: string } | { ownerUserId: string },
  qLike: string,
  cap: number,
): Promise<GroupEvent[]> {
  let q = db
    .selectFrom('events')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where((eb) =>
      eb.or([
        eb(sql<boolean>`lower(title) like ${qLike} escape '\\'`, '=', true),
        eb(sql<boolean>`lower(coalesce(location,'')) like ${qLike} escape '\\'`, '=', true),
      ]),
    );
  q = 'groupId' in scope ? q.where('group_id', '=', scope.groupId) : q.where('owner_user_id', '=', scope.ownerUserId);
  const rows = await q.orderBy(eventStartInstant(null), 'desc').limit(200).execute();
  const deduped = 'groupId' in scope ? dedupeByIcalUid(rows) : rows;
  return withPersonaNames(
    db,
    deduped
      .sort((a, b) => byInstant<typeof a>((r) => r.starts_at)(b, a))
      .slice(0, cap)
      .map(rowToEvent),
  );
}

/**
 * Group-chat scoping for the user's calendar.
 *
 * When the bot is invoked in a non-personal group and the user asks
 * about their calendar, we must never leak events from their primary or
 * other personal Google calendars. The only calendar Chord considers
 * "shareable" is the one Chord itself owns (the user's Chord-target
 * calendar, name controlled by GCAL_TARGET_CALENDAR_NAME, default
 * "Family"). Personal-context reads (the user chatting with the bot
 * alone) keep the full unfiltered view via listEventsForUser.
 *
 * Default-deny: if the user hasn't pushed/saved an event yet, their
 * google_calendar_id is unset and we return [] rather than risk
 * leaking from primary on a best-guess match.
 */
export async function listEventsForUserFromChordCalendar(
  db: Kysely<DB>,
  userId: string,
  win?: EventWindow,
): Promise<GroupEvent[]> {
  const user = await db
    .selectFrom('users')
    .select(['google_calendar_id', 'email'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const familyCalId = user?.google_calendar_id ?? null;
  if (!familyCalId) return [];
  const email = (user?.email ?? '').toLowerCase();
  // Treat Family-as-primary when the cached id matches the user's email
  // (primary calendars on Google are addressed by the owner's email).
  const familyIsPrimary =
    familyCalId === 'primary' ||
    (email.length > 0 && familyCalId.toLowerCase() === email);

  const all = await listEventsForUser(db, userId, win);
  return all.filter((e) => isFromCalendar(e.externalUid, familyCalId, familyIsPrimary));
}

function isFromCalendar(
  externalUid: string | undefined,
  familyCalId: string,
  familyIsPrimary: boolean,
): boolean {
  if (!externalUid || !externalUid.startsWith('gcal:')) return false;
  const rest = externalUid.slice('gcal:'.length);
  const sep = rest.indexOf(':');
  if (sep === -1) {
    // Bare uid = synced from the user's primary Google calendar.
    return familyIsPrimary;
  }
  const calId = rest.slice(0, sep);
  return calId === familyCalId;
}

/**
 * What `createEvent` hands back. `merged` is set when nothing new was written
 * because the same event was already on the owner's calendar:
 * `updated` - its details were added to; `unchanged` - there was nothing to
 * add; `covered` - the existing one came from Google (an airline's own
 * invite, say) and is not ours to edit.
 */
export type CreatedEvent = GroupEvent & { merged?: 'updated' | 'unchanged' | 'covered' };

const eventLike = (r: Selectable<EventsTable>): EventLike => ({
  title: r.title,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  location: r.location,
  description: r.description,
  googleCalendarId: r.google_calendar_id,
  isTravelLeg: r.external_uid?.startsWith(TRAVEL_LEG_EXTERNAL_UID_PREFIX) ?? false,
  guestEmails: r.guest_emails,
});

/**
 * The creation-time duplicate check: an event the owner already has at the
 * same instants, about the same thing (`isSameEvent`), absorbs the incoming
 * one instead of gaining a twin beside it. Returns null when there is no such
 * event and the create should go ahead.
 */
async function mergeIntoSameEvent(
  db: Kysely<DB>,
  ownerUserId: string,
  incoming: EventLike,
  opts: { groupId?: string },
): Promise<CreatedEvent | null> {
  const t = Date.parse(incoming.startsAt);
  if (!Number.isFinite(t)) return null;
  const at = new Date(t).toISOString();
  let q = db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where('all_day', '=', 0)
    .where('series_id', 'is', null)
    // Stored with whatever offset the source gave it, so compare instants.
    .where(sql<boolean>`${textInstant('events.starts_at')} = ${at}::timestamptz`);
  if (opts.groupId) q = q.where('group_id', '=', opts.groupId);
  const rows = await q.execute();
  const match = rows.find((r) => isSameEvent(eventLike(r), incoming));
  if (!match) return null;

  // No chord_uid means the row was pulled from someone's calendar rather than
  // made here: it is already where it belongs, and editing it would push our
  // wording onto an event we do not own.
  if (!match.chord_uid) return { ...rowToEvent(match), merged: 'covered' };

  const patch = mergeEventDetails(eventLike(match), incoming);
  if (!patch) return { ...rowToEvent(match), merged: 'unchanged' };
  const updated = await updateEvent(db, match.id, patch);
  return { ...(updated ?? rowToEvent(match)), merged: 'updated' };
}

export async function createEvent(
  db: Kysely<DB>,
  input: {
    groupId: string;
    title: string;
    location?: string;
    /** Free-text body, mirrored to the Google event `description` (ADR 0158 —
     *  travel legs put the confirmation, itinerary number, and a link back to
     *  the source email here). */
    description?: string | null;
    startsAt: string;
    endsAt?: string;
    createdBy: string | null;
    sourceRawContext?: string | null;
    externalUid?: string | null;
    /** When set, the event "belongs to" this user — gcal-write pushes
     *  it to *their* calendar instead of the creator's. */
    assigneeId?: string | null;
    /** ADR 0151 — a managed persona as the subject. The event's owner (and gcal
     *  target) is the persona's `managed_by` adult, and its stored title is
     *  prefixed "<persona> — ". Mutually exclusive with `assigneeId`. */
    assigneePersonaId?: string | null;
    /** ADR 0033. Defaults to 'opaque' (event blocks time). */
    transparency?: 'opaque' | 'transparent';
    /** Force all-day (→ free, ADR 0040). Use for date-only entries whose
     *  startsAt carries a tz offset, where the string-based all-day sniff
     *  below would otherwise miss. */
    allDay?: boolean;
    /** The event already exists in someone's Google calendar, so Chord must
     *  not create a second one. Set by the calendar-invite path: the meeting
     *  is the organizer's, and it reaches the user's calendar when they RSVP
     *  — pushing would mint a rival copy of a meeting they were invited to.
     *  Cannot be inferred from `externalUid`: an imported `.ics` carries a
     *  bare RFC-5545 UID too, and that calendar really is only in Chord. */
    alreadyInGoogle?: boolean;
    /** ADR 0040 — target Google calendar id for the push (resolved by caller). */
    googleCalendarId?: string | null;
    /** ADR 0217 — make this a repeating event: an RRULE body (built by
     *  `buildRrule`, never by the model) and the zone it runs in. */
    repeat?: { rrule: string; tz: string };
    /** ADR 0247 — this group event is one of several the creator sent the
     *  same item to in one confirm, and an earlier group already gave them
     *  their copy. Fan out to everyone else only, so the creator's calendar
     *  does not show the event once per group. */
    omitCreatorCopy?: boolean;
    /** ADR 0297 — the IANA zone the times are in (start / end), written to
     *  every copy and sent to the calendar as `timeZone`. Set when an existing
     *  event is re-created elsewhere (ADR 0232 `share_event`), so its zone
     *  survives the move. */
    startTz?: string | null;
    endTz?: string | null;
    /** The same-event merge (ADR 0223) looks only in this group. Set when an
     *  event is re-created elsewhere: the original it is about to replace is
     *  the same event by definition, and folding into it, then deleting it,
     *  loses the event. */
    mergeOnlyInGroup?: boolean;
    /** Addresses this event will invite (ADR 0157). Only read by the
     *  same-event merge: an event at the same instants with these people is
     *  this meeting already (ADR 0223 addendum). Guests are sent separately. */
    guestEmails?: string[];
  },
): Promise<CreatedEvent> {
  if (input.assigneeId && input.assigneePersonaId) {
    throw new Error('assigneeId and assigneePersonaId are mutually exclusive');
  }
  if (
    input.assigneeId &&
    input.createdBy &&
    input.assigneeId !== input.createdBy &&
    !(await isTrusted(db, input.assigneeId, input.createdBy, 'event'))
  ) {
    throw new TrustError('event', input.createdBy, input.assigneeId);
  }
  // ADR 0151 — a persona-assigned event: trust runs through the managing adult,
  // whose calendar it lands on, and the stored title carries the persona name.
  let personaOwnerId: string | null = null;
  let personaName: string | null = null;
  let effectiveTitle = input.title;
  if (input.assigneePersonaId) {
    const persona = await db
      .selectFrom('personas')
      .select(['id', 'name'])
      .where('id', '=', input.assigneePersonaId)
      .where('group_id', '=', input.groupId)
      .executeTakeFirst();
    if (!persona) throw new Error('assigneePersonaId is not a persona in this group');
    const { trusted, managedBy } = await isTrustedForPersona(
      db,
      input.assigneePersonaId,
      input.createdBy ?? '',
      'event',
    );
    if (input.createdBy && !trusted) {
      throw new TrustError('event', input.createdBy, managedBy ?? input.createdBy);
    }
    personaOwnerId = managedBy;
    personaName = persona.name;
    // Stored, not push-only: applyRemoteToLocal round-trips `title` from Google
    // on every pull, so a prefix added only in the push payload would be
    // stripped or doubled. Prefix once, at create.
    const prefix = `${persona.name} — `;
    if (!effectiveTitle.startsWith(prefix)) effectiveTitle = prefix + effectiveTitle;
  }
  const now = new Date().toISOString();
  // Rows that already exist on someone's Google calendar must never be pushed
  // (loop prevention) and carry no chord_uid stamp — nothing over there is
  // ours to claim. Two sources: the read sync's own rows (`gcal:` prefix), and
  // a meeting the user was INVITED to, which arrives in Google by RSVP and not
  // by us. Pushing the latter is what put a rival copy of "John / Shail
  // Coffee" on the family calendar beside the organizer's real invite.
  const isPulled = (input.externalUid?.startsWith('gcal:') ?? false) || !!input.alreadyInGoogle;
  // Floating-midnight (YYYY-MM-DDT00:00:00, no Z/offset) is the all-day
  // convention. ADR 0040 decision 2: all-day events are free.
  const isAllDay = input.allDay ?? /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(input.startsAt);
  const transparency =
    input.transparency ??
    computeTransparency({ startsAt: input.startsAt, endsAt: input.endsAt, allDay: isAllDay });
  // One UID shared by every copy of this logical event (ADR 0040 §3); each copy
  // still gets its own chord_uid below (its own Google-origin stamp).
  const sharedIcalUid = input.externalUid ?? newId('e');

  // ADR 0040 §7 — fan-out trigger. A named single assignee (incl. the creator
  // naming themselves for "add to MY calendar") → one copy on that person's
  // calendar. No assignee + a real creator + no external provenance → a shared,
  // Chord-native group event: one copy per current member. Anything with an
  // external_uid (a gcal pull or an .ics import) is one person's calendar item,
  // not a group invitation, so it stays single-copy.
  const fanOut =
    !input.assigneeId && !input.assigneePersonaId && !!input.createdBy && !input.externalUid;
  let ownerIds: (string | null)[];
  if (fanOut) {
    ownerIds = await groupMemberIds(db, input.groupId);
    if (!ownerIds.includes(input.createdBy!)) ownerIds.push(input.createdBy!);
    if (input.omitCreatorCopy) {
      const others = ownerIds.filter((o) => o !== input.createdBy);
      if (others.length > 0) ownerIds = others;
    }
  } else {
    // A persona event is owned by its managing adult (ADR 0151).
    ownerIds = [input.assigneeId ?? personaOwnerId ?? input.createdBy ?? null];
  }

  // Each member's copy goes to THEIR OWN calendar (ADR 0232), chosen the way
  // the creator's is: `resolveTargetCalendarId`. Reading the raw
  // `default_calendar_id` here skipped its re-check (a stale or phone
  // calendar default, ADR 0136, sent the copy to a calendar Google refuses)
  // and its Outlook-only primary (ADR 0228: `primary` is Google's, so a
  // member with only Outlook got a copy nothing could push).
  const calendarByOwner = new Map<string, string>();
  if (fanOut) {
    const others = ownerIds.filter((o): o is string => !!o && o !== input.createdBy);
    const picks = await Promise.all(
      others.map(async (o) => [o, (await resolveTargetCalendarId(db, { userId: o })).calendarId] as const),
    );
    for (const [o, calendarId] of picks) calendarByOwner.set(o, calendarId);
  }

  // ADR 0328 — members who can be invited to the organizer's event instead of
  // given a copy on their own calendar. Not for a repeat (a series carries no
  // invitations yet), an imported or pulled event, or an extra group whose
  // creator copy is left out (there is no organizer event to carry guests).
  const inviteOf = new Map<string, string>();
  let inviteVia: InviteVia | null = null;
  if (
    env.FAMILY_EVENT_INVITES &&
    fanOut &&
    input.createdBy &&
    !input.repeat &&
    !input.alreadyInGoogle &&
    !input.omitCreatorCopy &&
    ownerIds.length > 1
  ) {
    inviteVia = await organizerInviteVia(db, input.createdBy, input.googleCalendarId);
    if (inviteVia) {
      const own = await organizerAddress(db, input.createdBy);
      for (const o of ownerIds) {
        if (!o || o === input.createdBy) continue;
        const address = await inviteAddressFor(db, o);
        if (address && address !== own && ![...inviteOf.values()].includes(address)) inviteOf.set(o, address);
      }
    }
  }

  // ADR 0162 — when the caller left `description` unspecified (as opposed to
  // an explicit `null`, which means "computed one and there's nothing to
  // say"), compose a context excerpt from the event's own provenance. Never
  // overrides a caller-supplied description (travel legs already build their
  // own richer one; a pulled invite keeps the organizer's).
  const resolvedDescription =
    input.description === undefined
      ? await buildEventContextExcerpt(db, input.createdBy, input.sourceRawContext)
      : input.description;

  // The same event again (a second email about one flight, one copy per
  // passenger, a retyped request) updates the one already there. Left alone:
  // repeats, all-day entries, and anything arriving with its own identity
  // from a calendar or an .ics file - those reconcile by key. A travel leg's
  // uid is ours, so it takes part.
  const mergeOwner = input.assigneeId ?? personaOwnerId ?? input.createdBy ?? null;
  const ownIdentity =
    !input.externalUid || input.externalUid.startsWith(TRAVEL_LEG_EXTERNAL_UID_PREFIX);
  if (mergeOwner && ownIdentity && !input.repeat && !isPulled && !isAllDay && !input.omitCreatorCopy) {
    const incoming: EventLike = {
      title: effectiveTitle,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
      description: resolvedDescription,
      googleCalendarId: input.googleCalendarId,
      isTravelLeg: !!input.externalUid,
      guestEmails: input.guestEmails ?? null,
    };
    // A child's flight folding into the parent's event keeps the child's name.
    if (personaName && flightFacts(incoming).isFlight) {
      incoming.description = [resolvedDescription, `Passenger: ${personaName}`]
        .filter(Boolean)
        .join('\n');
    }
    const merged = await mergeIntoSameEvent(db, mergeOwner, incoming, {
      // A group event gives every member a copy; one member's private event at
      // that time must not swallow it and leave the others without theirs.
      // A move between groups must not fold into the very row it replaces.
      groupId: fanOut || input.mergeOnlyInGroup ? input.groupId : undefined,
    });
    if (merged) return merged;
  }

  const copies: InsertObject<DB, 'events'>[] = [];
  const ids: string[] = [];
  const pushOwners = new Set<string>();
  let myId: string | null = null;
  for (const owner of ownerIds) {
    const invitedAt = owner ? inviteOf.get(owner) : undefined;
    if (!isPulled && owner && !invitedAt) pushOwners.add(owner);
    const role: 'organizer' | 'attendee' =
      fanOut && owner !== input.createdBy ? 'attendee' : 'organizer';
    // The creator's copy uses the caller-resolved calendar (it already honored
    // the prompt name). Every other member's copy resolves against *their*
    // calendar (their user default → primary).
    //
    // An invite claims no calendar: we are not putting it anywhere, and
    // Google decides which calendar the accepted copy lands on. Naming one
    // here would be a guess, and the pull matches an unbound row onto
    // whichever calendar the invite actually arrives on.
    let calId = input.alreadyInGoogle ? null : (input.googleCalendarId ?? null);
    if (!input.alreadyInGoogle && fanOut && owner && owner !== input.createdBy) {
      calId = calendarByOwner.get(owner) ?? 'primary';
    }
    // An invited member's row is Chord's record of the invitation: never
    // pushed, on no calendar of theirs until their pull meets the invitation.
    if (invitedAt) calId = null;
    const id = newId('e');
    ids.push(id);
    if (owner === input.createdBy) myId = id;
    copies.push({
      id,
      group_id: input.groupId,
      title: effectiveTitle,
      description: resolvedDescription ?? null,
      location: input.location ?? null,
      starts_at: input.startsAt,
      ends_at: input.endsAt ?? null,
      created_by: input.createdBy,
      created_at: now,
      source_raw_context: input.sourceRawContext ?? null,
      // Only the creator's/assignee's row carries the external dedup id; the
      // fanned-out attendee copies are distinct Chord-native rows.
      //
      // `|| null`, not `??`: an empty uid must land as NULL. The partial
      // unique index exempts NULL but not `''`, so one `''` row wedges every
      // later event in the group.
      external_uid:
        owner === (input.assigneeId ?? personaOwnerId ?? input.createdBy)
          ? input.externalUid || null
          : null,
      assignee_id: fanOut ? null : input.assigneeId ?? null,
      assignee_persona_id: input.assigneePersonaId ?? null,
      transparency,
      owner_user_id: owner,
      organizer_user_id: input.createdBy,
      role,
      ical_uid: sharedIcalUid,
      chord_uid: isPulled || invitedAt ? null : id,
      group_ids: JSON.stringify([input.groupId]),
      google_calendar_id: calId,
      all_day: isAllDay ? 1 : 0,
      start_tz: input.startTz ?? null,
      end_tz: input.endTz ?? input.startTz ?? null,
      updated_at: now,
      status: 'confirmed' as const,
      local_dirty: isPulled || invitedAt ? 0 : 1,
      ...(invitedAt ? { invite_email: invitedAt, invite_via: inviteVia } : {}),
    });
  }

  // ADR 0217 — a repeating event is a series per owner plus its occurrences,
  // written instead of the single copies.
  if (input.repeat && !isPulled) {
    // Built above from plain values, never SQL expressions.
    const series = await createSeriesFromCopies(db, copies as Insertable<EventsTable>[], input.repeat);
    for (const owner of pushOwners) firePush(db, owner, 'create-series', sharedIcalUid);
    const mine = series.find((s) => s.owner_user_id === input.createdBy) ?? series[0]!;
    const first = await firstOccurrence(db, mine.id);
    if (first) return rowToEvent(first);
  }

  await db.insertInto('events').values(copies).execute();

  // Genuine local creates push to Google via the two-way shell, once per
  // distinct owner (each pushes that owner's dirty rows under their own token;
  // no-op without write scope). Pulled rows are never pushed back.
  if (!isPulled) {
    for (const owner of pushOwners) firePush(db, owner, 'create', sharedIcalUid);
  }
  if (inviteOf.size > 0 && myId) {
    const organizerRowId = myId;
    const started = runAfterCommit(
      db,
      (h) => startFamilyInvites(h, organizerRowId),
      'family invites',
    );
    // Nobody will send them: give the members their copies now instead.
    if (!started) {
      const { convertToCopies } = await import('./events/family-invites.js');
      await convertToCopies(
        db,
        copies
          .filter((c) => inviteOf.has(c.owner_user_id as string))
          .map((c) => ({ id: c.id as string, owner_user_id: c.owner_user_id as string })),
      );
    }
  }

  // Return the caller's own copy (organizer/creator), or the sole copy — built
  // from the plain inputs, since the creator/sole copy always mirrors them.
  return {
    id: myId ?? ids[0]!,
    groupId: input.groupId,
    title: effectiveTitle,
    location: input.location ?? undefined,
    startsAt: input.startsAt,
    endsAt: input.endsAt ?? undefined,
    createdBy: input.createdBy,
    assigneePersonaId: input.assigneePersonaId ?? undefined,
    createdAt: now,
    sourceRawContext: input.sourceRawContext ?? undefined,
    description: resolvedDescription ?? undefined,
    externalUid: input.externalUid ?? undefined,
  };
}

/**
 * ADR 0328 — share a personal event with a group by MOVING it: the row (and
 * so the provider event, its guests and its video call) stays the same; it
 * now belongs to the group, and each other member is invited to it, or given
 * a copy when they cannot be. Not for a repeat or an assigned event; the
 * caller re-creates those as before (ADR 0232).
 */
export async function moveEventIntoGroup(
  db: Kysely<DB>,
  args: { eventId: string; targetGroupId: string; actorUserId: string },
): Promise<{ ok: true; eventId: string } | { ok: false; reason: 'not_found' | 'not_movable' }> {
  const row = await db.selectFrom('events').selectAll().where('id', '=', args.eventId).executeTakeFirst();
  if (!row || row.deleted_at) return { ok: false, reason: 'not_found' };
  if (row.owner_user_id !== args.actorUserId || row.series_id || row.assignee_persona_id) {
    return { ok: false, reason: 'not_movable' };
  }
  if (row.assignee_id && row.assignee_id !== args.actorUserId) return { ok: false, reason: 'not_movable' };

  const ical = row.ical_uid ?? newId('e');
  await db
    .updateTable('events')
    .set({
      group_id: args.targetGroupId,
      group_ids: JSON.stringify([args.targetGroupId]),
      ical_uid: ical,
      assignee_id: null,
      role: 'organizer',
      organizer_user_id: args.actorUserId,
    })
    .where('id', '=', row.id)
    .execute();

  const members = (await groupMemberIds(db, args.targetGroupId)).filter((m) => m !== args.actorUserId);
  if (members.length === 0) return { ok: true, eventId: row.id };

  const via = await organizerInviteVia(db, args.actorUserId, row.google_calendar_id);
  const own = await organizerAddress(db, args.actorUserId);
  const defaults = await db
    .selectFrom('users')
    .select(['id', 'default_calendar_id'])
    .where('id', 'in', members)
    .execute();
  const calOf = new Map(defaults.map((d) => [d.id, d.default_calendar_id ?? 'primary']));
  const now = new Date().toISOString();
  const rows: InsertObject<DB, 'events'>[] = [];
  const pushOwners: string[] = [];
  let anyInvited = false;
  for (const m of members) {
    const address = via ? await inviteAddressFor(db, m) : null;
    const invite = !!address && address !== own;
    const id = newId('e');
    rows.push({
      id,
      group_id: args.targetGroupId,
      title: row.title,
      description: row.description,
      location: row.location,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      created_by: row.created_by,
      created_at: now,
      source_raw_context: row.source_raw_context,
      transparency: row.transparency,
      owner_user_id: m,
      organizer_user_id: args.actorUserId,
      role: 'attendee',
      ical_uid: ical,
      chord_uid: invite ? null : id,
      group_ids: JSON.stringify([args.targetGroupId]),
      google_calendar_id: invite ? null : (calOf.get(m) ?? 'primary'),
      all_day: row.all_day,
      start_tz: row.start_tz,
      end_tz: row.end_tz,
      sequence: row.sequence,
      updated_at: now,
      status: 'confirmed',
      local_dirty: invite ? 0 : 1,
      ...(invite ? { invite_email: address, invite_via: via } : {}),
    });
    if (invite) anyInvited = true;
    else pushOwners.push(m);
  }
  await db.insertInto('events').values(rows).execute();
  for (const owner of pushOwners) firePush(db, owner, 'share', ical);
  if (anyInvited) {
    const started = runAfterCommit(
      db,
      (h) => startFamilyInvites(h, row.id),
      'family invites',
    );
    if (!started) {
      const { convertToCopies } = await import('./events/family-invites.js');
      await convertToCopies(
        db,
        rows.filter((r) => r.invite_email).map((r) => ({ id: r.id as string, owner_user_id: r.owner_user_id as string })),
      );
    }
  }
  return { ok: true, eventId: row.id };
}

/** ADR 0013 dedup lookup: returns an existing event matching (group, externalUid). */
export async function findEventByExternalUid(
  db: Kysely<DB>,
  groupId: string,
  externalUid: string,
): Promise<GroupEvent | null> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('external_uid', '=', externalUid)
    .executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

/**
 * An all-day event already in the group on `date` (YYYY-MM-DD) under the same
 * title, ignoring case and spacing. For a calendar file filed twice: ADR 0223's
 * same-event merge leaves all-day entries out, and a parsed school calendar
 * carries no key of its own. An all-day start is floating (ADR 0040), so its
 * first ten characters are its date in any zone.
 */
export async function findSameAllDayEvent(
  db: Kysely<DB>,
  groupId: string,
  title: string,
  date: string,
): Promise<GroupEvent | null> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('all_day', '=', 1)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`left(starts_at, 10) = ${date}`)
    .where(sql<boolean>`lower(regexp_replace(trim(title), '\\s+', ' ', 'g')) = ${normalizeText(title)}`)
    .executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

/**
 * Dedup lookup for the accepted-invite seam: a calendar invite accepted in
 * Google syncs in with `ical_uid` = the invite's RFC-5545 UID — the same UID
 * carried by the .ics in the invite EMAIL. A proposal staged from that email
 * (externalUid = the UID) must land on the existing synced row, not mint a
 * twin. Owner-scoped because the synced copy is an owner-scoped row whose
 * group may differ from the proposal's execution group.
 */
export async function findOwnedEventByIcalUid(
  db: Kysely<DB>,
  ownerUserId: string,
  icalUid: string,
): Promise<GroupEvent | null> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', ownerUserId)
    .where('ical_uid', '=', icalUid)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

/**
 * Fuzzy safety net for same-meeting twins that share no key (an LLM-extracted
 * event vs the same meeting created another way): same group, same title
 * (case-insensitive), starting within ±60 minutes. Narrow on purpose — a
 * weekly repeat is days away and never matches.
 */
export async function findSimilarEvent(
  db: Kysely<DB>,
  groupId: string,
  title: string,
  startsAt: string,
): Promise<GroupEvent | null> {
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return null;
  // Same ±60min window as before, pushed into the WHERE clause so this is an
  // index range scan instead of a full per-group event-history fetch.
  // `starts_at` is stored exactly as the caller supplied it (ADR 0074 — a
  // bare datetime gets a real offset, never normalized to UTC), so comparing
  // its raw text against a `.toISOString()` (`Z`) bound is not reliably
  // chronological — compare instants (ADR 0208: textInstant, which also
  // reads a malformed value as NULL instead of failing the whole query).
  const windowMs = 60 * 60 * 1000;
  const windowStart = new Date(t - windowMs).toISOString();
  const windowEnd = new Date(t + windowMs).toISOString();
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .where(sql<boolean>`lower(title) = ${title.trim().toLowerCase()}`)
    .where(sql<boolean>`${textInstant('events.starts_at')} >= ${windowStart}::timestamptz`)
    .where(sql<boolean>`${textInstant('events.starts_at')} <= ${windowEnd}::timestamptz`)
    .executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

/**
 * Dedup lookup for the create→push→sync round-trip: a Chord-created event is
 * pushed to Google (which stamps `gcal_event_id`), then the calendar sync pulls
 * it back. The pulled copy carries `external_uid = gcal:<id>`, but the original
 * row's external_uid is null, so an external_uid-only check misses it and the
 * sync inserts a duplicate. Match on the Google event id instead.
 */
export async function findEventByGcalId(
  db: Kysely<DB>,
  groupId: string,
  gcalEventId: string,
): Promise<GroupEvent | null> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('gcal_event_id', '=', gcalEventId)
    .executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

export async function getEvent(db: Kysely<DB>, id: string): Promise<GroupEvent | null> {
  const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToEvent(row) : null;
}

/**
 * Patch only the busyness flag on an existing row. Used by the Google sync to
 * heal rows synced before per-event transparency existed (migration 042
 * backfilled them to 'opaque'); the sync is otherwise insert-only and would
 * never override them. Scoped to transparency on purpose — title/time can be
 * edited Chord-side and pushed back, so we don't clobber them from Google.
 */
export async function setEventTransparency(
  db: Kysely<DB>,
  eventId: string,
  transparency: 'opaque' | 'transparent',
): Promise<void> {
  await db
    .updateTable('events')
    .set({ transparency })
    .where('id', '=', eventId)
    .execute();
}

export interface UpdateEventInput {
  title?: string;
  location?: string | null;
  startsAt?: string;
  endsAt?: string | null;
  description?: string | null;
  /** ADR 0297 — the IANA zone the times are in; sent to Google as `timeZone`. */
  timeZone?: string;
}

/**
 * ADR 0040 — edit an event's content. Bumps `sequence` (organizer copies only),
 * marks the row dirty, and pushes the change to Google via the two-way shell.
 * For a row synced before two-way support (no `gcal_event_id`) the Google
 * linkage is recovered from `external_uid` so the edit patches the existing
 * event instead of creating a duplicate.
 */
export async function updateEvent(
  db: Kysely<DB>,
  eventId: string,
  patch: UpdateEventInput,
): Promise<GroupEvent | null> {
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!row) return null;

  // ADR 0040 §9 — only an organizer-copy content edit propagates. The organizer
  // bumps `sequence`; every sibling (linked by ical_uid) inherits the new value
  // and the same content, then each pushes to its own owner's Google. An
  // attendee editing their own copy touches only that row (and shouldn't move
  // the meeting — that's enforced at the tool/route layer).
  // Fan out only when this is the organizer copy AND a shared ical_uid links
  // real siblings. A row with no ical_uid (legacy / pre-0040) has no siblings —
  // operate on it alone (a `WHERE ical_uid = NULL` would match nothing, not even
  // itself).
  const isOrganizer = row.role === 'organizer';
  const newSeq = nextSequenceOnLocalEdit({ role: 'organizer', sequence: row.sequence });
  const targets =
    isOrganizer && row.ical_uid
      ? await db.selectFrom('events').selectAll().where('ical_uid', '=', row.ical_uid).execute()
      : [row];

  const now = new Date().toISOString();
  // ADR 0328 — a change the event's guests are told about: when or where.
  const differs = (next: string | null | undefined, prev: string | null | undefined) =>
    next !== undefined && (next ?? null) !== (prev ?? null);
  const whenOrWhereChanged =
    differs(patch.startsAt, row.starts_at) ||
    differs(patch.endsAt, row.ends_at) ||
    differs(patch.location, row.location) ||
    differs(patch.timeZone, row.start_tz);
  // sequence is uniform across the batch: when this is the organizer's copy
  // every sibling inherits the same newSeq; the non-organizer branch always
  // has exactly one target (targets = [row]), so targets[0].sequence is just
  // that row's own value.
  const commonSet = {
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.location !== undefined ? { location: patch.location } : {}),
    ...(patch.startsAt !== undefined ? { starts_at: patch.startsAt } : {}),
    ...(patch.endsAt !== undefined ? { ends_at: patch.endsAt } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.timeZone !== undefined ? { start_tz: patch.timeZone, end_tz: patch.timeZone } : {}),
    sequence: isOrganizer ? newSeq : targets[0]!.sequence,
    updated_at: now,
    local_dirty: 1,
    gcal_sync_status: 'pending' as const,
    ...(isOrganizer && whenOrWhereChanged ? { guest_notice_due: 1 } : {}),
  };
  // An invited member's row follows the content but is never pushed: their
  // calendar hears about the change from the organizer (ADR 0328).
  const invitedSet = { ...commonSet, local_dirty: 0, guest_notice_due: 0 };
  const invitedIds = targets.filter((t) => t.invite_email).map((t) => t.id);
  // Most siblings share this exact SET clause and can be batched into one
  // UPDATE ... WHERE id IN (...); a pre-two-way row with no gcal_event_id yet
  // also needs its Google linkage recovered from external_uid, which differs
  // per row, so those stay one UPDATE each.
  const owners = new Set<string>();
  const plainIds: string[] = [];
  const linkedTargets: Array<{ id: string; link: { eventId: string; calendarId: string } }> = [];
  for (const t of targets) {
    if (invitedIds.includes(t.id)) continue;
    const link = t.gcal_event_id ? null : gcalLinkFromExternalUid(t.external_uid);
    if (link) linkedTargets.push({ id: t.id, link });
    else plainIds.push(t.id);
    const owner = ownerOf(t);
    if (owner) owners.add(owner);
  }
  if (plainIds.length > 0) {
    await db.updateTable('events').set(commonSet).where('id', 'in', plainIds).execute();
  }
  if (invitedIds.length > 0) {
    await db.updateTable('events').set(invitedSet).where('id', 'in', invitedIds).execute();
  }
  for (const { id, link } of linkedTargets) {
    await db
      .updateTable('events')
      .set({ ...commonSet, gcal_event_id: link.eventId, google_calendar_id: link.calendarId })
      .where('id', '=', id)
      .execute();
  }
  for (const owner of owners) firePush(db, owner, 'update', eventId);
  if (isOrganizer && whenOrWhereChanged && targets.some((t) => t.invite_via === 'mail' && t.id !== row.id)) {
    runAfterCommit(
      db,
      async (h) => {
        const { mailInvitationUpdate } = await import('./events/family-invites.js');
        await mailInvitationUpdate(h, row.id);
      },
      'family invite update',
    );
  }
  return getEvent(db, eventId);
}

/**
 * ADR 0040 — two-way delete. Tombstones the row, pushes the delete to Google
 * (shell does events.delete), then drops the local row. `reverseDeleteFromGoogle`
 * is set by the read sync when Google already removed the event — there's
 * nothing to push back, so it skips straight to the local drop.
 */
export async function deleteEvent(
  db: Kysely<DB>,
  eventId: string,
  opts?: { reverseDeleteFromGoogle?: boolean },
): Promise<Array<{ id: string; ownerUserId: string | null }>> {
  if (opts?.reverseDeleteFromGoogle) {
    const gone = await db
      .selectFrom('events')
      .select(['owner_user_id', 'source_raw_context', 'starts_at', 'ends_at'])
      .where('id', '=', eventId)
      .executeTakeFirst();
    await db.deleteFrom('events').where('id', '=', eventId).execute();
    if (gone) await retireTasksForRemovedEvents(db, [gone]);
    return [{ id: eventId, ownerUserId: null }];
  }

  // ADR 0217 — deleting one occurrence of a series excludes it from the rule;
  // a plain delete would let the next top-up write it back, and Google would
  // keep it on the master.
  const occurrence = await db
    .selectFrom('events')
    .selectAll()
    .where('id', '=', eventId)
    .where('series_id', 'is not', null)
    .executeTakeFirst();
  if (occurrence) return deleteOccurrence(db, occurrence);

  const row = await db
    .selectFrom('events')
    .select([
      'id',
      'role',
      'ical_uid',
      'owner_user_id',
      'assignee_id',
      'created_by',
      'gcal_event_id',
      'external_uid',
      'source_raw_context',
      'starts_at',
      'ends_at',
      'invite_email',
      'invite_via',
    ])
    .where('id', '=', eventId)
    .executeTakeFirst();
  if (!row) return [];

  // ADR 0040 §9 — an organizer delete removes every copy (each owner's Google
  // delete pushes under their token); an attendee delete removes only their own
  // copy (the meeting persists for the others).
  // See updateEvent: only fan the delete across siblings when a shared ical_uid
  // links them; a null-ical_uid legacy row is deleted on its own.
  const targets =
    row.role === 'organizer' && row.ical_uid
      ? await db
          .selectFrom('events')
          .select([
            'id',
            'owner_user_id',
            'assignee_id',
            'created_by',
            'gcal_event_id',
            'external_uid',
            'source_raw_context',
            'starts_at',
            'ends_at',
            'invite_email',
            'invite_via',
          ])
          .where('ical_uid', '=', row.ical_uid)
          .execute()
      : [row];

  // ADR 0328 — invited members' rows are never pushed: the organizer's delete
  // cancels the invitation on their calendars. One mailed by Chord needs a
  // mailed cancellation, built from the event before it is gone.
  const invitedIds = new Set(targets.filter((t) => t.invite_email).map((t) => t.id));
  const mailedTo = targets
    .filter((t) => t.invite_via === 'mail' && t.invite_email && t.id !== row.id)
    .map((t) => ({ email: t.invite_email! }));
  const cancelOf =
    row.role === 'organizer' && mailedTo.length > 0
      ? await db.selectFrom('events').selectAll().where('id', '=', row.id).executeTakeFirst()
      : undefined;

  const now = new Date().toISOString();
  // Recover the Google linkage for pre-two-way rows so the delete propagates
  // (the old one-way path silently dropped these and the next sync re-added
  // them). Rows needing that per-row linkage patch stay one UPDATE each; the
  // rest share one batched tombstone UPDATE.
  const plainIds: string[] = [];
  const linkedTargets: Array<{ id: string; link: { eventId: string; calendarId: string } }> = [];
  for (const t of targets) {
    const link = t.gcal_event_id ? null : gcalLinkFromExternalUid(t.external_uid);
    if (link) linkedTargets.push({ id: t.id, link });
    else plainIds.push(t.id);
  }
  if (plainIds.length > 0) {
    await db
      .updateTable('events')
      .set({ status: 'cancelled', deleted_at: now, local_dirty: 1 })
      .where('id', 'in', plainIds)
      .execute();
  }
  for (const { id, link } of linkedTargets) {
    await db
      .updateTable('events')
      .set({
        status: 'cancelled',
        deleted_at: now,
        local_dirty: 1,
        gcal_event_id: link.eventId,
        google_calendar_id: link.calendarId,
      })
      .where('id', '=', id)
      .execute();
  }
  if (invitedIds.size > 0) {
    await db.updateTable('events').set({ local_dirty: 0 }).where('id', 'in', [...invitedIds]).execute();
  }

  // Push the delete to Google (best-effort; no-op without write scope), one
  // owner at a time is a real Google Calendar round trip — different owners
  // are different Google accounts, so they run independently instead of one
  // at a time (mapConcurrent pattern established in gmail.service.ts).
  const owners = [
    ...new Set(
      targets
        .filter((t) => !invitedIds.has(t.id))
        .map(ownerOf)
        .filter((o): o is string => !!o),
    ),
  ];
  await mapConcurrent(owners, 5, async (owner) => {
    try {
      await pushDirtyEvents(db, owner);
    } catch (err) {
      logger.warn('two-way push (delete) failed', { err: String(err), eventId });
    }
  });

  // Unconditional: on success the shell already dropped each row; this
  // guarantees local removal regardless of Google's reachability.
  await db
    .deleteFrom('events')
    .where(
      'id',
      'in',
      targets.map((t) => t.id),
    )
    .execute();
  // ADR 0192 — the to-dos this event's email produced were for it.
  await retireTasksForRemovedEvents(db, targets);
  if (cancelOf) {
    const snapshot = { ...cancelOf, sequence: (cancelOf.sequence ?? 0) + 1 };
    runAfterCommit(
      db,
      async (h) => {
        const { mailInvitation } = await import('./events/family-invites.js');
        const r = await mailInvitation(h, snapshot, mailedTo, 'CANCEL');
        if (r !== 'sent') logger.warn('family invites: cancellation not mailed', { eventId, result: r });
      },
      'family invite cancel',
    );
  }
  return targets.map((t) => ({ id: t.id, ownerUserId: t.owner_user_id ?? null }));
}

/**
 * Bulk RSVP fetch across every group the user is a member of. Replaces the
 * per-event fan-out the resources screen was doing for clients with thousands
 * of imported events.
 */
export async function listAllRsvpsForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<Rsvp[]> {
  const rows = await db
    .selectFrom('rsvps')
    .innerJoin('events', 'events.id', 'rsvps.event_id')
    .innerJoin('group_members', 'group_members.group_id', 'events.group_id')
    .where('group_members.user_id', '=', userId)
    .selectAll('rsvps')
    .orderBy('rsvps.updated_at', 'desc')
    .limit(200)
    .execute();
  return rows.map(rowToRsvp);
}

export async function listRsvps(db: Kysely<DB>, eventId: string): Promise<Rsvp[]> {
  const rows = await db
    .selectFrom('rsvps')
    .selectAll()
    .where('event_id', '=', eventId)
    .orderBy('display_name', 'asc')
    .execute();
  return rows.map(rowToRsvp);
}

/**
 * Batch variant of `listRsvps` for many events at once — avoids the N+1
 * (one query per event) in the bot context's events block. Returns a map
 * keyed by event id; events with no RSVPs are simply absent.
 */
export async function listRsvpsForEvents(
  db: Kysely<DB>,
  eventIds: string[],
): Promise<Map<string, Rsvp[]>> {
  const byEvent = new Map<string, Rsvp[]>();
  if (eventIds.length === 0) return byEvent;
  const rows = await db
    .selectFrom('rsvps')
    .selectAll()
    .where('event_id', 'in', eventIds)
    .orderBy('display_name', 'asc')
    .execute();
  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? [];
    list.push(rowToRsvp(row));
    byEvent.set(row.event_id, list);
  }
  return byEvent;
}

export interface UpsertRsvpInput {
  eventId: string;
  userId?: string;
  displayName: string;
  status: Rsvp['status'];
  solo?: boolean;
  dish?: string;
  notes?: string;
}

/**
 * Auto-RSVP the event creator as "yes". Called immediately after createEvent
 * when a real user (not an import) creates the event, since the assumption is
 * they're going unless they say otherwise.
 */
export async function autoRsvpCreator(
  db: Kysely<DB>,
  eventId: string,
  userId: string,
): Promise<Rsvp | null> {
  const u = await db
    .selectFrom('users')
    .select(['display_name', 'username'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!u) return null;
  return upsertRsvp(db, {
    eventId,
    userId,
    displayName: u.display_name ?? u.username,
    status: 'yes',
  });
}

/** Upsert by (eventId, displayName) so natural-language replies always land on the right row. */
export async function upsertRsvp(db: Kysely<DB>, input: UpsertRsvpInput): Promise<Rsvp> {
  const existing = await db
    .selectFrom('rsvps')
    .selectAll()
    .where('event_id', '=', input.eventId)
    .where('display_name', '=', input.displayName)
    .executeTakeFirst();

  const now = new Date().toISOString();
  if (existing) {
    await db
      .updateTable('rsvps')
      .set({
        user_id: input.userId ?? existing.user_id,
        status: input.status,
        solo: input.solo === undefined ? existing.solo : input.solo ? 1 : 0,
        dish: input.dish ?? existing.dish,
        notes: input.notes ?? existing.notes,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .execute();
    const row = await db
      .selectFrom('rsvps')
      .selectAll()
      .where('id', '=', existing.id)
      .executeTakeFirstOrThrow();
    return rowToRsvp(row);
  }

  const row: RsvpsTable = {
    id: newId('r'),
    event_id: input.eventId,
    user_id: input.userId ?? null,
    display_name: input.displayName,
    status: input.status,
    solo: input.solo ? 1 : 0,
    dish: input.dish ?? null,
    notes: input.notes ?? null,
    updated_at: now,
  };
  await db.insertInto('rsvps').values(row).execute();
  return rowToRsvp(row);
}

