/**
 * Two-way calendar sync — I/O shell (ADR 0040).
 *
 * The thin Google-facing layer that wires the pure reconcile core
 * (`two-way-sync.ts`) to the Calendar v3 REST API and the `events` table.
 * All merge/versioning rules live in the core; this file does HTTP + DB only.
 *
 * `syncTwoWay` = push local edits first (so they land before we reconcile),
 * then pull each calendar's changes.
 *
 * EXPAND PHASE: this operates on the ADR 0040 columns. Both directions are now
 * wired: `pushDirtyEvents` from createEvent/updateEvent/deleteEvent, and
 * `syncTwoWay` (push → discover → pull) from `maybeSyncCalendar` and the manual
 * `POST /me/calendar/sync` route. The legacy `syncPrimaryCalendar` is retained
 * only as a fallback / for its tests; it no longer runs in the live paths.
 *
 * Not yet implemented (tracked):
 *   - webhook watch channels (we poll; syncToken makes the poll incremental)
 *   - deep-future windowing (pull window is fixed; futureDays no longer widens it)
 *   - group-default / invite-calendar resolution beyond user default → primary
 */
import { recordGuestAnswers } from '../events/guest-answers.js';
import { sql, type Kysely, type Selectable } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB, EventSeriesTable, EventsTable } from '../../db/schema.js';
import { coalescePerKey, mapConcurrent } from '../../utils/concurrency.js';
import { upsertCalendarSource } from '../calendar-sources.service.js';
import {
  findEmailEventTwin,
  retractPendingEmailEventProposalsNear,
  retractPendingProposalsByUid,
} from '../event-convergence.service.js';
import { rowIsAllDay, sameEventStart } from '../events/device-all-day.js';
import { askAboutEmailTwin } from '../events/email-twin-question.js';
import { retireTasksForRemovedEvents } from '../events/retire-event-tasks.js';
import { ensurePersonalGroup } from '../groups.service.js';
import { newId } from '../../utils/ids.js';
import { hasCalendarScope, hasCalendarWriteScope } from './calendar-write.service.js';
import { getAccessToken } from './oauth.service.js';
import { isOutlookCalendarKey } from '../outlook-calendar/ids.js';
import { isGmailCalendarKey } from '../gmail-calendar/ids.js';
import {
  discoverGmailAccountCalendars,
  gmailCalendarAccessToken,
  gmailCalendarAccounts,
  gmailAccountTransport,
  gmailCalendarApiForKey,
} from '../gmail-calendar/accounts.js';
import {
  discoverOutlookCalendars,
  outlookCalendarAccounts,
  outlookCalendarApiFor,
  outlookCalendarApiForKey,
} from '../outlook-calendar/accounts.js';
import {
  CalendarWriteError,
  gfetch,
  googleCalendarTransport,
  PULL_FUTURE_DAYS,
  PULL_PAST_DAYS,
  type CalendarTransport,
  type CalendarWriteResponse,
} from './calendar-transport.js';
import {
  FanoutCopies,
  isAnotherMembersCopyOfMine,
  otherEventCopies,
  otherSeriesCopies,
} from './fanout-copies.js';
import { instantMs } from '../../db/text-instant.js';
import { exdatesForGoogle, localWallOf, rruleForGoogle } from '../events/recurrence.js';
import { forgetOccurrence, occurrenceUid } from '../events/series-sync.js';
import {
  googleDateTimeToIso,
  googleEventToLocalFields,
  isChordOrigin,
  localRowToGoogleBody,
  reconcileRemote,
  selfDeclined,
  selfResponded,
  type EventStatus,
  type GoogleEventResource,
  type LocalCopy,
} from './two-way-sync.js';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const PAST_DAYS = PULL_PAST_DAYS;
const FUTURE_DAYS = PULL_FUTURE_DAYS;

/**
 * How long a delta cursor is used before the pull lists the window again.
 * The window is fixed when the cursor is first obtained and a delta never
 * moves it, so without this an unchanged repeating event would stop getting
 * new occurrences once its first year ran out.
 */
const FULL_RESYNC_MS = 24 * 60 * 60 * 1000;

/** Organizer and guests of a calendar item (ADR 0344 evidence). */
function remotePeople(remote: GoogleEventResource): string[] {
  return [remote.organizer?.email, ...(remote.attendees ?? []).map((a) => a.email)].filter(
    (e): e is string => typeof e === 'string' && e.length > 0,
  );
}

/** Is this a repeating event's occurrence starting past the pull window? A
 *  Google delta is not limited to the window: one edit to an endless series
 *  returns every occurrence, out to about 730 of them. */
function occurrenceBeyondWindow(remote: GoogleEventResource, now: number): boolean {
  if (!remote.recurringEventId) return false;
  const start = googleEventToLocalFields(remote).starts_at;
  if (!start) return false;
  const ms = instantMs(start);
  return Number.isFinite(ms) && ms > now + FUTURE_DAYS * 86_400_000;
}

/**
 * Will this ever succeed if we send the same thing again?
 *
 * A 4xx is the provider rejecting the payload or the permission, not a hiccup
 * — the identical body will be rejected identically forever. One event created
 * in June sat at `local_dirty=1` with `events.insert 400` and was re-sent on
 * every sync pass for two months. 408/429 are the 4xx that DO mean try again.
 */
function isPermanentWriteFailure(err: unknown): boolean {
  if (!(err instanceof CalendarWriteError)) return false;
  if (err.status === 408 || err.status === 429) return false;
  return err.status >= 400 && err.status < 500;
}

// ── target-calendar resolution (replaces hardcoded "Family") ────────────────

/**
 * Where a user's events go when a row names no calendar, and which providers
 * can take a write this pass (ADR 0228). Loaded once per push.
 *
 * `primary` means the Google primary. A user with no Google calendar but an
 * Outlook one has no such thing, so for them it reads as the Outlook default
 * calendar — otherwise every event they make would wait forever for a Google
 * connection they do not have.
 */
class PushTargets {
  private readonly cache = new Map<string, Promise<CalendarTransport | null>>();

  private constructor(
    private readonly db: Kysely<DB>,
    private readonly userId: string,
    readonly googleOk: boolean,
    readonly outlookAccountIds: Set<string>,
    readonly gmailAccountIds: Set<string>,
    private readonly userDefault: string | null,
    private readonly outlookDefault: string | null,
  ) {}

  static async load(db: Kysely<DB>, userId: string): Promise<PushTargets> {
    const googleOk = await hasCalendarWriteScope(db, userId);
    const accounts = await outlookCalendarAccounts(db, userId);
    const gmailAccounts = await gmailCalendarAccounts(db, userId);
    const user = await db
      .selectFrom('users')
      .select('default_calendar_id')
      .where('id', '=', userId)
      .executeTakeFirst();
    return new PushTargets(
      db,
      userId,
      googleOk,
      new Set(accounts.map((a) => a.id)),
      new Set(gmailAccounts.map((a) => a.id)),
      user?.default_calendar_id ?? null,
      accounts.find((a) => !!a.calendar_default_id)?.calendar_default_id ?? null,
    );
  }

  get any(): boolean {
    return this.googleOk || this.outlookAccountIds.size > 0 || this.gmailAccountIds.size > 0;
  }

