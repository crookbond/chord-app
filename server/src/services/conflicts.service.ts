/**
 * Deterministic calendar-conflict detection (ADR 0040).
 *
 * Conflict is interval arithmetic, not a judgement call — so this is pure code,
 * no LLM, no titles in the decision. Inputs are start/end instants and free/busy
 * (ADR 0033 `eventBlocksTime`); titles/locations come along only for the
 * human-readable message. Shared by the bot `find_conflicts` tool and the
 * event-created nudge so the two can't drift.
 */
import { sql, type Kysely, type Selectable } from 'kysely';

import type { DB } from '../db/schema.js';
import { textInstant } from '../db/text-instant.js';
import { eventBlocksTime, loadBusyContext, type BusyContext } from './calendar-sources.service.js';
import { computeTransparency, DEFAULT_EVENT_DURATION_MS } from './google/two-way-sync.js';
import { instantInZoneMs } from '../utils/tz.js';
import { ticketsForOthers } from './trips/trip-conflict.js';
import { activeHolds } from './events/holds.service.js';

/** ADR 0040 — an event with no explicit end spans 1 hour for conflict math.
 *  Single source of truth lives in two-way-sync; re-exported for callers/tests. */
export { DEFAULT_EVENT_DURATION_MS };

export interface ConflictRow {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  /** Source calendar display name; 'Chord' for native; null if unknown. */
  calendar: string | null;
}


/** Half-open interval overlap on epoch-ms. Back-to-back (a.end == b.start) is
 *  NOT an overlap. */
