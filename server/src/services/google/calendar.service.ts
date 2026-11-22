/**
 * Google Calendar read (ADR 0015 read half).
 *
 * Reads every calendar in the user's Google account (their primary +
 * any secondary/shared calendars they have at least reader access to)
 * via the Calendar v3 REST API and upserts events into the user's
 * *personal* group in Chord, tagged with an `external_uid` of:
 *   - `gcal:<event-id>`               for the primary calendar
 *   - `gcal:<calendarId>:<event-id>`  for every other calendar
 *
 * The `(group_id, external_uid)` unique index handles dedup so re-runs
 * are idempotent. The primary-calendar uid stays bare for backwards
 * compatibility with rows synced before multi-calendar support landed.
 *
 * Range: -7d → +365d. Past week is included so "what did we do last
 * weekend" questions still surface. The forward year bounds the fetch
 * while covering annual/far-future events for delete reconciliation.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { upsertCalendarSource } from '../calendar-sources.service.js';
import {
  createEvent,
  deleteEvent,
  findEventByExternalUid,
  findEventByGcalId,
  setEventTransparency,
} from '../events.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { outlookCalendarAccounts } from '../outlook-calendar/enabled.js';
import { gmailCalendarAccounts } from '../gmail-calendar/enabled.js';
import { hasCalendarScope } from './calendar-write.service.js';
import { getAccessToken } from './oauth.service.js';
import { syncTwoWay } from './two-way-sync.service.js';

// Matches the device pull's past window (ADR 0072): a Google-account calendar
// is excluded from the device mirror, so anything the device would have
// covered must come from here — a narrower past window left 8–30-day-old
// events invisible via either path.
const PAST_DAYS = 30;
// Default forward window. Kept modest to bound fetch cost; callers widen it on
// demand (up to MAX_FUTURE_DAYS) when the user navigates further out.
export const DEFAULT_FUTURE_DAYS = 90;
const MAX_FUTURE_DAYS = 730;
const EXTERNAL_UID_PREFIX = 'gcal:';

interface GcalDateTime {
  /** RFC3339 datetime when the event has a time component. */
  dateTime?: string;
  /** YYYY-MM-DD when it's an all-day event. */
  date?: string;
  timeZone?: string;
}

interface GcalEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  location?: string;
  start?: GcalDateTime;
  end?: GcalDateTime;
  recurringEventId?: string;
  /** ADR 0033: 'opaque' (default) blocks time; 'transparent' is informational. */
  transparency?: 'opaque' | 'transparent';
}

interface GcalEventsListResponse {
  items?: GcalEvent[];
  nextPageToken?: string;
  defaultReminders?: unknown;
}

function toIsoStart(start: GcalDateTime | undefined): string | null {
  if (!start) return null;
  if (start.dateTime) return start.dateTime;
  if (start.date) {
    // All-day event — a *floating* date, not an instant. Store local-midnight
    // with NO `Z`/offset so every client buckets it on the calendar date the
    // user picked, regardless of their timezone. Appending `Z` (UTC midnight)
    // shifts the event to the previous day for any negative-offset viewer.
    return `${start.date}T00:00:00`;
  }
  return null;
}

function toIsoEnd(end: GcalDateTime | undefined): string | null {
  if (!end) return null;
  if (end.dateTime) return end.dateTime;
  if (end.date) return `${end.date}T00:00:00`;
  return null;
}

interface GcalCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  /** 'none' | 'freeBusyReader' | 'reader' | 'writer' | 'owner' */
  accessRole?: string;
  /** Hex color of the calendar in the user's list, e.g. "#f83a22". */
  backgroundColor?: string;
}

interface GcalCalendarListResponse {
  items?: GcalCalendarListEntry[];
  nextPageToken?: string;
}

async function fetchCalendarList(
  accessToken: string,
): Promise<GcalCalendarListEntry[]> {
  const out: GcalCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
    );
    url.searchParams.set('maxResults', '250');
    // showHidden=false (default): respect the user's hidden-from-list
    // choice. They likely don't want those events anyway.
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `gcal calendarList.list ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as GcalCalendarListResponse;
    for (const item of json.items ?? []) out.push(item);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

async function fetchEventsForCalendar(
  accessToken: string,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<GcalEvent[]> {
  const out: GcalEvent[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `gcal events.list (${calendarId}) ${res.status}: ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as GcalEventsListResponse;
    for (const item of json.items ?? []) out.push(item);
    pageToken = json.nextPageToken;
  } while (pageToken);
  return out;
}

