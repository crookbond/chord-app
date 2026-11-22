/**
 * ADR 0217 — repeating events.
 *
 * A series row holds the rule; each occurrence is an ordinary `events` row
 * with `series_id`, so every reader (calendar, briefing, conflicts, search)
 * sees occurrences without knowing series exist. Occurrences are written
 * ahead to the same horizon the Google pull covers and topped up as time
 * passes.
 *
 * Each occurrence has its own `ical_uid` (`<series_uid>:<local start>`),
 * shared only by the family members' copies of that one occurrence:
 * `updateEvent`/`deleteEvent` fan out by `ical_uid`, and a uid shared by the
 * whole series would make "move this Wednesday" move every Wednesday.
 */
import type { Insertable, Kysely, Selectable } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB, EventSeriesTable, EventsTable } from '../../db/schema.js';
import { instantMs } from '../../db/text-instant.js';
import { newId } from '../../utils/ids.js';
import { instantInZoneMs, svWall } from '../../utils/tz.js';
import { pushDirtyEvents } from '../google/two-way-sync.service.js';
import { retireTasksForRemovedEvents } from './retire-event-tasks.js';
import { occurrenceUid } from './series-sync.js';
import { runAfterCommit } from '../../db/after-commit.js';
import {
  addWallMinutes,
  expandLocal,
  localWallOf,
  parseRrule,
  storedStart,
  WEEKDAYS,
} from './recurrence.js';

/** Occurrences exist this far ahead; matches the Google pull's window. */
export const SERIES_HORIZON_DAYS = 365;
/** Top a series up once it has less than this much left. */
const TOP_UP_MARGIN_DAYS = 30;

type SeriesRow = Selectable<EventSeriesTable>;
type EventRow = Selectable<EventsTable>;


/** Today's date in `tz`, plus `days`. */
function localDate(tz: string, days = 0): string {
  const today = svWall(new Date(), tz).slice(0, 10);
  const ms = Date.parse(`${today}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Minutes between a series' start and end, as wall clock (null = no end). */
function durationMinutes(s: { starts_at: string; ends_at: string | null; all_day: number; tz: string }): number | null {
  if (!s.ends_at) return null;
  const a = Date.parse(`${localWallOf(s.starts_at, s.tz)}Z`);
  const b = Date.parse(`${localWallOf(s.ends_at, s.tz)}Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 60_000) : null;
}

function storedEnd(local: string, minutes: number | null, tz: string, allDay: boolean): string | null {
  if (minutes === null) return null;
  return storedStart(addWallMinutes(local, minutes), tz, allDay);
}

function firePush(db: Kysely<DB>, owners: Iterable<string | null | undefined>, op: string): void {
  for (const owner of new Set(owners)) {
    if (!owner) continue;
    // ADR 0313 addendum: never on a transaction; it waits for the commit.
    runAfterCommit(
      db,
      (h) =>
        pushDirtyEvents(h, owner).then(
          () => undefined,
          (err) => {
            logger.warn(`two-way push (series ${op}) failed`, { err: String(err) });
          },
        ),
      `two-way push (series ${op})`,
    );
  }
}

/** The zone a user's rule runs in: the turn's, else their last known, else
 *  the deploy default (ADR 0098). */
export async function seriesZoneFor(
  db: Kysely<DB>,
  userId: string | null,
  turnTz?: string | null,
): Promise<string> {
  if (turnTz) return turnTz;
  if (userId) {
    const u = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
    if (u?.last_tz) return u.last_tz;
  }
  return env.BRIEFING_DEFAULT_TZ;
}

/**
 * Write the occurrences a series should have up to `toDate` that it does not
 * have yet. Existing rows (edited or not) are left alone, and excluded dates
 * are never written.
 */
