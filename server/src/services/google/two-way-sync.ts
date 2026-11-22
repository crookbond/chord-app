/**
 * Two-way calendar sync — reconciliation core (ADR 0040).
 *
 * PROTOTYPE. Pure decision functions only, no Google I/O and no DB — the
 * same shape as `shouldReverseDelete` / `eventBlocksTime` so the merge rules
 * are unit-tested without a network. The eventual sync loop (below) is the
 * thin I/O shell that calls these.
 *
 * Authority model (RFC 5545 / Google):
 *   - CONTENT (title/time/location/status) is organizer-authoritative and
 *     SEQUENCE-versioned. Only the organizer copy bumps `sequence`
 *     (`nextSequenceOnLocalEdit`); attendee copies inherit it.
 *   - RESPONSE (response_status + potluck extras) is per-attendee.
 * Reconciling a single local copy against its own Google event is therefore
 * symmetric last-writer-wins; organizer-authority is enforced at EDIT time
 * (who may bump sequence), not at merge time.
 *
 * The loop the I/O shell runs, per calendar:
 *
 *   PULL (incremental, Google syncToken delta + webhook channel):
 *     for each changed remote event e:
 *       local = find by (google_calendar_id, gcal_event_id)
 *               ?? find by (owner_user_id, ical_uid)
 *       if !local:                          -> insert (foreign-origin, or our
 *                                              own copy coming back)
 *       else switch reconcileRemote(local, e):
 *         'apply-remote'      -> overwrite local content, store etag/sequence,
 *                                clear local_dirty
 *         'delete-local'      -> soft-delete (status='cancelled', deleted_at)
 *         'push-local'        -> queue a push (our tombstone/edit isn't on
 *                                Google yet)
 *         'conflict-resolved' -> winner 'remote' = apply-remote;
 *                                winner 'local'  = queue a push
 *         'noop'              -> nothing
 *     persist the calendar's new syncToken
 *
 *   PUSH (on local edit / delete; drains local_dirty rows):
 *     sequence = nextSequenceOnLocalEdit(local)   // organizer bumps, else same
 *     PATCH/DELETE Google with If-Match: etag
 *       200/204 -> store new etag + sequence, clear local_dirty, status='synced'
 *       412     -> etag stale: re-pull this event, reconcileRemote again, retry
 *       404/410 -> already gone: treat a delete as success; an edit becomes a
 *                  re-create (drop gcal_event_id, push fresh)
 */

const FREE_MAX_MS = 5 * 60 * 1000;
/** ADR 0040 — an event with no explicit end spans 1 hour (blocks that long). */
export const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;

export type EventStatus = 'confirmed' | 'tentative' | 'cancelled';
export type Transparency = 'opaque' | 'transparent';
export type CopyRole = 'organizer' | 'attendee';

/** The local `calendar_events` copy, reduced to the fields reconcile needs. */
export interface LocalCopy {
  sequence: number;
  /** ISO; the "time of update" tiebreak. */
  updatedAt: string;
  /** A local edit/delete not yet pushed to Google. */
  localDirty: boolean;
  status: EventStatus;
  /** Soft-delete tombstone timestamp, or null. */
  deletedAt: string | null;
  role: CopyRole;
}

/** The Google event resource, reduced to what reconcile needs. */
export interface RemoteEvent {
  /** Google exposes `sequence` on the event resource (RFC 5545). */
  sequence: number;
  /** Google `updated` (ISO). */
  updated: string;
  status: EventStatus;
}

export type ReconcileAction =
  | { kind: 'noop'; reason: string }
  | { kind: 'apply-remote'; reason: string }
  | { kind: 'push-local'; reason: string }
  | { kind: 'delete-local'; reason: string }
  | { kind: 'conflict-resolved'; winner: 'remote' | 'local'; reason: string };