export interface SyncResult {
  fetched: number;
  inserted: number;
  skippedExisting: number;
  /** Existing rows whose transparency was patched to match Google this run. */
  updatedTransparency: number;
  skippedCancelled: number;
  /** Rows removed because Google no longer returns them (deleted/cancelled). */
  deleted: number;
  calendars: number;
}

// A Google-created event can take a moment to appear in events.list across
// replicas. A Chord-created row we pushed seconds ago could therefore be
// absent from the very next sync — don't reverse-delete anything synced within
// this grace window, or we'd race-delete a brand-new event.
const REVERSE_DELETE_GRACE_MS = 2 * 60 * 1000;

/** Parse a `gcal:` external_uid into its calendar id (null for the primary,
 *  which has no embedded id) and the Google event id. */
function parseGcalUid(externalUid: string): { calId: string | null; eventId: string } {
  const rest = externalUid.slice(EXTERNAL_UID_PREFIX.length);
  const sep = rest.indexOf(':');
  return sep === -1
    ? { calId: null, eventId: rest }
    : { calId: rest.slice(0, sep), eventId: rest.slice(sep + 1) };
}

/** The Google event id a local row is linked to — from its external_uid
 *  (`gcal:<id>` or `gcal:<calId>:<id>`) or, for a Chord-pushed row, its
 *  `gcal_event_id`. Null when the row has no Google linkage. */
function rowGcalEventId(row: {
  external_uid: string | null;
  gcal_event_id: string | null;
}): string | null {
  if (row.external_uid && row.external_uid.startsWith(EXTERNAL_UID_PREFIX)) {
    return parseGcalUid(row.external_uid).eventId;
  }
  return row.gcal_event_id ?? null;
}

/**
 * Decide whether a Google-linked local row should be deleted because Google no
 * longer returns it. `seenGcalIds` is the union of live event ids across EVERY
 * calendar fetched this run, so an event present on any calendar counts as
 * still-on-Google. Scoped to the fetched window (we can't judge events we
 * didn't query) and guarded against the just-pushed propagation race
 * (REVERSE_DELETE_GRACE_MS). Pure so these cases are unit-tested without Google.
 */
export function shouldReverseDelete(
  row: {
    external_uid: string | null;
    gcal_event_id: string | null;
    starts_at: string;
    gcal_synced_at: string | null;
  },
  seenGcalIds: Set<string>,
  win: { windowStartMs: number; windowEndMs: number; runStartMs: number },
): boolean {
  const gid = rowGcalEventId(row);
  if (!gid || seenGcalIds.has(gid)) return false;
  const startMs = new Date(row.starts_at).getTime();
  if (Number.isNaN(startMs) || startMs < win.windowStartMs || startMs > win.windowEndMs) {
    return false;
  }
  // Only a freshly-pushed event (recent gcal_synced_at) gets the grace; a
  // Google-origin row (gcal_synced_at null) reconciles immediately.
  const syncedMs = row.gcal_synced_at ? new Date(row.gcal_synced_at).getTime() : 0;
  return syncedMs < win.runStartMs - REVERSE_DELETE_GRACE_MS;
}

/**
 * Pull -7d..+`futureDays` (default 90) from every Google calendar the user has
 * at least reader access to (primary + secondaries + shared) and upsert into
 * Chord's personal group for that user. Idempotent on
 * (personalGroup, external_uid). Reconciles deletes: a row previously sourced
 * from a calendar that Google no longer returns (hard-deleted or cancelled) is
 * removed locally, scoped to the fetched window and guarded against the
 * just-pushed-event race (see REVERSE_DELETE_GRACE_MS). Because the sweep is
 * window-scoped, a wider `futureDays` also reconciles deletes further out.
 *
 * Calendars with `accessRole=freeBusyReader` are skipped: those expose
 * busy/free blocks only, no titles, so they're not useful to Chord.
 */
