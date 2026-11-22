/**
 * ADR 0057 — device calendar read-up.
 *
 * The mobile client reads the user's *selected* device calendars over a
 * −30/+60 day window and posts them here. We mirror each event into the
 * `events` table as a personal calendar item — the same shape a Google pull
 * gets (`group_ids = []`, single copy, never pushed back) — but tagged with a
 * `device:<calId>:<eventId>` external_uid instead of `gcal:`.
 *
 * Dedup (so a Google calendar mirrored onto the device doesn't double the
 * server's own Google pull) is three-layered:
 *   - Layer 0: exact UID — skip a device event whose `externalId`
 *     (EventKit `calendarItemExternalIdentifier`) already exists as a
 *     non-device row's `ical_uid`.
 *   - Layer 2: fuzzy — skip a device event matching a non-device row on
 *     normalized title and the same start: the same instant, or for an
 *     all-day event the same DATE (the phone sends an instant of midnight,
 *     Google stores a floating date — `events/device-all-day.ts`).
 * (Layer 1 — excluding the connected-Google source — happens client-side.)
 *
 * Reverse-delete: any device row for a synced calendar inside the window that
 * is absent from the batch is soft-deleted (the device removed it).
 */
import { sql, type Kysely } from 'kysely';

import type { DeviceCalendarSyncRequest, DeviceCalendarSyncResult } from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { validZone } from '../db/text-instant.js';
import { newId } from '../utils/ids.js';
import { upsertCalendarSource } from './calendar-sources.service.js';
import {
  allDayEndDate,
  allDayStartDate,
  rowIsAllDay,
  sameEventStart,
} from './events/device-all-day.js';
import { computeTransparency } from './google/two-way-sync.js';
import { ensurePersonalGroup } from './groups.service.js';

/**
 * Forget one phone calendar of one user: its mirrored events and its
 * `calendar_sources` row. Called when the phone stops mirroring it (Mirror
 * switched off) and by the retention sweep for a calendar no phone has sent
 * in a month (ADR 0226 addendum).
 *
 * A mirrored row the Google/Outlook pull has since adopted (it matched the
 * row's `ical_uid` and gave it `google_calendar_id` / `gcal_event_id`) is the
 * server's copy of that event now, and is left alone: deleting it would drop
 * the event from Chord until the next full pull, since a delta never re-sends
 * an unchanged event. Rows are removed, never tombstoned, so nothing is
 * pushed to any provider and the phone has nothing of Chord's to delete (the
 * mirror was read FROM the phone, never written to it).
 */
export async function forgetDeviceCalendar(
  db: Kysely<DB>,
  userId: string,
  deviceCalendarId: string,
): Promise<{ events: number; calendar: boolean }> {
  const prefix = `device:${deviceCalendarId}:`;
  return db.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom('events')
      .where('owner_user_id', '=', userId)
      // starts_with, not LIKE: a calendar id may hold `_` or `%`.
      .where(sql<boolean>`starts_with(external_uid, ${prefix})`)
      .where('google_calendar_id', 'is', null)
      .where('gcal_event_id', 'is', null)
      .executeTakeFirst();
    const source = await trx
      .deleteFrom('calendar_sources')
      .where('user_id', '=', userId)
      .where('provider', '=', 'device')
      .where('google_calendar_id', '=', deviceCalendarId)
      .executeTakeFirst();
    return {
      events: Number(removed.numDeletedRows ?? 0),
      calendar: Number(source.numDeletedRows ?? 0) > 0,
    };
  });
}

function deviceExternalUid(deviceCalendarId: string, deviceEventId: string): string {
  return `device:${deviceCalendarId}:${deviceEventId}`;
}

/** Mirrors the SQL `lower(btrim(title))` used in the fuzzy-dedup query. */
function normTitle(title: string): string {
  return title.trim().toLowerCase();
}

/** Floating-midnight (no Z/offset) is the all-day convention (ADR 0040). */
function isAllDay(startsAt: string, flag?: boolean): boolean {
  return flag ?? /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(startsAt);
}

/**
 * EventKit's explicit show-me-as signal wins; the structural rule (all-day /
 * <5-min → free) stays as the fallback for events with no availability set —
 * the same two-signal shape Google events get from `transparency`.
 */
function deviceTransparency(
  ev: { startsAt: string; endsAt?: string | null; availability?: string },
  allDay: boolean,
): 'opaque' | 'transparent' {
  if (ev.availability === 'free') return 'transparent';
  if (ev.availability === 'busy' || ev.availability === 'unavailable') return 'opaque';
  return computeTransparency({ startsAt: ev.startsAt, endsAt: ev.endsAt, allDay });
}