function isAfter(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/**
 * Decide what to do with one local copy when Google hands us its current
 * remote version. Pure: all the ADR 0040 merge rules live here. Order
 * matters — first matching rule wins.
 */
export function reconcileRemote(local: LocalCopy, remote: RemoteEvent): ReconcileAction {
  // 1. Remote tombstoned -> mirror the delete locally (idempotent).
  if (remote.status === 'cancelled') {
    return local.status === 'cancelled'
      ? { kind: 'noop', reason: 'both already cancelled' }
      : { kind: 'delete-local', reason: 'remote cancelled' };
  }

  // 2. We deleted locally but Google still has it -> propagate our delete.
  //    A local tombstone always wins over a live remote (we asked to remove it).
  if (local.deletedAt !== null || local.status === 'cancelled') {
    return { kind: 'push-local', reason: 'local tombstone not yet on remote' };
  }

  // 3. No pending local edit -> remote is authoritative when it is newer.
  if (!local.localDirty) {
    if (remote.sequence > local.sequence) {
      return { kind: 'apply-remote', reason: 'remote higher sequence' };
    }
    if (remote.sequence === local.sequence && isAfter(remote.updated, local.updatedAt)) {
      return { kind: 'apply-remote', reason: 'same sequence, remote updated later' };
    }
    return { kind: 'noop', reason: 'local up to date' };
  }

  // 4. Both sides changed -> last-writer-wins by updatedAt (ADR 0040, decision 1).
  //    Tie goes to remote so both ends converge deterministically.
  return isAfter(remote.updated, local.updatedAt)
    ? { kind: 'conflict-resolved', winner: 'remote', reason: 'LWW: remote newer' }
    : { kind: 'conflict-resolved', winner: 'local', reason: 'LWW: local newer-or-equal' };
}

/**
 * SEQUENCE bump on a local content edit. Organizer-owned: only the organizer
 * copy increments; attendee copies keep the inherited sequence (their edits
 * are response-only and don't revise the logical event).
 */
export function nextSequenceOnLocalEdit(local: Pick<LocalCopy, 'role' | 'sequence'>): number {
  return local.role === 'organizer' ? local.sequence + 1 : local.sequence;
}

/**
 * The structural "free" rule (ADR 0040, decision 2). The single source of truth
 * for whether an event blocks time, used on write (push), on read (store), and
 * in conflict detection:
 *   - all-day            → free
 *   - duration < 5 min   → free (includes 0-duration markers like birthdays)
 *   - no explicit end    → BLOCKS (treated as a 1-hour block; see effectiveEndMs)
 *   - otherwise          → blocks
 */
export function computeTransparency(ev: {
  startsAt: string;
  endsAt?: string | null;
  allDay?: boolean;
}): Transparency {
  if (ev.allDay) return 'transparent';
  if (!ev.endsAt) return 'opaque'; // no-end = 1h block, not free
  const dur = Date.parse(ev.endsAt) - Date.parse(ev.startsAt);
  if (!Number.isFinite(dur)) return 'opaque';
  return dur <= FREE_MAX_MS ? 'transparent' : 'opaque';
}

/** extendedProperties.private namespace key for our origin/identity stamp. */
export const CHORD_UID_PROP = 'chordUid';

/** Did *we* create this remote event? Loop-prevention via the chord_uid stamp
 *  (ADR 0040) — replaces sniffing a `gcal:` external_uid prefix. */
export function isChordOrigin(remote: {
  extendedProperties?: { private?: Record<string, string> };
}): boolean {
  return Boolean(remote.extendedProperties?.private?.[CHORD_UID_PROP]);
}

// ── Google ⇄ local field mappers (pure; the I/O shell calls these) ──────────

export interface GoogleDateTime {
  /** RFC3339 datetime for a timed event. */
  dateTime?: string;
  /** YYYY-MM-DD for an all-day event. */
  date?: string;
  /** IANA name, e.g. 'America/New_York'. */
  timeZone?: string;
}

export interface GoogleEventResource {
  id: string;
  iCalUID?: string;
  status?: EventStatus;
  summary?: string;
  description?: string;
  location?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  sequence?: number;
  updated?: string;
  etag?: string;
  transparency?: Transparency;
  recurringEventId?: string;
  originalStartTime?: GoogleDateTime;
  extendedProperties?: { private?: Record<string, string> };
  attendees?: GoogleAttendee[];
  /** Who organizes the event; `self` when it is the calendar's owner. */
  organizer?: { email?: string; self?: boolean };
  /**
   * ADR 0323 — the join link of the event's video call, whichever kind: each
   * transport fills it from its own provider's field (Google's `hangoutLink`,
   * Graph's read-only `onlineMeeting.joinUrl`). Provider-neutral because the
   * only thing that reads it asks "does this already have one", and a field
   * named for Google carrying a Teams URL is how that answer starts to lie.
   */
  videoCallLink?: string;
}

/** One entry of a provider event's `attendees` array. Kept whole, so a guest
 *  change sends everyone else back untouched (answer, flags, name). */
export interface GoogleAttendee {
  email?: string;
  self?: boolean;
  organizer?: boolean;
  responseStatus?: string;
  displayName?: string;
  [key: string]: unknown;
}

/**
 * ADR 0295 — the provider's attendee list after a guest change. The provider
 * REPLACES the whole array on a patch, so everyone it lists is sent back as it
 * is, minus `remove`, plus each of `add` it does not list yet. Emails compare
 * without case. Entries with no email (Outlook's own-answer entry) are not
 * guests and are dropped.
 */
export function nextAttendees(
  remote: GoogleAttendee[] | undefined,
  add: string[],
  remove: string[],
): { attendees: GoogleAttendee[]; added: string[]; removed: string[] } {
  const norm = (e: string) => e.trim().toLowerCase();
  const drop = new Set(remove.map(norm));
  const attendees: GoogleAttendee[] = [];
  const seen = new Set<string>();
  const removed: string[] = [];
  for (const a of remote ?? []) {
    const key = a.email ? norm(a.email) : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (drop.has(key)) {
      removed.push(key);
      continue;
    }
    attendees.push(a);
  }
  const added: string[] = [];
  for (const email of add) {
    const key = norm(email);
    if (!key || seen.has(key) || drop.has(key)) continue;
    seen.add(key);
    added.push(key);
    attendees.push({ email: key });
  }
  return { attendees, added, removed };
}

/**
 * True when the calendar owner DECLINED this event (their own attendee row).
 * Google keeps declined events on the calendar (struck through), so the event
 * resource still arrives as status 'confirmed' — the user's answer lives only
 * in attendees[self].responseStatus.
 */
export function selfDeclined(remote: GoogleEventResource): boolean {
  return remote.attendees?.some((a) => a.self && a.responseStatus === 'declined') ?? false;
}

/**
 * Has the user actually answered this invitation, anywhere?
 *
 * `needsAction` is Google's "still waiting on you", and an unanswered invite
 * has to keep its Chord suggestion — that card is one of the places it can be
 * answered from. Anything else means they replied elsewhere (Gmail, the
 * Calendar app, another device), and a suggestion still asking is a stale one.
 */
export function selfResponded(remote: GoogleEventResource): boolean {
  const self = remote.attendees?.find((a) => a.self);
  if (!self) return false;
  return !!self.responseStatus && self.responseStatus !== 'needsAction';
}

/** Local time fields a Google start/end maps to. All-day uses the floating
 *  midnight convention (`YYYY-MM-DDT00:00:00`, no Z) the read pipeline already
 *  writes, so every client buckets it on the picked calendar date. */
export function googleDateTimeToIso(
  dt: GoogleDateTime | undefined,
): { iso: string | null; allDay: boolean; tz: string | null } {
  if (!dt) return { iso: null, allDay: false, tz: null };
  if (dt.dateTime) return { iso: dt.dateTime, allDay: false, tz: dt.timeZone ?? null };
  if (dt.date) return { iso: `${dt.date}T00:00:00`, allDay: true, tz: null };
  return { iso: null, allDay: false, tz: null };
}

/**
 * Inverse: a local ISO + all-day flag → the Google start/end shape. A
 * floating midnight (or an explicit all-day row) round-trips as `date`.
 *
 * "Floating" means literally no timezone marker (ADR 0040: emitted as
 * `2026-06-05T00:00:00`, no offset, no `Z`) — that's the one shape this
 * heuristic must catch independently of `allDay`. It must NOT catch a
 * Z-suffixed or offset-suffixed instant that simply happens to read
 * midnight: `localRowToGoogleBody`'s default-duration fallback computes a
 * missing `endsAt` via `new Date(...).toISOString()`, which is always
 * Z-suffixed — a 7pm-or-later local start plus the 1h default can land
 * exactly on UTC midnight (e.g. 7pm EDT + 1h = 8pm EDT = 00:00 UTC). The old
 * regex matched that Z-suffixed instant too, silently turning a real timed
 * end into an all-day `{date}` while `start` stayed `{dateTime}` — Google
 * rejects the mismatch outright ("Start and end times must either both be
 * date or both be dateTime"), and ADR 0103's give-up-on-4xx rule then buried
 * it: a Resy dinner reservation confirmed in Chord and never reached Google
 * Calendar. Anchored full-match with no trailing offset/`Z` allowed.
 */
export function isoToGoogleDateTime(
  iso: string,
  allDay: boolean,
  tz?: string | null,
): GoogleDateTime {
  const isFloatingMidnight = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?$/.test(iso);
  if (allDay || isFloatingMidnight) return { date: iso.slice(0, 10) };
  return tz ? { dateTime: iso, timeZone: tz } : { dateTime: iso };
}

/** The local-row fields a pulled Google event maps to. Transparency is captured
 *  verbatim from Google on read (the <5-min rule only governs our *writes*). */
export interface LocalEventFields {
  ical_uid: string;
  chord_uid: string | null;
  gcal_event_id: string;
  etag: string | null;
  sequence: number;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string | null;
  ends_at: string | null;
  start_tz: string | null;
  end_tz: string | null;
  all_day: 0 | 1;
  status: EventStatus;
  transparency: Transparency;
  recurring_event_id: string | null;
  original_start: string | null;
  /** Guests + organizer, lowercased; null when the provider lists none. */
  guest_emails: string[] | null;
}

/** Everyone the provider lists on an event (organizer included), lowercased,
 *  once each. The user's own answer entry carries no address and is skipped. */
export function guestEmailsOf(remote: Pick<GoogleEventResource, 'attendees' | 'organizer'>): string[] | null {
  const out = new Set<string>();
  const add = (e?: string) => {
    const v = e?.trim().toLowerCase();
    if (v && v.includes('@')) out.add(v);
  };
  add(remote.organizer?.email);
  for (const a of remote.attendees ?? []) add(a.email);
  return out.size > 0 ? [...out] : null;
}

export function googleEventToLocalFields(remote: GoogleEventResource): LocalEventFields {
  const start = googleDateTimeToIso(remote.start);
  const end = googleDateTimeToIso(remote.end);
  return {
    ical_uid: remote.iCalUID || remote.id,
    chord_uid: remote.extendedProperties?.private?.[CHORD_UID_PROP] ?? null,
    gcal_event_id: remote.id,
    etag: remote.etag ?? null,
    sequence: remote.sequence ?? 0,
    title: remote.summary?.trim() || '(untitled)',
    description: remote.description ?? null,
    location: remote.location ?? null,
    starts_at: start.iso,
    ends_at: end.iso,
    start_tz: start.tz,
    end_tz: end.tz,
    all_day: start.allDay ? 1 : 0,
    status: remote.status ?? 'confirmed',
    // Free if Google says so, or structurally (all-day, <5-min) — ADR 0040 dec. 2.
    transparency:
      remote.transparency === 'transparent' ||
      computeTransparency({ startsAt: start.iso ?? '', endsAt: end.iso, allDay: start.allDay }) ===
        'transparent'
        ? 'transparent'
        : 'opaque',
    recurring_event_id: remote.recurringEventId ?? null,
    original_start: googleDateTimeToIso(remote.originalStartTime).iso,
    guest_emails: guestEmailsOf(remote),
  };
}

/** The Google events.insert/patch body for a local row. Stamps chord_uid for
 *  origin detection and applies the <5-min free rule to transparency. */
export function localRowToGoogleBody(
  row: {
    title: string;
    description?: string | null;
    location?: string | null;
    starts_at: string;
    ends_at?: string | null;
    all_day?: number | null;
    start_tz?: string | null;
    end_tz?: string | null;
    status?: EventStatus;
    sequence?: number;
    chord_uid?: string | null;
    /** Stored free/busy. "transparent" (marked free, e.g. someone else's
     *  ticket) is sent as such; otherwise the structural rule decides. */
    transparency?: string | null;
  },
): Record<string, unknown> {
  const allDay = row.all_day === 1;
  // A timed no-end event blocks 1 hour (ADR 0040). Push a real +1h end so it
  // doesn't land on Google as a 0-duration point — which would pull back as
  // <5-min "free" and flip the event from blocking to free on round-trip.
  const endSource =
    row.ends_at ??
    (allDay
      ? row.starts_at
      : new Date(Date.parse(row.starts_at) + DEFAULT_EVENT_DURATION_MS).toISOString());
  const body: Record<string, unknown> = {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
    start: isoToGoogleDateTime(row.starts_at, allDay, row.start_tz),
    end: isoToGoogleDateTime(endSource, allDay, row.end_tz),
    transparency:
      row.transparency === 'transparent'
        ? 'transparent'
        : computeTransparency({
            startsAt: row.starts_at,
            endsAt: row.ends_at,
            allDay,
          }),
    status: row.status ?? 'confirmed',
    sequence: row.sequence ?? 0,
  };
  if (row.chord_uid) {
    body.extendedProperties = { private: { [CHORD_UID_PROP]: row.chord_uid } };
  }
  return body;
}