export async function syncPrimaryCalendar(
  db: Kysely<DB>,
  userId: string,
  futureDays: number = DEFAULT_FUTURE_DAYS,
): Promise<SyncResult> {
  const accessToken = await getAccessToken(db, userId);
  const personalGroup = await ensurePersonalGroup(db, userId);

  const horizon = Math.min(Math.max(Math.trunc(futureDays), 1), MAX_FUTURE_DAYS);
  const now = new Date();
  const timeMin = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString();
  const timeMax = new Date(now.getTime() + horizon * 86_400_000).toISOString();

  const calendars = await fetchCalendarList(accessToken);
  const readableCalendars = calendars.filter(
    (c) =>
      c.accessRole === 'reader' ||
      c.accessRole === 'writer' ||
      c.accessRole === 'owner',
  );
  const result: SyncResult = {
    fetched: 0,
    inserted: 0,
    skippedExisting: 0,
    updatedTransparency: 0,
    skippedCancelled: 0,
    deleted: 0,
    calendars: readableCalendars.length,
  };
  const runStart = now.getTime();
  const windowStartMs = new Date(timeMin).getTime();
  const windowEndMs = new Date(timeMax).getTime();

  // Every locally-stored event that was sourced from (or pushed to) a Google
  // calendar — the candidates for reverse-delete reconciliation. Fetched once;
  // matched per-calendar inside the loop below.
  const sourcedRows = await db
    .selectFrom('events')
    .select(['id', 'external_uid', 'gcal_event_id', 'starts_at', 'gcal_synced_at', 'title'])
    .where('group_id', '=', personalGroup.id)
    .where((eb) =>
      eb.or([
        eb('external_uid', 'like', `${EXTERNAL_UID_PREFIX}%`),
        eb('gcal_event_id', 'is not', null),
      ]),
    )
    .execute();
  const allSeenGcalIds = new Set<string>();
  let anyFetchFailed = false;

  // ADR 0033: refresh calendar_sources before iterating so the busyness
  // policy reflects the user's current calendar list. Look up the
  // Chord-target calendar id once for the auto-pick rule.
  const userRow = await db
    .selectFrom('users')
    .select('google_calendar_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  const chordTargetId = userRow?.google_calendar_id ?? null;
  for (const cal of readableCalendars) {
    await upsertCalendarSource(db, userId, {
      googleCalendarId: cal.id,
      summary: cal.summary ?? null,
      color: cal.backgroundColor ?? null,
      accessRole: cal.accessRole as 'reader' | 'writer' | 'owner',
      isPrimary: !!cal.primary,
      selectedInGoogle: cal.selected !== false,
      isChordTarget: chordTargetId !== null && cal.id === chordTargetId,
    });
  }

  for (const cal of readableCalendars) {
    let items: GcalEvent[];
    try {
      items = await fetchEventsForCalendar(accessToken, cal.id, timeMin, timeMax);
    } catch (err) {
      // One calendar's failure (e.g. transient 5xx, revoked share) must
      // not abort the rest. Log and move on — but mark the run incomplete so
      // we don't reverse-delete events that might live on this calendar.
      anyFetchFailed = true;
      logger.warn(
        `gcal sync: skipping calendar ${cal.id} (${cal.summary ?? ''}): ${(err as Error).message}`,
      );
      continue;
    }
    result.fetched += items.length;
    for (const it of items) {
      if (it.status !== 'cancelled' && it.id) allSeenGcalIds.add(it.id);
    }

    for (const item of items) {
      if (item.status === 'cancelled') {
        result.skippedCancelled++;
        continue;
      }
      const startsAt = toIsoStart(item.start);
      if (!startsAt) continue;
      const endsAt = toIsoEnd(item.end) ?? undefined;
      // Keep the bare prefix for the primary calendar so rows synced
      // before multi-calendar support stay idempotent. Secondary
      // calendars get their id embedded so a Google event id reused
      // across two calendars can't collide.
      const externalUid = cal.primary
        ? `${EXTERNAL_UID_PREFIX}${item.id}`
        : `${EXTERNAL_UID_PREFIX}${cal.id}:${item.id}`;
      // Two dedup keys: external_uid covers rows previously synced from
      // Google; gcal_event_id covers a Chord-created row that was pushed to
      // Google and is now coming back (its external_uid is still null, so the
      // external_uid check alone would miss it and insert a duplicate).
      const existing =
        (await findEventByExternalUid(db, personalGroup.id, externalUid)) ??
        (item.id ? await findEventByGcalId(db, personalGroup.id, item.id) : null);
      const transparency = item.transparency === 'transparent' ? 'transparent' : 'opaque';
      if (existing) {
        result.skippedExisting++;
        // Sync is otherwise insert-only; heal the busyness flag on rows that
        // predate per-event transparency (migration 042 backfilled 'opaque')
        // or whose Google "show me as free" setting changed since last sync.
        if (existing.transparency !== transparency) {
          await setEventTransparency(db, existing.id, transparency);
          result.updatedTransparency++;
        }
        continue;
      }
      await createEvent(db, {
        groupId: personalGroup.id,
        title: item.summary?.trim() || '(untitled)',
        location: item.location ?? undefined,
        startsAt,
        endsAt,
        createdBy: userId,
        externalUid,
        transparency,
      });
      result.inserted++;
    }

  }

  // Reverse-delete sweep: any Google-linked local row in the fetched window
  // that no calendar returned this run was deleted on Google's side. Skipped
  // when a fetch failed — incomplete data must not trigger deletes for events
  // that may live on the calendar we couldn't read.
  if (!anyFetchFailed) {
    const win = { windowStartMs, windowEndMs, runStartMs: runStart };
    for (const row of sourcedRows) {
      if (!shouldReverseDelete(row, allSeenGcalIds, win)) continue;
      // Google already removed it — drop locally only, don't push a delete back.
      await deleteEvent(db, row.id, { reverseDeleteFromGoogle: true });
      result.deleted++;
      logger.info(`gcal sync: reverse-deleted "${row.title}" (${row.id}) — no longer on Google`);
    }
  }

  await db
    .updateTable('users')
    .set({ google_calendar_synced_at: new Date().toISOString() })
    .where('id', '=', userId)
    .execute();

  logger.info(
    `gcal sync user=${userId} calendars=${result.calendars} fetched=${result.fetched} inserted=${result.inserted} existing=${result.skippedExisting} retransp=${result.updatedTransparency} cancelled=${result.skippedCancelled} deleted=${result.deleted}`,
  );
  return result;
}

/**
 * Throttled best-effort sync. Used by bot tool callers (find_events,
 * create_event) and `/me/events` so the LLM/UI work against fresh data without
 * hammering Google. No-op when no calendar scope is granted or the last
 * successful sync was within `windowMs`.
 *
 * ADR 0040 — now runs the two-way reconcile (`syncTwoWay`: push local edits,
 * discover calendars, pull changes) instead of the legacy one-way read
 * `syncPrimaryCalendar`. `futureDays` is no longer used: the pull is syncToken-
 * incremental with a fixed initial window; deep-future navigation is a follow-up.
 */
const SYNC_THROTTLE_MS = 5 * 60 * 1000;

export async function maybeSyncCalendar(
  db: Kysely<DB>,
  userId: string,
  windowMs: number = SYNC_THROTTLE_MS,
  _futureDays: number = DEFAULT_FUTURE_DAYS,
): Promise<void> {
  try {
    if (!(await hasAnyCalendar(db, userId))) return;
    const row = await db
      .selectFrom('users')
      .select('google_calendar_synced_at')
      .where('id', '=', userId)
      .executeTakeFirst();
    const last = row?.google_calendar_synced_at
      ? Date.parse(row.google_calendar_synced_at)
      : 0;
    if (Date.now() - last < windowMs) return;
    await syncTwoWay(db, userId);
  } catch (err) {
    // Sync is opportunistic; never throw into the caller. The bot tool
    // can still answer against the stale local copy.
    logger.warn('maybeSyncCalendar failed', { userId, err: (err as Error).message });
  }
}

export { hasCalendarScope };

/** Is any calendar connected that a sync pass could work on — Google, an
 *  Outlook mailbox that carries a calendar (ADR 0228), or an attached Gmail
 *  that does (ADR 0313)? */
export async function hasAnyCalendar(db: Kysely<DB>, userId: string): Promise<boolean> {
  if (await hasCalendarScope(db, userId)) return true;
  if ((await outlookCalendarAccounts(db, userId)).length > 0) return true;
  return (await gmailCalendarAccounts(db, userId)).length > 0;
}