export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Effective end instant, defaulting a missing/invalid end to start + 1h. A
 * floating value is wall time in `tz` (the user's zone), not the server's.
 */
export function effectiveEndMs(startsAt: string, endsAt: string | null, tz?: string | null): number {
  const s = instantInZoneMs(startsAt, tz);
  if (endsAt) {
    const e = instantInZoneMs(endsAt, tz);
    if (Number.isFinite(e) && e > s) return e;
  }
  return s + DEFAULT_EVENT_DURATION_MS;
}

async function userZone(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst();
  return row?.last_tz ?? null;
}

function calIdOf(
  row: { google_calendar_id: string | null; external_uid: string | null },
  ctx: BusyContext,
): { calId: string | null; isNative: boolean } {
  // New model: a Google-linked copy carries google_calendar_id. Legacy: derive
  // from the gcal: external_uid. Neither: a Chord-native event.
  if (row.google_calendar_id) return { calId: row.google_calendar_id, isNative: false };
  if (row.external_uid?.startsWith('gcal:')) {
    const rest = row.external_uid.slice('gcal:'.length);
    const sep = rest.indexOf(':');
    return { calId: sep === -1 ? ctx.primaryCalendarId : rest.slice(0, sep), isNative: false };
  }
  return { calId: null, isNative: true };
}

/**
 * Events overlapping [startIso, endIso) that BLOCK the user's time. Only
 * calendars with the "block" setting count (`counts_for_busy` effective = true,
 * per ADR 0033) plus Chord-native events — informational ("soft") calendars are
 * never returned, ever. `transparent` and all-day events are also excluded
 * (free). Overlap is computed in JS on parsed instants (robust to mixed UTC
 * offsets and floating times); the SQL is only a coarse, day-padded pre-filter,
 * so a stored timestamp's offset can never lexically drop a real overlap.
 *
 * `groupId` scopes to one group (the bot tool, ADR 0032); omit it for the
 * cross-group personal view (the nudge). `excludeEventId` drops the triggering
 * event from its own candidate list.
 */
/** Busy block, epoch-ms half-open. */
export interface BusyInterval {
  startMs: number;
  endMs: number;
}

/** Above this many candidate rows in one window we stop trusting the answer —
 *  see `truncated` below. */
const BUSY_SCAN_CAP = 400;

/**
 * Every interval that BLOCKS the user across a whole window, rather than
 * against one candidate slot. Deliberately a sibling of `computeConflicts`
 * instead of a call to it: that one caps at 100 rows for a single slot and
 * can't say whether it hit the cap, and a free/busy answer that silently lost
 * rows would offer a time the user is busy.
 *
 * The parts that must not drift — `eventBlocksTime` (ADR 0033 block vs
 * informational calendars), `computeTransparency` (all-day / <5-min / "show me
 * as free"), `effectiveEndMs` (ADR 0040's 1h default) — are the same helpers,
 * so what counts as busy here is what `find_conflicts` says.
 *
 * `truncated` means the window held more candidates than the cap: callers must
 * treat availability as UNKNOWN rather than render a partial answer.
 */
export async function busyIntervalsInWindow(
  db: Kysely<DB>,
  /** `exceptThreadKey`: a reply drafted IN a meeting's thread does not treat
   *  that meeting's own hold as busy (it would decline its own agreed time). */
  opts: { userId: string; startIso: string; endIso: string; exceptThreadKey?: string },
): Promise<{ intervals: BusyInterval[]; truncated: boolean }> {
  const { events, truncated } = await busyEventsInWindow(db, opts);
  // ADR 0346 phase 4 - a slot held for an invitation on its way is busy for
  // every free-time check Chord makes (reply drafts, suggestions, /plan).
  const holds = (
    await activeHolds(db, opts.userId, {
      fromMs: Date.parse(opts.startIso),
      toMs: Date.parse(opts.endIso),
    })
  ).filter((h) => h.threadKey !== opts.exceptThreadKey);
  const intervals = [
    ...events.map((e) => ({ startMs: e.startMs, endMs: e.endMs })),
    ...holds.map((h) => ({ startMs: Date.parse(h.startsAt), endMs: Date.parse(h.endsAt) })),
  ].sort((a, b) => a.startMs - b.startMs);
  return { intervals, truncated };
}

/** A busy block with the row behind it (ADR 0346 asks who it is with). */
export interface BusyEvent extends BusyInterval {
  row: Selectable<DB['events']>;
}

/** The events behind `busyIntervalsInWindow`: one rule for what is busy. */
export async function busyEventsInWindow(
  db: Kysely<DB>,
  opts: { userId: string; startIso: string; endIso: string },
): Promise<{ events: BusyEvent[]; truncated: boolean }> {
  const PAD = 36 * 60 * 60 * 1000;
  const rows = await db
    .selectFrom('events')
    .selectAll('events')
    .where('events.owner_user_id', '=', opts.userId)
    .where('events.deleted_at', 'is', null)
    .where('events.status', '!=', 'cancelled')
    .where(textInstant('events.starts_at'), '>=', new Date(Date.parse(opts.startIso) - PAD).toISOString())
    .where(textInstant('events.starts_at'), '<=', new Date(Date.parse(opts.endIso) + PAD).toISOString())
    .orderBy(textInstant('events.starts_at'), 'asc')
    .limit(BUSY_SCAN_CAP + 1)
    .execute();
  if (rows.length > BUSY_SCAN_CAP) return { events: [], truncated: true };

  const [ctx, tz] = await Promise.all([loadBusyContext(db, opts.userId), userZone(db, opts.userId)]);
  // Someone else's ticket on this calendar is not this user's busy time.
  const othersTickets = await ticketsForOthers(db, opts.userId, rows, tz);
  const events: BusyEvent[] = [];
  for (const r of rows) {
    if (othersTickets.has(r.id)) continue;
    if (r.transparency === 'transparent') continue;
    if (
      computeTransparency({ startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day === 1 }) ===
      'transparent'
    ) {
      continue;
    }
    if (!eventBlocksTime(r, ctx)) continue;
    const startMs = instantInZoneMs(r.starts_at, tz);
    if (!Number.isFinite(startMs)) continue;
    events.push({ startMs, endMs: effectiveEndMs(r.starts_at, r.ends_at, tz), row: r });
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return { events, truncated: false };
}

export async function computeConflicts(
  db: Kysely<DB>,
  opts: {
    userId: string;
    startIso: string;
    endIso: string;
    groupId?: string;
    excludeEventId?: string;
  },
): Promise<ConflictRow[]> {
  const tz = await userZone(db, opts.userId);
  const newStart = instantInZoneMs(opts.startIso, tz);
  const newEnd = instantInZoneMs(opts.endIso, tz);
  const PAD = 36 * 60 * 60 * 1000; // ±1.5d slack: lexical/offset quirks can't drop a real overlap
  const loIso = new Date(newStart - PAD).toISOString();
  const hiIso = new Date(newEnd + PAD).toISOString();

  // ADR 0040 §8 — read the user's own copies (owner-scoped), not a
  // group-members join. `groupId` (set by the bot tool, ADR 0032) narrows to
  // copies tagged for that group via `group_ids` containment; the nudge omits
  // it for the cross-group personal view.
  let q = db
    .selectFrom('events')
    .where('events.owner_user_id', '=', opts.userId)
    .where('events.deleted_at', 'is', null)
    .where('events.status', '!=', 'cancelled')
    .where(textInstant('events.starts_at'), '>=', loIso)
    .where(textInstant('events.starts_at'), '<=', hiIso);
  if (opts.groupId) q = q.where(sql<boolean>`group_ids ? ${opts.groupId}`);
  if (opts.excludeEventId) q = q.where('events.id', '!=', opts.excludeEventId);
  const rows = await q.selectAll('events').orderBy(textInstant('events.starts_at'), 'asc').limit(100).execute();

  const ctx = await loadBusyContext(db, opts.userId);
  // Someone else's ticket on this calendar is not this user's busy time.
  const othersTickets = await ticketsForOthers(db, opts.userId, rows, tz);
  const nameByCalId = new Map<string, string>();
  for (const s of await db
    .selectFrom('calendar_sources')
    .select(['google_calendar_id', 'summary'])
    .where('user_id', '=', opts.userId)
    .execute()) {
    if (s.summary) nameByCalId.set(s.google_calendar_id, s.summary);
  }

  const conflicts: ConflictRow[] = [];
  for (const r of rows) {
    if (othersTickets.has(r.id)) continue;
    // Free events never block. Two signals: (1) Google's explicit "show me as
    // free", (2) the structural rule — all-day or <5-min (incl 0-duration
    // markers like birthdays). Computed fresh so a stale stored transparency
    // (e.g. a birthday pulled as 'opaque') can't leak in as a conflict.
    if (r.transparency === 'transparent') continue;
    if (
      computeTransparency({ startsAt: r.starts_at, endsAt: r.ends_at, allDay: r.all_day === 1 }) ===
      'transparent'
    ) {
      continue;
    }
    // ONLY block-setting calendars (+ Chord-native) count. Informational
    // calendars are dropped entirely — never surfaced as a conflict.
    if (!eventBlocksTime(r, ctx)) continue;
    if (
      !overlaps(newStart, newEnd, instantInZoneMs(r.starts_at, tz), effectiveEndMs(r.starts_at, r.ends_at, tz))
    ) {
      continue;
    }
    const { calId, isNative } = calIdOf(r, ctx);
    conflicts.push({
      id: r.id,
      title: r.title,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      location: r.location ?? null,
      calendar: isNative ? 'Chord' : calId ? nameByCalId.get(calId) ?? null : null,
    });
  }
  return conflicts;
}