  calendarFor(row: { google_calendar_id: string | null }): string {
    const id = row.google_calendar_id ?? this.userDefault ?? 'primary';
    return id === 'primary' && !this.googleOk && this.outlookDefault ? this.outlookDefault : id;
  }

  /**
   * The transport for a calendar, or null when its provider cannot take a
   * write right now (the row then stays queued). A dead Google token throws,
   * as `getAccessToken` always has; the same error is rethrown for every
   * Google row of the pass.
   */
  transportFor(calendarId: string): Promise<CalendarTransport | null> {
    const outlook = isOutlookCalendarKey(calendarId);
    // ADR 0313 — an attached Gmail's calendar is written with ITS token only.
    const gmailAccount = isGmailCalendarKey(calendarId);
    const key = outlook || gmailAccount ? calendarId.split(':').slice(0, 2).join(':') : 'google';
    let t = this.cache.get(key);
    if (!t) {
      t = outlook
        ? outlookCalendarApiForKey(this.db, this.userId, calendarId).catch((err) => {
            logger.warn(`outlook calendar unavailable user=${this.userId}: ${(err as Error).message}`);
            return null;
          })
        : gmailAccount
          ? gmailCalendarApiForKey(this.db, this.userId, calendarId).catch((err) => {
              logger.warn(`gmail account calendar unavailable user=${this.userId}: ${(err as Error).message}`);
              return null;
            })
        : this.googleOk
          ? getAccessToken(this.db, this.userId).then(googleCalendarTransport)
          : Promise.resolve(null);
      this.cache.set(key, t);
    }
    return t;
  }
}

/**
 * ADR 0295 — the provider calendar and transport an event row lives on, or
 * null when nothing can take a write for it right now.
 */
export async function eventCalendarTransport(
  db: Kysely<DB>,
  userId: string,
  row: { google_calendar_id: string | null },
): Promise<{ calendarId: string; transport: CalendarTransport } | null> {
  const targets = await PushTargets.load(db, userId);
  if (!targets.any) return null;
  const calendarId = targets.calendarFor(row);
  const transport = await targets.transportFor(calendarId).catch(() => null);
  return transport ? { calendarId, transport } : null;
}

// ── PUSH ────────────────────────────────────────────────────────────────────

export interface PushResult {
  created: number;
  updated: number;
  deleted: number;
  errored: number;
}

function rowToLocalCopy(row: Selectable<EventsTable>): LocalCopy {
  return {
    sequence: row.sequence,
    updatedAt: row.updated_at ?? row.created_at,
    localDirty: row.local_dirty === 1,
    status: row.status,
    deletedAt: row.deleted_at,
    role: row.role,
  };
}

async function markPushed(
  db: Kysely<DB>,
  eventId: string,
  resp: CalendarWriteResponse,
  calendarId: string,
  chordUid?: string,
): Promise<void> {
  await db
    .updateTable('events')
    .set({
      gcal_event_id: resp.id,
      etag: resp.etag ?? null,
      google_calendar_id: calendarId,
      gcal_sync_status: 'synced',
      gcal_synced_at: new Date().toISOString(),
      gcal_last_error: null,
      local_dirty: 0,
      guest_notice_due: 0,
      ...(typeof resp.sequence === 'number' ? { sequence: resp.sequence } : {}),
      // `ical_uid` is Chord's key for the logical event (ADR 0040 §3): every
      // member's copy of a group event shares it, and an occurrence has its
      // own (ADR 0217). Google's iCalUID names only THIS copy's Google event,
      // so it fills an empty key and never replaces one. Replacing it gave
      // each pushed copy a different key: the bot saw the event once per
      // member and an organizer edit stopped reaching the other copies.
      ...(resp.iCalUID ? { ical_uid: sql<string>`coalesce(ical_uid, ${resp.iCalUID})` } : {}),
      ...(chordUid ? { chord_uid: chordUid } : {}),
    })
    .where('id', '=', eventId)
    .execute();
}

/**
 * Point other members' copies of a group series at a master already on their
 * calendar, along with their occurrences, so their pulls adopt its instances.
 * Only series not yet bound: a bound one has its own master.
 */
async function bindSeriesToMaster(
  db: Kysely<DB>,
  seriesIds: string[],
  master: { gcal_event_id: string | null; etag: string | null; chord_uid: string | null },
  calendarId: string,
): Promise<void> {
  const bound = await db
    .updateTable('event_series')
    .set({
      gcal_event_id: master.gcal_event_id,
      etag: master.etag,
      chord_uid: master.chord_uid,
      google_calendar_id: sql<string>`coalesce(google_calendar_id, ${calendarId})`,
      gcal_sync_status: 'synced',
      gcal_last_error: null,
      local_dirty: 0,
    })
    .where('id', 'in', seriesIds)
    .where('gcal_event_id', 'is', null)
    .returning('id')
    .execute();
  if (bound.length === 0) return;
  await db
    .updateTable('events')
    .set({
      recurring_event_id: master.gcal_event_id,
      google_calendar_id: sql<string>`coalesce(google_calendar_id, ${calendarId})`,
    })
    .where('series_id', 'in', bound.map((b) => b.id))
    .where('gcal_event_id', 'is', null)
    .execute();
}

/**
 * ADR 0217 — push the user's dirty series as Google recurring masters. Runs
 * before the occurrence push so a master exists by the time an occurrence
 * could need its instance. Google expands the master itself; occurrence rows
 * are adopted onto its instances by the pull.
 */
