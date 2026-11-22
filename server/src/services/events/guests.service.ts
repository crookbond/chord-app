/**
 * ADR 0295 — an event's guests live on the provider event (Google / Outlook),
 * never in Chord. Adding or removing one reads the event from the provider,
 * changes its `attendees` list and sends it back with notifications on, so
 * the provider mails the invitation or the "removed" notice itself.
 *
 * Every outcome is a result, not a throw: the caller (a bot tool) must only
 * say someone was invited when the provider took the change.
 */
import type { Kysely, Selectable } from 'kysely';

import { logger } from '@/config/logging.js';
import type { DB, EventsTable } from '@/db/schema.js';
import { hasCalendarWriteScope } from '@/services/google/calendar-write.service.js';
import { pushDirtyEvents, eventCalendarTransport } from '@/services/google/two-way-sync.service.js';
import { nextAttendees, type GoogleAttendee } from '@/services/google/two-way-sync.js';
import { waitForBackgroundPush } from '@/services/events.service.js';
import { recordGuestAnswers } from '@/services/events/guest-answers.js';
import { calendarConnection } from '@/services/outlook-calendar/accounts.js';
import { isOutlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { videoCallDefaultFor, videoCallLabel, type VideoCallKind } from '@chord/kernel';

export type GuestChangeResult =
  | {
      ok: true;
      /** Newly on the event. */
      added: string[];
      /** Taken off the event. */
      removed: string[];
      /** Asked to add, already a guest. */
      alreadyInvited: string[];
      /** Asked to remove, not a guest. */
      notInvited: string[];
      /** The provider event's iCalUID: what a guest's own calendar files the
       *  invitation under (ADR 0328). */
      iCalUid?: string;
    }
  | {
      ok: false;
      /**
       * - `not_found`: no such event.
       * - `not_organizer`: someone else organizes it (or this is a member's
       *   copy of someone else's group event): only the organizer can change
       *   who is invited.
       * - `not_on_calendar`: the event is only in Chord (no calendar connected,
       *   or it has not reached the calendar), so there is nobody to send
       *   invitations.
       * - `provider_error`: the calendar refused or could not be reached.
       */
      reason: 'not_found' | 'not_organizer' | 'not_on_calendar' | 'provider_error';
    };

type Row = Selectable<EventsTable>;

/** A member's copy of someone else's fanned-out group event (ADR 0040 §7). */
function isReflection(row: Row): boolean {
  return !!row.organizer_user_id && row.organizer_user_id !== row.owner_user_id;
}

/**
 * The row whose provider event carries the guests: the organizer's own copy.
 * A member's reflection points at the organizer's copy when it can still be
 * found (they share `ical_uid` until pushed).
 */
async function organizerRow(db: Kysely<DB>, row: Row): Promise<Row | null> {
  if (!isReflection(row)) return row;
  if (!row.ical_uid) return null;
  return (
    (await db
      .selectFrom('events')
      .selectAll()
      .where('ical_uid', '=', row.ical_uid)
      .where('owner_user_id', '=', row.organizer_user_id!)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()) ?? null
  );
}

async function loadRow(db: Kysely<DB>, eventId: string): Promise<Row | undefined> {
  return db.selectFrom('events').selectAll().where('id', '=', eventId).executeTakeFirst();
}

/**
 * A just-made or just-edited event reaches the provider in a background push.
 * Wait for it, and push once more if it has still not gone, so a guest can be
 * added in the same turn the event was created.
 */
async function ensureOnProvider(db: Kysely<DB>, row: Row): Promise<Row> {
  if (!row.owner_user_id) return row;
  // Also orders a guest change after an edit made in the same turn, whose
  // push carries the event's stored etag.
  await waitForBackgroundPush(row.owner_user_id);
  let fresh = (await loadRow(db, row.id)) ?? row;
  if (fresh.gcal_event_id) return fresh;
  await pushDirtyEvents(db, fresh.owner_user_id!).catch((err) => {
    logger.warn('guest change: push before invite failed', { err: String(err), eventId: row.id });
  });
  fresh = (await loadRow(db, row.id)) ?? fresh;
  return fresh;
}

export async function changeEventGuests(
  db: Kysely<DB>,
  args: { eventId: string; actorUserId: string; add?: string[]; remove?: string[] },
): Promise<GuestChangeResult> {
  const add = args.add ?? [];
  const remove = args.remove ?? [];
  const asked = await loadRow(db, args.eventId);
  if (!asked) return { ok: false, reason: 'not_found' };
  const target = await organizerRow(db, asked);
  // Only the organizer changes who is invited: a guest change on their
  // calendar mails people in their name.
  if (!target || target.owner_user_id !== args.actorUserId) return { ok: false, reason: 'not_organizer' };

  const row = await ensureOnProvider(db, target);
  if (!row.gcal_event_id || !row.owner_user_id) return { ok: false, reason: 'not_on_calendar' };
  const where = await eventCalendarTransport(db, row.owner_user_id, row);
  if (!where) return { ok: false, reason: 'not_on_calendar' };

  try {
    const remote = await where.transport.get(where.calendarId, row.gcal_event_id);
    if (!remote) return { ok: false, reason: 'provider_error' };
    if (remote.organizer && remote.organizer.self === false) return { ok: false, reason: 'not_organizer' };

    const next = nextAttendees(remote.attendees, add, remove);
    const before = new Set(
      (remote.attendees ?? []).map((a: GoogleAttendee) => a.email?.trim().toLowerCase()).filter(Boolean),
    );
    const alreadyInvited = add.map((e) => e.trim().toLowerCase()).filter((e) => before.has(e));
    const notInvited = remove.map((e) => e.trim().toLowerCase()).filter((e) => !before.has(e));
    if (next.added.length === 0 && next.removed.length === 0) {
      return { ok: true, added: [], removed: [], alreadyInvited, notInvited, iCalUid: remote.iCalUID };
    }

    const written = await where.transport.patch(
      where.calendarId,
      row.gcal_event_id,
      { attendees: next.attendees },
      { notify: true },
    );
    if (written === 'stale') return { ok: false, reason: 'provider_error' };
    // ADR 0328 — the guest list with each answer, so a just-invited guest
    // shows as "not answered" before any sync runs.
    await recordGuestAnswers(db, row.id, next.attendees);
    // Keep the stored etag current so Chord's next edit is not refused as
    // stale because of a change it made itself.
    await db
      .updateTable('events')
      .set({
        etag: written.etag ?? row.etag,
        ...(typeof written.sequence === 'number' ? { sequence: written.sequence } : {}),
      })
      .where('id', '=', row.id)
      .execute();
    return {
      ok: true,
      added: next.added,
      removed: next.removed,
      alreadyInvited,
      notInvited,
      iCalUid: remote.iCalUID,
    };
  } catch (err) {
    logger.error('guest change failed', { err: String(err), eventId: row.id });
    return { ok: false, reason: 'provider_error' };
  }
}

export type VideoCallResult =
  | { ok: true; kind: VideoCallKind; link: string | null; already: boolean }
  | {
      ok: false;
      /**
       * - `no_video_call`: this calendar's provider has none Chord can
       *   create — a phone-mirrored calendar, which Chord reads and does not
       *   write, or a provider added since ADR 0323.
       * - `teams_unavailable`: an Outlook calendar that does not offer Teams
       *   (a personal account, or a tenant without the licence).
       */
      reason:
        | 'not_found'
        | 'not_organizer'
        | 'not_on_calendar'
        | 'no_video_call'
        | 'teams_unavailable'
        | 'provider_error';
    };

/**
 * ADR 0319 — the calendar key an event's provider copy lives on, by the same
 * convention `calendarColorResolver` / `calIdOf` use: an explicit
 * `google_calendar_id` wins, else a `gcal:`/`outlook:` prefixed `external_uid`
 * says which calendar pulled it. Null = no provider calendar at all
 * (Chord-only, or mirrored from a phone).
 */
function calendarKeyOf(row: Pick<Row, 'google_calendar_id' | 'external_uid'>): string | null {
  if (row.google_calendar_id) return row.google_calendar_id;
  const uid = row.external_uid ?? '';
  if (uid.startsWith('gcal:')) {
    const rest = uid.slice('gcal:'.length);
    const sep = rest.indexOf(':');
    // A bare `gcal:<eventId>` is the login account's primary calendar.
    return sep === -1 ? 'primary' : rest.slice(0, sep);
  }
  if (isOutlookCalendarKey(uid)) return uid;
  return null;
}

/**
 * ADR 0319/0323 — the video call this event's calendar can be given, or null
 * for none. One lookup, so the bot's default, the calendar write and the
 * event editor cannot disagree about what a 365 or phone calendar can do.
 *
 * It asks no provider: this runs on every read of an event's guests, and a
 * round trip there is the per-request cost ADR 0204 took out. So for Outlook
 * it answers what the provider OFFERS, and whether that tenant licenses Teams
 * is settled at the write (`addVideoCall`), honestly.
 */
export async function eventVideoCallOption(db: Kysely<DB>, eventId: string): Promise<VideoCallKind | null> {
  const asked = await loadRow(db, eventId);
  if (!asked) return null;
  const target = await organizerRow(db, asked);
  if (!target) return null;
  const key = calendarKeyOf(target);
  const kind = videoCallDefaultFor({ calendarId: key });
  if (!kind || !target.owner_user_id) return null;
  // The key names a provider; a connection behind it is what makes it real.
  // A mailbox with no calendar of its own (an IMAP account) still carries
  // `primary` as its target, and its events live in Chord alone.
  if (kind === 'teams') {
    return (await calendarConnection(db, target.owner_user_id, key!)).state === 'connected' ? 'teams' : null;
  }
  // An attached Gmail's `gacct:` key exists only because that account's own
  // calendar was listed (ADR 0313).
  if (key!.startsWith('gacct:')) return 'google_meet';
  return (await hasCalendarWriteScope(db, target.owner_user_id)) ? 'google_meet' : null;
}

/**
 * ADR 0317/0323 — put the calendar's own video call on the event, the way
 * that provider's client would: Google Calendar's "Add Google Meet video
 * conferencing", Outlook's "Teams meeting". Which kind is the kernel rule's
 * (ADR 0319), and never crossed. A phone-mirrored calendar has no provider
 * copy of Chord's to patch, so it gets none.
 */
export async function addVideoCall(
  db: Kysely<DB>,
  args: { eventId: string; actorUserId: string },
): Promise<VideoCallResult> {
  const asked = await loadRow(db, args.eventId);
  if (!asked) return { ok: false, reason: 'not_found' };
  const target = await organizerRow(db, asked);
  if (!target || target.owner_user_id !== args.actorUserId) return { ok: false, reason: 'not_organizer' };
  const key = calendarKeyOf(target);
  // A known calendar whose provider has no video call Chord can create is
  // refused before anything is written. An event with no calendar key yet
  // falls through to `not_on_calendar` below, which says more.
  if (key && !videoCallDefaultFor({ calendarId: key })) return { ok: false, reason: 'no_video_call' };

  const row = await ensureOnProvider(db, target);
  if (!row.gcal_event_id || !row.owner_user_id) return { ok: false, reason: 'not_on_calendar' };
  const where = await eventCalendarTransport(db, row.owner_user_id, row);
  if (!where) return { ok: false, reason: 'not_on_calendar' };
  // Asked again on the key the transport resolved, which may not be the one
  // the row stored (a default target, a moved event).
  const kind = videoCallDefaultFor({ calendarId: where.calendarId });
  if (!kind) return { ok: false, reason: 'no_video_call' };

  try {
    const remote = await where.transport.get(where.calendarId, row.gcal_event_id);
    if (!remote) return { ok: false, reason: 'provider_error' };
    if (remote.organizer && remote.organizer.self === false) return { ok: false, reason: 'not_organizer' };
    // Graph will not let a Teams meeting be changed or turned off once it is
    // on, so an event that already has one is answered with the link it has.
    if (remote.videoCallLink) return { ok: true, kind, link: remote.videoCallLink, already: true };

    const added = await where.transport.addOnlineMeeting(where.calendarId, row.gcal_event_id, {
      requestId: `chord-${row.id}-${Date.now()}`,
      notify: (remote.attendees ?? []).some((a) => !a.self),
    });
    if (!added.ok) {
      return {
        ok: false,
        reason: added.reason === 'unsupported' && kind === 'teams' ? 'teams_unavailable' : 'provider_error',
      };
    }
    // The write moved the provider's copy on; keep the stored etag current so
    // Chord's next edit is not refused as stale because of its own change.
    if (added.written) {
      await db
        .updateTable('events')
        .set({
          etag: added.written.etag ?? row.etag,
          ...(typeof added.written.sequence === 'number' ? { sequence: added.written.sequence } : {}),
        })
        .where('id', '=', row.id)
        .execute();
    }
    return { ok: true, kind, link: added.joinUrl, already: false };
  } catch (err) {
    logger.error('add video call failed', { err: String(err), eventId: row.id });
    return { ok: false, reason: 'provider_error' };
  }
}

/**
 * What the bot says about a video-call outcome; never claims a link it lacks,
 * and names the kind the calendar actually hosts rather than "a video call"
 * (ADR 0323) — a 365 user told their Teams meeting is a Google Meet has been
 * told something false about their own calendar.
 */
export function videoCallNote(r: VideoCallResult): string {
  if (r.ok) {
    const what = videoCallLabel(r.kind);
    // Only Google answers before the link exists; Graph returns the Teams
    // join URL with the write, so an `ok` with no link cannot be a Teams one.
    // Worded without naming Google all the same: the kind already says who,
    // and a provider added later must not inherit a sentence about Google.
    if (!r.link) return ` · a ${what} was requested; the calendar has not returned the link yet (say it will show on the event)`;
    return r.already
      ? ` · it already has a ${what} link: ${r.link}`
      : ` · added a ${what} link: ${r.link} (guests see it on the invitation)`;
  }
  const why: Record<typeof r.reason, string> = {
    not_found: 'the event was not found',
    not_organizer: 'only the organizer can add one',
    not_on_calendar: 'the event is not on a connected calendar',
    no_video_call:
      "this event's calendar is one Chord only reads (a calendar mirrored from a phone), so there is no video call to add to it",
    teams_unavailable:
      'this Outlook calendar does not offer Teams meetings — a personal Outlook account has no Teams for Business, and a work tenant needs the licence (say that; do NOT offer a Google Meet instead)',
    provider_error: 'the calendar refused or could not be reached',
  };
  return ` · NO video call link was added: ${why[r.reason]} (say so; do NOT claim a link)`;
}

/**
 * The guests on an event's provider copy, or null when that cannot be read.
 * The organizer's own entry is not a guest.
 */
export async function providerGuestEmails(db: Kysely<DB>, eventId: string): Promise<string[] | null> {
  const people = await providerEventPeople(db, eventId);
  return people === undefined ? [] : people && people.guests;
}

/**
 * The event's guests plus its organizer (null when that is the calendar's
 * owner, or not known), for writing to everyone on it, and the video-call
 * link on it (ADR 0317/0323), so a re-create can tell whether one is lost. `undefined` = the
 * event is only in Chord, so there is nobody on it; null = cannot be read.
 */
export async function providerEventPeople(
  db: Kysely<DB>,
  eventId: string,
): Promise<{ guests: string[]; organizer: string | null; videoCallLink: string | null } | null | undefined> {
  const row = await loadRow(db, eventId);
  if (!row) return null;
  if (!row.gcal_event_id || !row.owner_user_id) return undefined;
  const where = await eventCalendarTransport(db, row.owner_user_id, row);
  if (!where) return null;
  const remote = await where.transport.get(where.calendarId, row.gcal_event_id).catch(() => null);
  if (!remote) return null;
  const attendees = remote.attendees ?? [];
  const guests = attendees
    .filter((a) => !!a.email && !a.self && !a.organizer)
    .map((a) => a.email!.toLowerCase());
  const org =
    remote.organizer?.self === true
      ? null
      : (remote.organizer?.email ?? attendees.find((a) => a.organizer && !a.self)?.email ?? null);
  return { guests, organizer: org ? org.toLowerCase() : null, videoCallLink: remote.videoCallLink ?? null };
}