/** Newer-wins: true when `incoming` should overwrite `existing` (LWW). */
function incomingIsNewer(incoming: string | null | undefined, existing: string | null): boolean {
  if (!incoming) return false;
  if (!existing) return true;
  const a = Date.parse(incoming);
  const b = Date.parse(existing);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a >= b;
}

/**
 * A phone all-day event is stored floating (ADR 0040), the way a Google one is,
 * so every client puts it on its date. Timed events pass through.
 */
function storedTimes(
  ev: { startsAt: string; endsAt?: string | null },
  allDay: boolean,
  tz: string | null,
): { starts_at: string; ends_at: string | null } {
  if (!allDay) return { starts_at: ev.startsAt, ends_at: ev.endsAt ?? null };
  return {
    starts_at: `${allDayStartDate(ev.startsAt, tz)}T00:00:00`,
    ends_at: ev.endsAt ? `${allDayEndDate(ev.endsAt, tz)}T00:00:00` : null,
  };
}

function inWindow(startsAt: string, windowStart: string, windowEnd: string): boolean {
  const t = Date.parse(startsAt);
  if (!Number.isFinite(t)) return true; // can't place it — keep it (don't reverse-delete)
  const lo = Date.parse(windowStart);
  const hi = Date.parse(windowEnd);
  return (!Number.isFinite(lo) || t >= lo) && (!Number.isFinite(hi) || t <= hi);
}