async function pushDirtySeries(db: Kysely<DB>, userId: string, targets: PushTargets): Promise<void> {
  const dirty = await db
    .updateTable('event_series')
    .set({ local_dirty: 0 })
    .where('owner_user_id', '=', userId)
    .where('local_dirty', '=', 1)
    .returningAll()
    .execute();
  // One master per calendar for a group series several members' copies share
  // (ADR 0040 addendum 2026-10-23), exactly as for one-off events.
  const asCopy = (s: Selectable<EventSeriesTable>) => ({ ...s, key: s.series_uid });
  const fanout = await FanoutCopies.load(db, userId, dirty.map(asCopy), otherSeriesCopies(db, userId));
  const waitingSeries = new Map<string, string[]>();
  for (const s of dirty) {
    const calendarId = targets.calendarFor(s);
    try {
      const transport = await targets.transportFor(calendarId);
      if (!transport) {
        // Its provider cannot take a write right now: leave it queued.
        await db.updateTable('event_series').set({ local_dirty: 1 }).where('id', '=', s.id).execute();
        continue;
      }
      if (s.deleted_at) {
        if (s.gcal_event_id && !fanout.keepRemoteOnDelete(asCopy(s), calendarId)) {
          await transport.remove(calendarId, s.gcal_event_id);
        }
        await db.deleteFrom('event_series').where('id', '=', s.id).execute();
        continue;
      }
      if (!s.gcal_event_id) {
        const plan = fanout.planInsert(asCopy(s), calendarId);
        if (plan.kind === 'adopt') {
          await bindSeriesToMaster(db, [s.id], plan.from, calendarId);
          continue;
        }
        if (plan.kind === 'wait') {
          await db
            .updateTable('event_series')
            .set({ local_dirty: 1 })
            .where('id', '=', s.id)
            .where('gcal_event_id', 'is', null)
            .execute();
          continue;
        }
        if (plan.waiting.length > 0) waitingSeries.set(s.id, plan.waiting.map((w) => w.id));
      } else if (fanout.isReflection(asCopy(s), calendarId)) {
        continue;
      }
      const allDay = s.all_day === 1;
      const chordUid = s.chord_uid ?? newId('ce');
      const body = {
        ...localRowToGoogleBody({
          title: s.title,
          description: s.description,
          location: s.location,
          starts_at: s.starts_at,
          ends_at: s.ends_at,
          all_day: s.all_day,
          start_tz: s.tz,
          end_tz: s.tz,
          chord_uid: chordUid,
        }),
        recurrence: [
          rruleForGoogle(s.rrule, s.tz, allDay),
          ...exdatesForGoogle(s.exdates, s.tz, allDay),
        ],
      };
      delete (body as Record<string, unknown>).sequence;
      const out = s.gcal_event_id
        ? await transport.patch(calendarId, s.gcal_event_id, body, { notify: false })
        : await transport.insert(calendarId, body, false);
      if (out === 'stale') throw new Error('series patch refused as stale');
      await db
        .updateTable('event_series')
        .set({
          gcal_event_id: out.id,
          etag: out.etag ?? null,
          google_calendar_id: calendarId,
          chord_uid: chordUid,
          gcal_sync_status: 'synced',
          gcal_last_error: null,
        })
        .where('id', '=', s.id)
        .execute();
      // Occurrences point at the master, which is how the pull finds them.
      await db
        .updateTable('events')
        .set({ recurring_event_id: out.id, google_calendar_id: calendarId })
        .where('series_id', '=', s.id)
        .where('gcal_event_id', 'is', null)
        .execute();
      const waiting = waitingSeries.get(s.id);
      if (waiting) {
        await bindSeriesToMaster(
          db,
          waiting,
          { gcal_event_id: out.id, etag: out.etag ?? null, chord_uid: chordUid },
          calendarId,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentWriteFailure(err);
      logger.warn(`two-way push ${permanent ? 'rejected' : 'failed'} series=${s.id}: ${msg}`);
      await db
        .updateTable('event_series')
        .set({ gcal_sync_status: 'error', gcal_last_error: msg.slice(0, 500), local_dirty: permanent ? 0 : 1 })
        .where('id', '=', s.id)
        .execute();
    }
  }
}

/**
 * Drain every `local_dirty` event owned by the user to its calendar. Creates
 * push as an insert (stamping chord_uid), edits as a patch guarded by the etag
 * (refused → re-pull + LWW), deletes/cancellations as a delete. Per-row
 * best-effort: one failure marks that row 'error' and moves on.
 *
 * Each row goes to the provider its calendar belongs to (ADR 0228). A row whose
 * provider cannot take a write right now is put back in the queue untouched.
 */
export async function pushDirtyEvents(db: Kysely<DB>, userId: string): Promise<PushResult> {
  const result: PushResult = { created: 0, updated: 0, deleted: 0, errored: 0 };

  // Nothing connected with write access → leave the rows dirty; a later sync
  // (after the user grants calendar access) drains them. Keeps
  // create/edit/delete safe to call for demo / not-yet-connected users.
  const targets = await PushTargets.load(db, userId);
  if (!targets.any) return result;

  const dirtySeries = await db
    .selectFrom('event_series')
    .select('id')
    .where('owner_user_id', '=', userId)
    .where('local_dirty', '=', 1)
    .executeTakeFirst();
  if (dirtySeries) await pushDirtySeries(db, userId, targets);

  // CLAIM the dirty rows by clearing local_dirty in a single returning UPDATE.
  // A concurrent push pass — createEvent's fire-and-forget vs. a maybeSync pass
  // racing on the same user — then sees local_dirty=0 and claims nothing, so the
  // same event is never double-sent. On a per-row failure we restore local_dirty
  // so the next pass retries.
  const dirty = await db
    .updateTable('events')
    .set({ local_dirty: 0 })
    .where('owner_user_id', '=', userId)
    .where('local_dirty', '=', 1)
    .returningAll()
    .execute();
  if (dirty.length === 0) return result;

  // Pair every claimed row with its transport before anything is sent. A row
  // whose provider is unavailable is un-claimed, so a later sync re-drains it.
  // That covers a Google token dying between the scope check and here (it is
  // only cleared when something tries to use it): without the un-claim, events
  // created while disconnected would sit at local_dirty=0 and never be sent.
  // The token error is still thrown, after the rows other providers can take
  // have gone out.
  const ready: Array<{
    row: Selectable<EventsTable>;
    calendarId: string;
    transport: CalendarTransport;
  }> = [];
  const unavailable: string[] = [];
  let authError: unknown = null;
  for (const row of dirty) {
    const calendarId = targets.calendarFor(row);
    let transport: CalendarTransport | null = null;
    try {
      transport = await targets.transportFor(calendarId);
    } catch (err) {
      authError = err;
    }
    if (transport) ready.push({ row, calendarId, transport });
    else unavailable.push(row.id);
  }
  if (unavailable.length > 0) {
    await db.updateTable('events').set({ local_dirty: 1 }).where('id', 'in', unavailable).execute();
  }
  const asCopy = (row: Selectable<EventsTable>) => ({ ...row, key: row.ical_uid });
  const fanout = await FanoutCopies.load(
    db,
    userId,
    ready.map((r) => asCopy(r.row)),
    otherEventCopies(db, userId),
  );

  // Each row is an independent calendar write with no dependency on any other
  // row's outcome, so they run bounded-concurrent instead of one HTTP round
  // trip at a time — a fanned-out group event or a bulk edit no longer pays N
  // sequential API calls end to end.
  await mapConcurrent(ready, env.GOOGLE_CALENDAR_PUSH_CONCURRENCY, async ({ row, calendarId, transport }) => {
    // ADR 0217 — an occurrence edited before the pull adopted the provider's
    // instance has nothing to address yet. Inserting it would add a stray
    // one-off beside the series; hold it until adoption gives it an id.
    if (row.series_id && !row.gcal_event_id) {
      await db.updateTable('events').set({ local_dirty: 1 }).where('id', '=', row.id).execute();
      return;
    }
    const isDelete = row.status === 'cancelled' || row.deleted_at !== null;
    // ADR 0295 — guests live on the provider event, never in Chord: they are
    // added and removed straight through the provider (events/guests.service),
    // and this push never sends an `attendees` field, so a patch leaves the
    // provider's list exactly as it is. An update still tells whoever is on
    // it. Not from a member's reflection of someone else's group event
    // (ADR 0181): that copy is theirs alone and must not mail anyone.
    const isReflection = !!row.organizer_user_id && row.organizer_user_id !== row.owner_user_id;
    // ADR 0328 — guests hear about a cancellation and a time or place change
    // (`guest_notice_due`, set by updateEvent), not a retitle or a note edit:
    // a typo fix must not email the whole family.
    const notify = !isReflection && (isDelete || row.guest_notice_due === 1);
    try {
      if (isDelete) {
        if (row.gcal_event_id && !fanout.keepRemoteOnDelete(asCopy(row), calendarId)) {
          await transport.remove(calendarId, row.gcal_event_id, row.etag, notify);
        }
        // Tombstone served its purpose once the provider is told; drop the row.
        await db.deleteFrom('events').where('id', '=', row.id).execute();
        result.deleted++;
        return;
      }

      if (!row.gcal_event_id) {
        // Another member's copy of this group event writes to the same
        // calendar: take its event, or wait for it to exist (ADR 0040
        // addendum 2026-10-23). Inserting would put a second one there.
        const plan = fanout.planInsert(asCopy(row), calendarId);
        if (plan.kind === 'adopt') {
          await db
            .updateTable('events')
            .set({
              gcal_event_id: plan.from.gcal_event_id,
              etag: plan.from.etag,
              chord_uid: plan.from.chord_uid,
              google_calendar_id: calendarId,
              gcal_sync_status: 'synced',
              gcal_synced_at: new Date().toISOString(),
              gcal_last_error: null,
            })
            .where('id', '=', row.id)
            .execute();
          return;
        }
        if (plan.kind === 'wait') {
          // Re-queued unless the writer bound this row meanwhile.
          await db
            .updateTable('events')
            .set({ local_dirty: 1 })
            .where('id', '=', row.id)
            .where('gcal_event_id', 'is', null)
            .execute();
          return;
        }
        // Create. Ensure a chord_uid stamp exists so the pull-back recognizes
        // this as our own event (loop prevention).
        const chordUid = row.chord_uid ?? newId('ce');
        const created = await transport.insert(
          calendarId,
          localRowToGoogleBody({ ...row, chord_uid: chordUid }),
          false,
        );
        await markPushed(db, row.id, created, calendarId, chordUid);
        if (plan.waiting.length > 0) {
          await db
            .updateTable('events')
            .set({
              gcal_event_id: created.id,
              etag: created.etag ?? null,
              chord_uid: chordUid,
              google_calendar_id: sql<string>`coalesce(google_calendar_id, ${calendarId})`,
              gcal_sync_status: 'synced',
              gcal_synced_at: new Date().toISOString(),
              gcal_last_error: null,
              local_dirty: 0,
            })
            .where('id', 'in', plan.waiting.map((w) => w.id))
            .where('gcal_event_id', 'is', null)
            .execute();
        }
        result.created++;
        return;
      }

      // A copy reflecting another member's event on a shared calendar does
      // not write it; that member's copy does.
      if (fanout.isReflection(asCopy(row), calendarId)) {
        await db
          .updateTable('events')
          .set({ gcal_sync_status: 'synced', gcal_last_error: null })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      // Update with optimistic concurrency.
      let written = await transport.patch(
        calendarId,
        row.gcal_event_id,
        localRowToGoogleBody(row),
        { etag: row.etag, notify },
      );
      if (written === 'stale') {
        // etag stale: someone changed it on the provider. Pull that one event
        // and let the core decide (LWW). Local wins → retry the patch
        // unconditionally; remote wins → apply it and abandon our push.
        const remote = await transport.get(calendarId, row.gcal_event_id);
        if (remote) {
          // We CLAIMED this row (local_dirty already cleared), but it represents
          // a pending local edit — force localDirty so the core takes the LWW
          // conflict branch rather than treating it as a clean copy.
          const action = reconcileRemote({ ...rowToLocalCopy(row), localDirty: true }, {
            sequence: remote.sequence ?? row.sequence,
            updated: remote.updated ?? new Date(0).toISOString(),
            status: remote.status ?? 'confirmed',
          });
          if (action.kind === 'conflict-resolved' && action.winner === 'remote') {
            await applyRemoteToLocal(db, row.id, remote, calendarId);
            return;
          }
          written = await transport.patch(calendarId, row.gcal_event_id, localRowToGoogleBody(row), {
            notify,
          });
        }
      }
      if (written === 'stale') throw new CalendarWriteError('events.patch', 412);
      await markPushed(db, row.id, written, calendarId);
      result.updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const permanent = isPermanentWriteFailure(err);
      logger.warn(
        `two-way push ${permanent ? 'rejected' : 'failed'} event=${row.id}: ${msg}` +
          (permanent ? ' (giving up until the event changes)' : ''),
      );
      // Restore the claim so the next pass retries — unless the provider
      // rejected the event outright, in which case re-sending the same body
      // just burns a request every pass forever. The row stays in Chord marked
      // 'error'; any later local edit sets local_dirty again and re-arms the
      // push.
      await db
        .updateTable('events')
        .set({
          gcal_sync_status: 'error',
          gcal_last_error: msg.slice(0, 500),
          local_dirty: permanent ? 0 : 1,
        })
        .where('id', '=', row.id)
        .execute();
      result.errored++;
    }
  });
  if (authError) throw authError;
  return result;
}

// ── PULL ──────────────────────────────────────────────────────────────────

export interface PullResult {
  inserted: number;
  applied: number;
  deleted: number;
  pushBack: number;
  noop: number;
  /** Items skipped because reconciling them threw. A non-zero count means
   *  the calendar synced PARTIALLY — the pass no longer dies on the first
   *  bad event, so this is what says something was left behind. */
  failed: number;
}

/**
 * Which account's token a calendar id is written with (ADR 0313): an Outlook
 * mailbox, an attached Gmail, or the login Google account.
 */
function calendarAccount(calendarId: string): string {
  return isOutlookCalendarKey(calendarId) || isGmailCalendarKey(calendarId)
    ? calendarId.split(':').slice(0, 2).join(':')
    : 'google';
}

/** A row on another account's calendar: this pull leaves it alone. */
const OTHER_ACCOUNT = Symbol('other-account');

/**
 * ADR 0313 — the same Google event can be visible to two of the user's
 * accounts (an attached Gmail's calendar shared with the login account). The
 * copy Chord keeps belongs to the account it was written with; the other
 * account's pull must neither take it over (its writes would then go out with
 * the wrong token) nor add a second row for it.
 */
function onOtherAccount(
  row: { google_calendar_id: string | null } | undefined,
  calendarId: string,
): boolean {
  return !!row?.google_calendar_id && calendarAccount(row.google_calendar_id) !== calendarAccount(calendarId);
}

async function findLocalCopy(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
  remote: GoogleEventResource,
): Promise<Selectable<EventsTable> | typeof OTHER_ACCOUNT | undefined> {
  // ADR 0217 — every instance of a series shares the master's iCalUID and
  // chordUid, so those keys name the SERIES, not this occurrence. Matching on
  // them made each instance overwrite the previous one's row.
  if (remote.recurringEventId) return findLocalInstance(db, userId, calendarId, remote);
  const chordUid = remote.extendedProperties?.private?.chordUid ?? null;
  const uid = remote.iCalUID || remote.id;
  const row = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', userId)
    .where((eb) =>
      eb.or([
        // `chord_uid` is our own stamp on an event we pushed, so it identifies
        // the row wherever Google has since moved it. Deliberately NOT scoped
        // by calendar, unlike everything below.
        ...(chordUid ? [eb('chord_uid', '=', chordUid)] : []),
        eb.and([
          eb.or([
            eb('gcal_event_id', '=', remote.id),
            eb('ical_uid', '=', uid),
            // The invite UID may live in external_uid rather than ical_uid: a
            // row created from a calendar-invite email is stamped with the
            // RFC-5545 UID there, and a push (before invites stopped pushing)
            // overwrote ical_uid with Google's UID for OUR copy. The create
            // side already looks in both columns for this value; without the
            // arm the accepted invite arrives as a twin.
            eb('external_uid', '=', uid),
            // ADR 0328 — a member's row for a group event they were invited
            // to: the invitation arrives under the organizer's event's UID,
            // not Chord's key, and this row is how the member already has it.
            eb('invite_uid', '=', uid),
            // Bridge rows synced by the legacy read sync, which stored the
            // Google id in external_uid (`gcal:<id>` primary,
            // `gcal:<calId>:<id>` secondary) and left gcal_event_id/ical_uid
            // on the old scheme — so the first new pull dedups against them
            // instead of inserting a duplicate.
            eb('external_uid', '=', `gcal:${remote.id}`),
            eb('external_uid', '=', `gcal:${calendarId}:${remote.id}`),
          ]),
          // Every key above is shared by the SAME logical event on DIFFERENT
          // calendars — subscribe to a feed that a shared calendar also
          // carries and both copies hold one ical_uid. Unscoped, pulling one
          // calendar matched the other calendar's row and `applyRemoteToLocal`
          // tried to move it onto a (calendar, event) pair its sibling already
          // held, so the Google-link unique index aborted the whole pass and
          // that calendar silently stopped syncing. A row not yet bound to any
          // calendar still matches — that is how an invite adopts its Google
          // identity on arrival.
          eb.or([
            eb('google_calendar_id', '=', calendarId),
            eb('google_calendar_id', 'is', null),
          ]),
        ]),
      ]),
    )
    .executeTakeFirst();
  return onOtherAccount(row, calendarId) ? OTHER_ACCOUNT : row;
}

/**
 * The row for one instance of a repeating Google event: its own instance id,
 * else (for a series Chord created) the materialized occurrence of that series
 * with the same original start, which this pull then adopts.
 */
async function findLocalInstance(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
  remote: GoogleEventResource,
): Promise<Selectable<EventsTable> | typeof OTHER_ACCOUNT | undefined> {
  const byId = await db
    .selectFrom('events')
    .selectAll()
    .where('owner_user_id', '=', userId)
    .where('gcal_event_id', '=', remote.id)
    .where((eb) =>
      eb.or([eb('google_calendar_id', '=', calendarId), eb('google_calendar_id', 'is', null)]),
    )
    .executeTakeFirst();
  if (byId) return byId;

  const series = await db
    .selectFrom('event_series')
    .select(['id', 'google_calendar_id'])
    .where('owner_user_id', '=', userId)
    .where('gcal_event_id', '=', remote.recurringEventId!)
    .executeTakeFirst();
  if (!series) return undefined;
  if (onOtherAccount(series, calendarId)) return OTHER_ACCOUNT;
  const original = googleDateTimeToIso(remote.originalStartTime).iso;
  if (!original) return undefined;
  const wanted = instantMs(original);
  const candidates = await db
    .selectFrom('events')
    .selectAll()
    .where('series_id', '=', series.id)
    .where('owner_user_id', '=', userId)
    .where('gcal_event_id', 'is', null)
    .execute();
  return candidates.find((c) => c.original_start && instantMs(c.original_start) === wanted);
}

/** Overwrite a local copy's content from Google. Leaves ownership/scope
 *  (owner_user_id, group_ids, role) untouched and clears the dirty flag. Stamps
 *  google_calendar_id so a legacy row adopts the new identity scheme. */
async function applyRemoteToLocal(
  db: Kysely<DB>,
  eventId: string,
  remote: GoogleEventResource,
  calendarId: string,
): Promise<void> {
  const f = googleEventToLocalFields(remote);
  // ADR 0217 — an instance's iCalUID and chordUid are the SERIES', identical
  // across every occurrence; writing them here would give all occurrences one
  // ical_uid, and an edit to one would fan out to all of them.
  //
  // An event Chord made (it carries our chordUid) keeps Chord's key, as in
  // `markPushed`; anything else (an invite, an event made in Google) takes
  // the provider's, which is how an adopted invite gets its real UID.
  const identity = remote.recurringEventId
    ? {}
    : f.chord_uid
      ? { ical_uid: sql<string>`coalesce(ical_uid, ${f.ical_uid})`, chord_uid: f.chord_uid }
      : { ical_uid: f.ical_uid, chord_uid: f.chord_uid };
  await db
    .updateTable('events')
    .set({
      // starts_at is NOT NULL; only overwrite when Google gave us one.
      ...(f.starts_at ? { starts_at: f.starts_at } : {}),
      title: f.title,
      description: f.description,
      location: f.location,
      ends_at: f.ends_at,
      start_tz: f.start_tz,
      end_tz: f.end_tz,
      all_day: f.all_day,
      status: f.status,
      transparency: f.transparency,
      // A provider with no sequence (Outlook) says nothing about ours.
      ...(typeof remote.sequence === 'number' ? { sequence: f.sequence } : {}),
      etag: f.etag,
      gcal_event_id: f.gcal_event_id,
      google_calendar_id: calendarId,
      ...identity,
      recurring_event_id: f.recurring_event_id,
      original_start: f.original_start,
      guest_emails: f.guest_emails ? JSON.stringify(f.guest_emails) : null,
      updated_at: remote.updated ?? new Date().toISOString(),
      gcal_sync_status: 'synced',
      gcal_synced_at: new Date().toISOString(),
      local_dirty: 0,
    })
    .where('id', '=', eventId)
    .execute();
}

async function insertLocalFromRemote(
  db: Kysely<DB>,
  userId: string,
  legacyGroupId: string,
  calendarId: string,
  remote: GoogleEventResource,
  /** ADR 0217 — an instance of a Chord series with no occurrence row yet (the
   *  series was edited in Google): join the series rather than float free. */
  series?: Selectable<EventSeriesTable>,
): Promise<void> {
  const f = googleEventToLocalFields(remote);
  if (!f.starts_at) return; // undated event — nothing to place on a calendar
  const ours = isChordOrigin(remote);
  const now = new Date().toISOString();
  const original = f.original_start ?? f.starts_at;
  await db
    .insertInto('events')
    .values({
      id: newId('e'),
      // group_id is the legacy NOT NULL column; group_ids '[]' is the new truth
      // (a pulled calendar event isn't surfaced in any chat).
      group_id: series?.group_id ?? legacyGroupId,
      group_ids: JSON.stringify(series?.group_ids ?? []),
      owner_user_id: userId,
      organizer_user_id: series ? series.organizer_user_id ?? null : ours ? userId : null,
      role: series ? series.role : ours ? 'organizer' : 'attendee',
      google_calendar_id: calendarId,
      created_by: userId,
      created_at: now,
      updated_at: remote.updated ?? now,
      title: f.title,
      description: f.description,
      location: f.location,
      starts_at: f.starts_at,
      ends_at: f.ends_at,
      start_tz: f.start_tz,
      end_tz: f.end_tz,
      all_day: f.all_day,
      status: f.status,
      transparency: f.transparency,
      ical_uid: f.ical_uid,
      chord_uid: f.chord_uid,
      gcal_event_id: f.gcal_event_id,
      etag: f.etag,
      sequence: f.sequence,
      recurring_event_id: f.recurring_event_id,
      original_start: f.original_start,
      guest_emails: f.guest_emails ? JSON.stringify(f.guest_emails) : null,
      gcal_synced_at: now,
      gcal_sync_status: 'synced',
      local_dirty: 0,
      ...(series
        ? {
            series_id: series.id,
            ical_uid: occurrenceUid(series.series_uid, localWallOf(original, series.tz)),
            chord_uid: null,
          }
        : {}),
    })
    .execute();
}

/**
 * Pull one calendar's changes and reconcile each against the local copy via the
 * core decision tree. Persists the new syncToken so the next run is incremental.
 */
export async function pullCalendarChanges(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
  accessToken?: string,
  /** The provider client to use; resolved from `calendarId` when omitted. */
  given?: CalendarTransport,
): Promise<PullResult> {
  const result: PullResult = { inserted: 0, applied: 0, deleted: 0, pushBack: 0, noop: 0, failed: 0 };
  const transport =
    given ??
    (isOutlookCalendarKey(calendarId)
      ? await outlookCalendarApiForKey(db, userId, calendarId)
      : isGmailCalendarKey(calendarId)
        ? await gmailCalendarApiForKey(db, userId, calendarId)
        : googleCalendarTransport(accessToken ?? (await getAccessToken(db, userId))));
  if (!transport) throw new Error(`calendar ${calendarId} is not connected`);
  const source = await db
    .selectFrom('calendar_sources')
    .select(['id', 'sync_token', 'full_synced_at'])
    .where('user_id', '=', userId)
    .where('google_calendar_id', '=', calendarId)
    .executeTakeFirst();

  const pullStartedAt = Date.now();
  const cursorFresh =
    !!source?.full_synced_at && pullStartedAt - Date.parse(source.full_synced_at) < FULL_RESYNC_MS;
  const { items, nextSyncToken, wasFullSync } = await transport.listChanges(
    calendarId,
    cursorFresh ? (source?.sync_token ?? null) : null,
  );
  const personalGroup = await ensurePersonalGroup(db, userId);
  // Read once per pull, and only if a device twin needs comparing.
  let tzRead: Promise<string | null> | undefined;
  const userTz = () =>
    (tzRead ??= db
      .selectFrom('users')
      .select('last_tz')
      .where('id', '=', userId)
      .executeTakeFirst()
      .then((r) => r?.last_tz ?? null));

  // One event is reconciled on its own so a single bad item — a key
  // collision, a malformed payload — cannot abort the calendar. Before this,
  // one uq_events_gcal_event violation threw out of the whole loop and that
  // calendar simply stopped syncing, silently, on every pass.
  const reconcileOne = async (remote: GoogleEventResource): Promise<void> => {
    // An invitation answered anywhere is answered everywhere (ADR 0104). The
    // decline branch below already retracts by UID; an ACCEPT used to leave the
    // Chord suggestion pending, so the same meeting sat on the calendar and in
    // Action Items still asking whether to add it. `needsAction` is left alone
    // on purpose — that one is genuinely still waiting on the user, and its
    // card is one of the places they can answer from.
    if (remote.iCalUID && selfResponded(remote) && !selfDeclined(remote)) {
      await retractPendingProposalsByUid(db, userId, remote.iCalUID);
    }
    const found = await findLocalCopy(db, userId, calendarId, remote);
    if (found === OTHER_ACCOUNT) {
      result.noop++;
      return;
    }
    const local = found;
    // ADR 0328 — the organizer's calendar is where guests' answers land, so
    // its sync is where Chord learns who is coming.
    if (local && local.owner_user_id === userId && local.role === 'organizer' && remote.organizer?.self !== false && remote.attendees) {
      await recordGuestAnswers(db, local.id, remote.attendees);
    }
    // Declined by the user: Google keeps the event on the calendar (struck
    // through, still status 'confirmed'), but Chord must not surface a
    // meeting the user said no to. Drop any local copy, retract the invite
    // suggestion (by UID, plus any keyless email-derived proposal for the
    // slot). A later re-accept arrives as a normal update and re-inserts.
    if (selfDeclined(remote)) {
      await retractPendingProposalsByUid(db, userId, remote.iCalUID ?? remote.id);
      const df = googleEventToLocalFields(remote);
      let removed = 0;
      const goneRows: Selectable<EventsTable>[] = [];
      if (df.starts_at && !df.all_day) {
        const people = remotePeople(remote);
        await retractPendingEmailEventProposalsNear(db, userId, df.starts_at, df.title, people);
        // A keyless email-made event that looks like the declined meeting is
        // asked about, never removed here (ADR 0344): removing a pushed one
        // emails its guests a cancellation.
        const twin = await findEmailEventTwin(db, userId, df.starts_at, df.title, people);
        if (twin && twin.id !== local?.id) {
          await askAboutEmailTwin(db, {
            userId,
            twin,
            incoming: { title: df.title, startsAt: df.starts_at },
            how: 'declined',
          });
        }
      }
      if (local) {
        await db.deleteFrom('events').where('id', '=', local.id).execute();
        goneRows.push(local);
        removed++;
      }
      // ADR 0192 — a meeting the user said no to takes its prep to-dos with it.
      await retireTasksForRemovedEvents(db, goneRows);
      if (removed) result.deleted += removed;
      else result.noop++;
      return;
    }
    if (!local) {
      if ((remote.status ?? 'confirmed') === 'cancelled') {
        // A removed series is reported once, by its master's id. The rows we
        // hold are its occurrences, so they go with it. (A series Chord made
        // is left to Chord: its rows belong to an `event_series`.)
        const occurrences = await db
          .selectFrom('events')
          .selectAll()
          .where('owner_user_id', '=', userId)
          .where('google_calendar_id', '=', calendarId)
          .where('recurring_event_id', '=', remote.id)
          .where('series_id', 'is', null)
          .where('local_dirty', '!=', 1)
          .execute();
        if (occurrences.length > 0) {
          await db
            .deleteFrom('events')
            .where('id', 'in', occurrences.map((o) => o.id))
            .execute();
          await retireTasksForRemovedEvents(db, occurrences);
          result.deleted += occurrences.length;
        } else {
          result.noop++;
        }
        return;
      }
      // Past the window: not stored. The daily re-list brings it in once it
      // comes within a year. (One already held is still updated below.)
      if (occurrenceBeyondWindow(remote, pullStartedAt)) {
        result.noop++;
        return;
      }
      // Another member's copy of a group event the user has their own copy
      // of, seen through that member's calendar the user subscribes to: the
      // same logical event, not a second one (ADR 0040 addendum 2026-10-23).
      const theirChordUid = remote.extendedProperties?.private?.chordUid;
      if (theirChordUid && (await isAnotherMembersCopyOfMine(db, userId, theirChordUid))) {
        result.noop++;
        return;
      }
      // A real calendar item arriving for a slot Chord already filled from a
      // plain-email agreement retracts any still-pending email card for it.
      // An email-made EVENT it looks like is asked about once the item is in
      // (ADR 0344, reversing ADR 0074's automatic takeover): taking it over
      // deleted Chord's pushed copy, and its guests got a cancellation.
      // Our own event is never an invite for one of our other rows.
      const rf = googleEventToLocalFields(remote);
      const timed = !!rf.starts_at && !rf.all_day && !isChordOrigin(remote);
      let emailTwin: Selectable<EventsTable> | undefined;
      if (timed) {
        const people = remotePeople(remote);
        emailTwin = await findEmailEventTwin(db, userId, rf.starts_at!, rf.title, people);
        await retractPendingEmailEventProposalsNear(db, userId, rf.starts_at!, rf.title, people);
      }
      // ADR 0217 — the item IS one of our series masters: a one-off Chord
      // just turned into a series, seen before the push patched the rule on.
      // Its row moved into the series; inserting would duplicate it.
      const series = await db
        .selectFrom('event_series')
        .selectAll()
        .where('owner_user_id', '=', userId)
        .where('gcal_event_id', '=', remote.recurringEventId ?? remote.id)
        .executeTakeFirst();
      if (series && !remote.recurringEventId) {
        result.noop++;
        return;
      }
      await dropDeviceTwin(db, userId, rf, userTz);
      await insertLocalFromRemote(db, userId, personalGroup.id, calendarId, remote, series);
      result.inserted++;
      if (emailTwin) {
        await askAboutEmailTwin(db, {
          userId,
          twin: emailTwin,
          incoming: { title: rf.title, startsAt: rf.starts_at! },
          how: 'arrived',
        });
      }
      return;
    }
    // ADR 0217 — Google's instance for an occurrence Chord already edited:
    // take Google's identity so the edit can be pushed to that instance, and
    // keep the edit (it is newer than the rule Google expanded from).
    if (local.series_id && !local.gcal_event_id && local.local_dirty === 1) {
      await db
        .updateTable('events')
        .set({
          gcal_event_id: remote.id,
          etag: remote.etag ?? null,
          google_calendar_id: calendarId,
          recurring_event_id: remote.recurringEventId ?? null,
        })
        .where('id', '=', local.id)
        .execute();
      result.pushBack++;
      return;
    }
    // A legacy row matched via the external_uid bridge (no gcal_event_id yet)
    // and with no pending local edit: heal it to the new identity scheme rather
    // than running the sequence/LWW compare against its backfilled timestamps.
    if (!local.gcal_event_id && local.local_dirty !== 1 && remote.status !== 'cancelled') {
      await applyRemoteToLocal(db, local.id, remote, calendarId);
      result.applied++;
      return;
    }
    const action = reconcileRemote(rowToLocalCopy(local), {
      sequence: remote.sequence ?? local.sequence,
      updated: remote.updated ?? new Date(0).toISOString(),
      status: remote.status ?? 'confirmed',
    });
    switch (action.kind) {
      case 'delete-local':
        await forgetOccurrence(db, local);
        await db.deleteFrom('events').where('id', '=', local.id).execute();
        await retireTasksForRemovedEvents(db, [local]);
        result.deleted++;
        break;
      case 'apply-remote':
        await applyRemoteToLocal(db, local.id, remote, calendarId);
        result.applied++;
        break;
      case 'conflict-resolved':
        if (action.winner === 'remote') {
          await applyRemoteToLocal(db, local.id, remote, calendarId);
          result.applied++;
        } else {
          await markLocalDirty(db, local.id);
          result.pushBack++;
        }
        break;
      case 'push-local':
        await markLocalDirty(db, local.id);
        result.pushBack++;
        break;
      default:
        result.noop++;
    }
  };

  for (const remote of items) {
    try {
      await reconcileOne(remote);
    } catch (err) {
      result.failed++;
      logger.warn(
        `two-way pull item failed cal=${calendarId} user=${userId} event=${remote.id}: ${(err as Error).message}`,
      );
    }
  }

  // Reverse-delete (full sync only): Google omits deleted events from a
  // non-incremental list, so an event the user deleted in Google is simply
  // ABSENT — a delta would have carried a `cancelled` tombstone, but a full
  // window sync won't. Converge any in-window synced row for this calendar that
  // the snapshot doesn't contain. Delta runs skip this (absence is meaningless
  // there). Without it, a Google-side delete that lands while our token is stale
  // never clears — the row keeps rendering and nudging.
  if (wasFullSync) {
    result.deleted += await reverseDeleteAbsent(db, userId, calendarId, items);
  }

  // Persist the cursor only when Google handed us a fresh one. A full sync that
  // paged to the end returns it; an empty delta also returns it unchanged.
  // Not when an item failed, though (ADR 0200): the next delta would omit that
  // unchanged event, so advancing past it drops it for good, silently.
  if (source && nextSyncToken && result.failed === 0) {
    await db
      .updateTable('calendar_sources')
      .set({
        sync_token: nextSyncToken,
        ...(wasFullSync ? { full_synced_at: new Date(pullStartedAt).toISOString() } : {}),
      })
      .where('id', '=', source.id)
      .execute();
  }
  return result;
}

/**
 * ADR 0228 / ADR 0057 addendum — the phone often shows the same Google or
 * Outlook calendar, and its mirror (ADR 0057) may have put this event in Chord
 * first. The device sync skips an event the server already holds, but only
 * when the server copy came first; here the server copy is arriving second, so
 * the phone's copy is removed and the next device sync skips it as usual.
 *
 * Matched on the calendar UID, else on the title and the same start (an
 * instant, or for an all-day event the date) — the keys the device sync uses.
 */
async function dropDeviceTwin(
  db: Kysely<DB>,
  userId: string,
  f: { ical_uid: string; starts_at: string | null; all_day?: number | null; title: string },
  userTz: () => Promise<string | null>,
): Promise<void> {
  if (!f.starts_at) return;
  const startsAt = f.starts_at;
  const candidates = await db
    .selectFrom('events')
    .select(['id', 'ical_uid', 'starts_at', 'all_day', 'title'])
    .where('owner_user_id', '=', userId)
    .where('external_uid', 'like', 'device:%')
    .where((eb) =>
      eb.or([
        eb('ical_uid', '=', f.ical_uid),
        eb(sql<string>`lower(btrim(title))`, '=', f.title.trim().toLowerCase()),
      ]),
    )
    .execute();
  if (candidates.length === 0) return;
  const tz = await userTz();
  const remote = { startsAt, allDay: rowIsAllDay({ starts_at: startsAt, all_day: f.all_day }) };
  const twins = candidates.filter(
    (c) =>
      c.ical_uid === f.ical_uid ||
      sameEventStart({ startsAt: c.starts_at, allDay: rowIsAllDay(c) }, remote, tz),
  );
  if (twins.length === 0) return;
  await db
    .deleteFrom('events')
    .where('id', 'in', twins.map((t) => t.id))
    .execute();
}

async function markLocalDirty(db: Kysely<DB>, eventId: string): Promise<void> {
  await db
    .updateTable('events')
    .set({ local_dirty: 1, gcal_sync_status: 'pending' })
    .where('id', '=', eventId)
    .execute();
}

/** The Google event id carried by a local row: the new-scheme `gcal_event_id`,
 *  else parsed from a legacy `gcal:[<calId>:]<id>` external_uid. */
function gcalEventIdOf(row: {
  gcal_event_id: string | null;
  external_uid: string | null;
}): string | null {
  if (row.gcal_event_id) return row.gcal_event_id;
  const uid = row.external_uid;
  if (!uid?.startsWith('gcal:')) return null;
  const rest = uid.slice('gcal:'.length);
  const i = rest.indexOf(':');
  return i === -1 ? rest : rest.slice(i + 1);
}

/**
 * Delete local synced rows for `calendarId` that a full-sync snapshot doesn't
 * contain — they were removed on Google. Scoped tightly to stay safe:
 *   - only rows linked to THIS calendar (new-scheme google_calendar_id, or a
 *     legacy `gcal:<calId>:` external_uid),
 *   - only inside the sync window (out-of-window rows aren't in the snapshot but
 *     weren't deleted),
 *   - never a row with a pending local edit (`local_dirty=1`) or an unresolvable
 *     Google id (can't prove it's gone).
 */
async function reverseDeleteAbsent(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
  presentItems: GoogleEventResource[],
): Promise<number> {
  const presentIds = new Set(
    presentItems.map((i) => i.id).filter((v): v is string => !!v),
  );
  const now = Date.now();
  const windowMin = now - PAST_DAYS * 86_400_000;
  const windowMax = now + FUTURE_DAYS * 86_400_000;

  const candidates = await db
    .selectFrom('events')
    .select([
      'id',
      'gcal_event_id',
      'external_uid',
      'starts_at',
      'ends_at',
      'owner_user_id',
      'source_raw_context',
      'series_id',
      'original_start',
    ])
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'cancelled')
    .where('local_dirty', '!=', 1)
    .where((eb) =>
      eb.or([
        eb('google_calendar_id', '=', calendarId),
        eb('external_uid', 'like', `gcal:${calendarId}:%`),
      ]),
    )
    .execute();

  let deleted = 0;
  for (const row of candidates) {
    const startMs = Date.parse(row.starts_at);
    if (Number.isFinite(startMs) && (startMs < windowMin || startMs > windowMax)) continue;
    const gid = gcalEventIdOf(row);
    if (!gid || presentIds.has(gid)) continue;
    await forgetOccurrence(db, row);
    await db.deleteFrom('events').where('id', '=', row.id).execute();
    await retireTasksForRemovedEvents(db, [row]);
    deleted++;
  }
  return deleted;
}

// ── discovery ───────────────────────────────────────────────────────────────

interface GcalCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  selected?: boolean;
  accessRole?: string;
}

/**
 * Refresh `calendar_sources` from Google's calendarList (so the busyness policy
 * stays current — ADR 0033) and return the readable calendars to pull. Mirrors
 * the discovery the legacy `syncPrimaryCalendar` did; lives here so the two-way
 * path no longer depends on the legacy read sync to populate calendar_sources.
 */
async function discoverCalendars(
  db: Kysely<DB>,
  userId: string,
  accessToken: string,
): Promise<Array<{ id: string; primary: boolean }>> {
  const userRow = await db
    .selectFrom('users')
    .select('google_calendar_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  const chordTargetId = userRow?.google_calendar_id ?? null;

  const entries: GcalCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ maxResults: '250' });
    if (pageToken) p.set('pageToken', pageToken);
    const res = await gfetch(`${CAL_BASE}/users/me/calendarList?${p.toString()}`, accessToken);
    if (!res.ok) throw new Error(`calendarList.list ${res.status}`);
    const json = (await res.json()) as { items?: GcalCalendarListEntry[]; nextPageToken?: string };
    entries.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  const out: Array<{ id: string; primary: boolean }> = [];
  for (const c of entries) {
    const role = c.accessRole;
    if (role !== 'reader' && role !== 'writer' && role !== 'owner') continue; // skip freeBusyReader/none
    await upsertCalendarSource(db, userId, {
      googleCalendarId: c.id,
      summary: c.summary ?? null,
      accessRole: role as 'reader' | 'writer' | 'owner',
      isPrimary: !!c.primary,
      selectedInGoogle: c.selected !== false,
      isChordTarget: chordTargetId !== null && c.id === chordTargetId,
    });
    out.push({ id: c.id, primary: !!c.primary });
  }
  return out;
}