export async function materializeSeries(
  db: Kysely<DB>,
  series: SeriesRow,
  opts: { fromDate?: string; toDate?: string } = {},
): Promise<number> {
  const allDay = series.all_day === 1;
  const firstLocal = localWallOf(series.starts_at, series.tz);
  const toDate = opts.toDate ?? localDate(series.tz, SERIES_HORIZON_DAYS);
  const fromDate = opts.fromDate ?? firstLocal.slice(0, 10);
  const locals = expandLocal({
    firstLocal,
    rrule: series.rrule,
    exdates: series.exdates,
    fromDate,
    toDate,
  });
  const have = await db
    .selectFrom('events')
    .select('original_start')
    .where('series_id', '=', series.id)
    .execute();
  const haveMs = new Set(have.map((r) => instantMs(r.original_start)));
  const minutes = durationMinutes(series);
  const now = new Date().toISOString();
  const rows: Insertable<EventsTable>[] = [];
  for (const local of locals) {
    const start = storedStart(local, series.tz, allDay);
    if (haveMs.has(instantMs(start))) continue;
    rows.push({
      id: newId('e'),
      group_id: series.group_id,
      group_ids: JSON.stringify(series.group_ids),
      title: series.title,
      description: series.description ?? null,
      location: series.location ?? null,
      starts_at: start,
      ends_at: storedEnd(local, minutes, series.tz, allDay),
      all_day: series.all_day,
      transparency: series.transparency,
      created_by: series.created_by,
      created_at: now,
      updated_at: now,
      source_raw_context: series.source_raw_context ?? null,
      assignee_id: series.assignee_id ?? null,
      assignee_persona_id: series.assignee_persona_id ?? null,
      owner_user_id: series.owner_user_id,
      organizer_user_id: series.organizer_user_id ?? null,
      role: series.role,
      ical_uid: occurrenceUid(series.series_uid, local),
      chord_uid: null,
      google_calendar_id: series.google_calendar_id ?? null,
      recurring_event_id: series.gcal_event_id ?? null,
      original_start: start,
      series_id: series.id,
      status: 'confirmed',
      // Google expands the master itself; an occurrence is never pushed on its
      // own until the pull has adopted Google's instance for it.
      local_dirty: 0,
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db.insertInto('events').values(rows.slice(i, i + 200)).execute();
  }
  await db
    .updateTable('event_series')
    .set({ materialized_until: toDate })
    .where('id', '=', series.id)
    .execute();
  return rows.length;
}

/**
 * Turn the per-owner copies `createEvent` built into series (one per owner,
 * sharing `series_uid`) and write their occurrences. The series starts on
 * the first date the rule actually produces, so Chord and Google agree on the
 * first occurrence (Google always counts the start itself).
 */
export async function createSeriesFromCopies(
  db: Kysely<DB>,
  copies: Insertable<EventsTable>[],
  repeat: { rrule: string; tz: string },
): Promise<SeriesRow[]> {
  const first = copies[0]!;
  const allDay = first.all_day === 1;
  const requestedLocal = localWallOf(first.starts_at, repeat.tz);
  const firstLocal =
    expandLocal({
      firstLocal: requestedLocal,
      rrule: repeat.rrule,
      fromDate: requestedLocal.slice(0, 10),
      toDate: localDate(repeat.tz, SERIES_HORIZON_DAYS + 400),
      cap: 1,
    })[0] ?? requestedLocal;
  const minutes = first.ends_at
    ? Math.round(
        (Date.parse(`${localWallOf(first.ends_at, repeat.tz)}Z`) - Date.parse(`${requestedLocal}Z`)) / 60_000,
      )
    : null;
  const startsAt = storedStart(firstLocal, repeat.tz, allDay);
  const endsAt = storedEnd(firstLocal, minutes, repeat.tz, allDay);
  const seriesUid = newId('es');
  const now = new Date().toISOString();
  const out: SeriesRow[] = [];
  for (const c of copies) {
    const row: Insertable<EventSeriesTable> = {
      id: newId('es'),
      series_uid: seriesUid,
      group_id: c.group_id,
      group_ids: typeof c.group_ids === 'string' ? c.group_ids : JSON.stringify(c.group_ids ?? []),
      owner_user_id: c.owner_user_id ?? null,
      organizer_user_id: c.organizer_user_id ?? null,
      role: (c.role as 'organizer' | 'attendee' | undefined) ?? 'organizer',
      created_by: c.created_by ?? null,
      assignee_id: c.assignee_id ?? null,
      assignee_persona_id: c.assignee_persona_id ?? null,
      title: c.title,
      description: c.description ?? null,
      location: c.location ?? null,
      starts_at: startsAt,
      ends_at: endsAt,
      all_day: c.all_day ?? 0,
      transparency: (c.transparency as 'opaque' | 'transparent' | undefined) ?? 'opaque',
      tz: repeat.tz,
      rrule: repeat.rrule,
      exdates: '[]',
      source_raw_context: c.source_raw_context ?? null,
      google_calendar_id: c.google_calendar_id ?? null,
      chord_uid: null,
      local_dirty: 1,
      created_at: now,
      updated_at: now,
    };
    const inserted = await db.insertInto('event_series').values(row).returningAll().executeTakeFirstOrThrow();
    await materializeSeries(db, inserted);
    out.push(inserted);
  }
  return out;
}

/** The first occurrence of a series, as a row. */
export async function firstOccurrence(db: Kysely<DB>, seriesId: string): Promise<EventRow | undefined> {
  const rows = await db.selectFrom('events').selectAll().where('series_id', '=', seriesId).execute();
  return rows.sort((a, b) => instantMs(a.starts_at) - instantMs(b.starts_at))[0];
}

export async function getSeries(db: Kysely<DB>, seriesId: string): Promise<SeriesRow | undefined> {
  return db.selectFrom('event_series').selectAll().where('id', '=', seriesId).executeTakeFirst();
}

/** Every family member's copy of this series (only an organizer edit or
 *  delete reaches the others, as with one-off events, ADR 0040 §9). */
async function siblingSeries(db: Kysely<DB>, series: SeriesRow): Promise<SeriesRow[]> {
  if (series.role !== 'organizer') return [series];
  return db
    .selectFrom('event_series')
    .selectAll()
    .where('series_uid', '=', series.series_uid)
    .where('deleted_at', 'is', null)
    .execute();
}

/**
 * Make an existing one-off event repeat, in place — every family member's
 * copy of it. The event becomes the first occurrence; if it is already on
 * Google, that Google event becomes the series master (the push patches the
 * rule onto it), so nothing is created twice.
 */
export async function convertEventToSeries(
  db: Kysely<DB>,
  event: EventRow,
  repeat: { rrule: string; tz: string },
): Promise<SeriesRow> {
  const copies =
    event.role === 'organizer' && event.ical_uid
      ? await db.selectFrom('events').selectAll().where('ical_uid', '=', event.ical_uid).execute()
      : [event];
  const seriesUid = newId('es');
  const now = new Date().toISOString();
  let mine: SeriesRow | undefined;
  for (const c of copies) {
    const local = localWallOf(c.starts_at, repeat.tz);
    const series = await db
      .insertInto('event_series')
      .values({
        id: newId('es'),
        series_uid: seriesUid,
        group_id: c.group_id,
        group_ids: JSON.stringify(c.group_ids ?? []),
        owner_user_id: c.owner_user_id,
        organizer_user_id: c.organizer_user_id ?? null,
        role: c.role,
        created_by: c.created_by,
        assignee_id: c.assignee_id ?? null,
        assignee_persona_id: c.assignee_persona_id ?? null,
        title: c.title,
        description: c.description ?? null,
        location: c.location ?? null,
        starts_at: c.starts_at,
        ends_at: c.ends_at ?? null,
        all_day: c.all_day,
        transparency: c.transparency ?? 'opaque',
        tz: repeat.tz,
        rrule: repeat.rrule,
        exdates: '[]',
        source_raw_context: c.source_raw_context ?? null,
        google_calendar_id: c.google_calendar_id ?? null,
        // The one-off's Google event becomes the master.
        gcal_event_id: c.gcal_event_id ?? null,
        etag: c.etag ?? null,
        chord_uid: c.chord_uid ?? null,
        local_dirty: 1,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // The row is now occurrence one. Its Google identity moved to the series;
    // the pull adopts Google's first instance onto it by original start.
    await db
      .updateTable('events')
      .set({
        series_id: series.id,
        original_start: c.starts_at,
        ical_uid: occurrenceUid(seriesUid, local),
        gcal_event_id: null,
        etag: null,
        chord_uid: null,
        recurring_event_id: series.gcal_event_id ?? null,
        local_dirty: 0,
        updated_at: now,
      })
      .where('id', '=', c.id)
      .execute();
    await materializeSeries(db, series);
    if (c.id === event.id) mine = series;
  }
  firePush(db, copies.map((c) => c.owner_user_id), 'convert');
  return mine!;
}

export interface SeriesEdit {
  title?: string;
  location?: string | null;
  /** A new start for the occurrence the user pointed at; its time of day
   *  (and, for a weekly rule, its weekday) moves the whole series. */
  startsAt?: string;
  endsAt?: string | null;
  /** A new rule. */
  rrule?: string;
  description?: string | null;
}

/**
 * "All of them": change the series and its Google master, then rewrite the
 * upcoming occurrences. Past occurrences keep their times; a title or place
 * change reaches them too, since that is what the series is called.
 *
 * Returns an error sentence the bot can relay when the change cannot be
 * expressed (moving a monthly series to another date).
 */
export async function updateSeries(
  db: Kysely<DB>,
  occurrence: EventRow,
  edit: SeriesEdit,
): Promise<{ ok: true; series: SeriesRow } | { ok: false; reason: string }> {
  const series = await getSeries(db, occurrence.series_id!);
  if (!series) return { ok: false, reason: 'series not found' };
  const tz = series.tz;
  const allDay = series.all_day === 1;
  let rrule = edit.rrule ?? series.rrule;
  let startsAt = series.starts_at;
  let endsAt = series.ends_at ?? null;

  if (edit.startsAt !== undefined) {
    const was = localWallOf(occurrence.original_start ?? occurrence.starts_at, tz);
    const now = localWallOf(edit.startsAt, tz);
    const dayShift = Math.round(
      (Date.parse(`${now.slice(0, 10)}T00:00:00Z`) - Date.parse(`${was.slice(0, 10)}T00:00:00Z`)) / 86_400_000,
    );
    const rule = parseRrule(rrule);
    if (dayShift !== 0) {
      if (rule.freq !== 'WEEKLY') {
        return {
          ok: false,
          reason: 'only a weekly series can move to another day; this one can change its time, or one occurrence can move',
        };
      }
      const shifted = rule.byDay.map((d) => WEEKDAYS[(((WEEKDAYS.indexOf(d) + dayShift) % 7) + 7) % 7]!);
      rrule = rrule.replace(/BYDAY=[A-Z,]+/, `BYDAY=${shifted.join(',')}`);
    }
    const first = localWallOf(series.starts_at, tz);
    const firstDate = new Date(Date.parse(`${first.slice(0, 10)}T00:00:00Z`) + dayShift * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const newFirst = `${firstDate}T${now.slice(11, 19)}`;
    const oldMinutes = durationMinutes(series);
    const minutes =
      edit.endsAt !== undefined
        ? edit.endsAt === null
          ? null
          : Math.round((Date.parse(`${localWallOf(edit.endsAt, tz)}Z`) - Date.parse(`${now}Z`)) / 60_000)
        : oldMinutes;
    startsAt = storedStart(newFirst, tz, allDay);
    endsAt = storedEnd(newFirst, minutes, tz, allDay);
  } else if (edit.endsAt !== undefined) {
    const occStart = localWallOf(occurrence.starts_at, tz);
    const minutes =
      edit.endsAt === null
        ? null
        : Math.round((Date.parse(`${localWallOf(edit.endsAt, tz)}Z`) - Date.parse(`${occStart}Z`)) / 60_000);
    endsAt = storedEnd(localWallOf(series.starts_at, tz), minutes, tz, allDay);
  }

  const timingChanged = startsAt !== series.starts_at || endsAt !== series.ends_at || rrule !== series.rrule;
  const now = new Date().toISOString();
  const today = localDate(tz);
  const targets = await siblingSeries(db, series);
  for (const s of targets) {
    await db
      .updateTable('event_series')
      .set({
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.location !== undefined ? { location: edit.location } : {}),
        ...(edit.description !== undefined ? { description: edit.description } : {}),
        starts_at: startsAt,
        ends_at: endsAt,
        rrule,
        local_dirty: 1,
        updated_at: now,
      })
      .where('id', '=', s.id)
      .execute();
    if (edit.title !== undefined || edit.location !== undefined || edit.description !== undefined) {
      await db
        .updateTable('events')
        .set({
          ...(edit.title !== undefined ? { title: edit.title } : {}),
          ...(edit.location !== undefined ? { location: edit.location } : {}),
          ...(edit.description !== undefined ? { description: edit.description } : {}),
          updated_at: now,
        })
        .where('series_id', '=', s.id)
        .execute();
    }
    if (timingChanged) {
      // Upcoming occurrences are rewritten from the new rule. Removed without
      // tombstones: the master's change is what Google applies.
      const upcoming = await db
        .selectFrom('events')
        .select(['id', 'starts_at'])
        .where('series_id', '=', s.id)
        .execute();
      const cutoff = instantMs(storedStart(`${today}T00:00:00`, tz, false));
      // A floating all-day occurrence is midnight in `tz`, not UTC midnight.
      const drop = upcoming.filter((r) => instantInZoneMs(r.starts_at, tz) >= cutoff).map((r) => r.id);
      if (drop.length) await db.deleteFrom('events').where('id', 'in', drop).execute();
      const fresh = await getSeries(db, s.id);
      if (fresh) await materializeSeries(db, fresh, { fromDate: today });
    }
  }
  firePush(db, targets.map((s) => s.owner_user_id), 'update');
  return { ok: true, series: (await getSeries(db, series.id))! };
}

/**
 * "Just this one" delete. The occurrence is excluded from its series (and
 * from every family member's copy when the organizer deletes it), so the rule
 * never writes it again and Google drops it from the master.
 */
export async function deleteOccurrence(
  db: Kysely<DB>,
  occurrence: EventRow,
): Promise<Array<{ id: string; ownerUserId: string | null }>> {
  const targets =
    occurrence.role === 'organizer' && occurrence.ical_uid
      ? await db.selectFrom('events').selectAll().where('ical_uid', '=', occurrence.ical_uid).execute()
      : [occurrence];
  const now = new Date().toISOString();
  for (const t of targets) {
    if (!t.series_id) continue;
    const series = await getSeries(db, t.series_id);
    if (!series) continue;
    const local = localWallOf(t.original_start ?? t.starts_at, series.tz);
    await db
      .updateTable('event_series')
      .set({ exdates: JSON.stringify([...new Set([...series.exdates, local])]), local_dirty: 1, updated_at: now })
      .where('id', '=', series.id)
      .execute();
  }
  await db.deleteFrom('events').where('id', 'in', targets.map((t) => t.id)).execute();
  await retireTasksForRemovedEvents(db, targets);
  firePush(db, targets.map((t) => t.owner_user_id), 'delete-one');
  return targets.map((t) => ({ id: t.id, ownerUserId: t.owner_user_id ?? null }));
}

/**
 * "All of them" delete: the series, every occurrence, and (on the next push)
 * the Google master, which takes Google's instances with it.
 */
export async function deleteSeries(
  db: Kysely<DB>,
  occurrence: EventRow,
): Promise<Array<{ id: string; ownerUserId: string | null }>> {
  const series = await getSeries(db, occurrence.series_id!);
  if (!series) return [];
  const targets = await siblingSeries(db, series);
  const ids = targets.map((s) => s.id);
  const rows = await db.selectFrom('events').selectAll().where('series_id', 'in', ids).execute();
  await db.deleteFrom('events').where('series_id', 'in', ids).execute();
  await retireTasksForRemovedEvents(db, rows);
  const now = new Date().toISOString();
  // Never on Google: nothing to tell it, so the series simply goes.
  await db.deleteFrom('event_series').where('id', 'in', ids).where('gcal_event_id', 'is', null).execute();
  await db
    .updateTable('event_series')
    .set({ deleted_at: now, local_dirty: 1, updated_at: now })
    .where('id', 'in', ids)
    .execute();
  firePush(db, targets.map((s) => s.owner_user_id), 'delete-all');
  return rows.map((r) => ({ id: r.id, ownerUserId: r.owner_user_id ?? null }));
}

/** Keep every live series written out to the horizon. Cheap when nothing is
 *  due: one indexed query. */
export async function topUpSeries(db: Kysely<DB>, limit = 50): Promise<number> {
  // Dates compare correctly as text; a day's slack covers zones either side of UTC.
  const margin = localDate('UTC', SERIES_HORIZON_DAYS - TOP_UP_MARGIN_DAYS - 1);
  const due = await db
    .selectFrom('event_series')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('materialized_until', 'is', null), eb('materialized_until', '<', margin)]),
    )
    .orderBy('materialized_until')
    .limit(limit)
    .execute();
  let written = 0;
  for (const s of due) {
    written += await materializeSeries(db, s, {
      fromDate: s.materialized_until ?? undefined,
      toDate: localDate(s.tz, SERIES_HORIZON_DAYS),
    });
  }
  return written;
}