export async function syncDeviceCalendar(
  db: Kysely<DB>,
  userId: string,
  batch: DeviceCalendarSyncRequest,
): Promise<DeviceCalendarSyncResult> {
  const personalGroup = await ensurePersonalGroup(db, userId);
  const groupId = personalGroup.id;
  const now = new Date().toISOString();
  const result: DeviceCalendarSyncResult = { inserted: 0, updated: 0, deduped: 0, deleted: 0 };
  // The phone's zone decides which day an all-day event's midnight is on.
  const sentTz =
    batch.timeZone && validZone(batch.timeZone) === batch.timeZone ? batch.timeZone : undefined;
  const tz =
    sentTz ??
    (await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst())
      ?.last_tz ??
    null;

  // ── 1. Register the selected calendars as device-provider sources. ──
  for (const cal of batch.calendars) {
    await upsertCalendarSource(db, userId, {
      provider: 'device',
      googleCalendarId: cal.deviceCalendarId,
      summary: cal.title ?? null,
      color: cal.color ?? null,
      // Writable device calendar → counts as busy by default (ADR 0033 rules);
      // read-only → informational. The user can override per source.
      accessRole: cal.allowsModifications === false ? 'reader' : 'writer',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });
  }

  // ── 2. Upsert each event. ──
  const present = new Set(
    batch.events.map((e) => deviceExternalUid(e.deviceCalendarId, e.deviceEventId)),
  );
  const claimed = new Set<string>();

  // The server's own copies (Google/Outlook pull, Chord-made) of this user's
  // events: a phone event that is one of them is not mirrored.
  const serverRows = await db
    .selectFrom('events')
    .select(['title', 'starts_at', 'all_day', 'ical_uid'])
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('external_uid', 'is', null), eb('external_uid', 'not like', 'device:%')]),
    )
    .execute();
  const serverUids = new Set(serverRows.map((r) => r.ical_uid));
  const serverByTitle = new Map<string, typeof serverRows>();
  for (const r of serverRows) {
    const key = normTitle(r.title);
    serverByTitle.set(key, [...(serverByTitle.get(key) ?? []), r]);
  }
  // Layer 0 — exact UID: a Google event mirrored onto the device carries the
  // same server UID we already stored as ical_uid on the gcal pull.
  // Layer 2 — fuzzy: same normalized title + start. Timed starts compare as
  // instants: the phone sends "…00.000Z", a Google pull stores "…00Z" or the
  // event's own offset (ADR 0208). All-day starts compare as dates.
  const isServerCopy = (ev: DeviceCalendarSyncRequest['events'][number], allDay: boolean) =>
    (!!ev.externalId && serverUids.has(ev.externalId)) ||
    (serverByTitle.get(normTitle(ev.title)) ?? []).some((r) =>
      sameEventStart(
        { startsAt: ev.startsAt, allDay },
        { startsAt: r.starts_at, allDay: rowIsAllDay(r) },
        tz,
      ),
    );

  for (const ev of batch.events) {
    const externalUid = deviceExternalUid(ev.deviceCalendarId, ev.deviceEventId);
    const allDay = isAllDay(ev.startsAt, ev.allDay);

    const existing = await db
      .selectFrom('events')
      .select(['id', 'updated_at'])
      .where('group_id', '=', groupId)
      .where('external_uid', '=', externalUid)
      .executeTakeFirst();

    if (existing) {
      // Mirrored before the server held its own copy (or before the two were
      // recognised as one): the phone's copy goes, as `dropDeviceTwin` does
      // when the server copy arrives second.
      if (isServerCopy(ev, allDay)) {
        await db.deleteFrom('events').where('id', '=', existing.id).execute();
        result.deduped += 1;
        continue;
      }
      // LWW — only overwrite when the device's copy is at least as fresh.
      if (incomingIsNewer(ev.updatedAt, existing.updated_at ?? null)) {
        await db
          .updateTable('events')
          .set({
            title: ev.title,
            location: ev.location ?? null,
            description: ev.description ?? null,
            ...storedTimes(ev, allDay, tz),
            all_day: allDay ? 1 : 0,
            status: ev.status ?? 'confirmed',
            transparency: deviceTransparency(ev, allDay),
            deleted_at: null,
            updated_at: ev.updatedAt ?? now,
          })
          .where('id', '=', existing.id)
          .execute();
        result.updated += 1;
      }
      continue;
    }

    // ── Dedup against the server's own (Google/Chord) copies. ──
    if (isServerCopy(ev, allDay)) {
      result.deduped += 1;
      continue;
    }

    const titled = await db
      .selectFrom('events')
      .select(['id', 'starts_at', 'all_day', 'external_uid'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .where('external_uid', 'like', 'device:%')
      .where(sql<boolean>`lower(btrim(title)) = ${normTitle(ev.title)}`)
      .execute();
    const sameStart = titled.filter((r) =>
      sameEventStart(
        { startsAt: ev.startsAt, allDay },
        { startsAt: r.starts_at, allDay: rowIsAllDay(r) },
        tz,
      ),
    );

    // A subscribed calendar on iOS hands out new event ids on every refresh.
    // The same event under a new id takes over the row already held for it
    // instead of a new row (and a tombstone for the old one) per sync.
    const calPrefix = `device:${ev.deviceCalendarId}:`;
    const reuse = sameStart.find(
      (r) =>
        r.external_uid?.startsWith(calPrefix) &&
        !present.has(r.external_uid) &&
        !claimed.has(r.id),
    );
    if (reuse) {
      claimed.add(reuse.id);
      await db
        .updateTable('events')
        .set({
          external_uid: externalUid,
          ...(ev.externalId ? { ical_uid: ev.externalId } : {}),
          title: ev.title,
          location: ev.location ?? null,
          description: ev.description ?? null,
          ...storedTimes(ev, allDay, tz),
          all_day: allDay ? 1 : 0,
          status: ev.status ?? 'confirmed',
          transparency: deviceTransparency(ev, allDay),
          updated_at: ev.updatedAt ?? now,
        })
        .where('id', '=', reuse.id)
        .execute();
      result.updated += 1;
      continue;
    }

    await db
      .insertInto('events')
      .values({
        id: newId('e'),
        group_id: groupId,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        external_uid: externalUid,
        // Layer-0 dedup key going forward: store the device's server UID so a
        // later Google pull of the same event dedups against THIS row too.
        ical_uid: ev.externalId ?? newId('e'),
        chord_uid: null,
        title: ev.title,
        location: ev.location ?? null,
        description: ev.description ?? null,
        ...storedTimes(ev, allDay, tz),
        all_day: allDay ? 1 : 0,
        status: ev.status ?? 'confirmed',
        transparency: deviceTransparency(ev, allDay),
        created_by: userId,
        created_at: now,
        updated_at: ev.updatedAt ?? now,
        // Device is the source: never pushed to Google.
        local_dirty: 0,
        gcal_sync_status: 'skipped',
      })
      .execute();
    result.inserted += 1;
  }

  // ── 3. Reverse-delete: events removed on the device. ──
  // Scoped to the calendars in THIS batch and to the synced window, so we never
  // touch out-of-window rows or calendars the user didn't sync this round.
  for (const cal of batch.calendars) {
    const rows = await db
      .selectFrom('events')
      .select(['id', 'external_uid', 'starts_at'])
      .where('owner_user_id', '=', userId)
      .where('external_uid', 'like', `device:${cal.deviceCalendarId}:%`)
      .where('deleted_at', 'is', null)
      .where('status', '!=', 'cancelled')
      .execute();
    for (const row of rows) {
      if (!row.external_uid || present.has(row.external_uid)) continue;
      if (!inWindow(row.starts_at, batch.windowStart, batch.windowEnd)) continue;
      await db
        .updateTable('events')
        .set({ status: 'cancelled', deleted_at: now })
        .where('id', '=', row.id)
        .execute();
      result.deleted += 1;
    }
  }

  return result;
}