// ── orchestration ───────────────────────────────────────────────────────────

export interface TwoWaySyncResult {
  push: PushResult;
  pull: Record<string, PullResult>;
}

/**
 * One full reconcile pass for a user: push local edits first (so they land on
 * the provider before we read), then for each connected provider discover its
 * calendar list and pull each readable calendar's changes. Stamps
 * `google_calendar_synced_at` for the caller-side throttle
 * (`maybeSyncCalendar`).
 *
 * Google and each Outlook mailbox are independent (ADR 0228): one failing does
 * not stop the others. A Google failure is still thrown at the end, as it
 * always was, so a dead token reaches the caller.
 */
const twoWayRuns = coalescePerKey<TwoWaySyncResult>();

/** One reconcile at a time per user: the calendar screen, the sweep, the bot
 *  and a create's background push can all ask at once. A caller arriving
 *  mid-pass joins one follow-up pass, so its own edits are still pushed. */
export function syncTwoWay(db: Kysely<DB>, userId: string): Promise<TwoWaySyncResult> {
  return twoWayRuns(userId, () => syncTwoWayPass(db, userId));
}

async function syncTwoWayPass(db: Kysely<DB>, userId: string): Promise<TwoWaySyncResult> {
  const outlook = await outlookCalendarAccounts(db, userId);
  const gmailAccounts = await gmailCalendarAccounts(db, userId);
  // Other providers that can carry on when the login Google fails.
  const others = outlook.length + gmailAccounts.length;
  const googleOn = await hasCalendarScope(db, userId);
  const pull: Record<string, PullResult> = {};
  let push: PushResult = { created: 0, updated: 0, deleted: 0, errored: 0 };
  let googleError: unknown = null;

  try {
    push = await pushDirtyEvents(db, userId);
  } catch (err) {
    if (others === 0) throw err;
    googleError = err;
  }

  // With no Outlook calendar this runs whether or not the scope is on record,
  // which is what it always did: the caller gates, and a dead token throws.
  if (!googleError && (googleOn || others === 0)) {
    try {
      const accessToken = await getAccessToken(db, userId);
      const calendars = await discoverCalendars(db, userId, accessToken);
      for (const c of calendars) {
        try {
          pull[c.id] = await pullCalendarChanges(db, userId, c.id, accessToken);
        } catch (err) {
          logger.warn(`two-way pull failed cal=${c.id} user=${userId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      if (others === 0) throw err;
      googleError = err;
    }
  }

  for (const account of outlook) {
    try {
      const api = await outlookCalendarApiFor(db, userId, account.id);
      if (!api) continue;
      for (const key of await discoverOutlookCalendars(db, userId, account, api)) {
        try {
          pull[key] = await pullCalendarChanges(db, userId, key, undefined, api);
        } catch (err) {
          logger.warn(`two-way pull failed cal=${key} user=${userId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`outlook calendar sync failed account=${account.id}: ${(err as Error).message}`);
    }
  }

  // ADR 0313 — each attached Gmail's own calendars, on its own token.
  for (const account of gmailAccounts) {
    try {
      const token = await gmailCalendarAccessToken(db, userId, account.id);
      if (!token) continue;
      const api = gmailAccountTransport(account.id, token);
      for (const key of await discoverGmailAccountCalendars(db, userId, account, token)) {
        try {
          pull[key] = await pullCalendarChanges(db, userId, key, undefined, api);
        } catch (err) {
          logger.warn(`two-way pull failed cal=${key} user=${userId}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`gmail account calendar sync failed account=${account.id}: ${(err as Error).message}`);
    }
  }

  await db
    .updateTable('users')
    .set({ google_calendar_synced_at: new Date().toISOString() })
    .where('id', '=', userId)
    .execute();
  if (googleError) throw googleError;
  return { push, pull };
}

// Re-export the status type for callers that build reconcile inputs.
export type { EventStatus };
