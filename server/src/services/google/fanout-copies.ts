/**
 * ADR 0040 addendum (2026-10-23) — one Google event per calendar for the
 * copies of a fanned-out group event.
 *
 * Every member's copy of a group event is its own row, linked by one shared
 * key (`events.ical_uid`; `event_series.series_uid` for a repeating one), and
 * each is pushed under its owner's token. When two members' copies target the
 * SAME calendar (spouses whose default is the shared "Family" calendar), only
 * one of them may write there; the others take that one's Google identity and
 * never write it themselves.
 *
 * "Same calendar" compares real calendars: `'primary'` names a different
 * calendar for every user, so it is resolved to that user's primary Google
 * calendar id when known and to a per-user placeholder when not.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

/** What the rule needs from an `events` or `event_series` row. */
export interface CopyRow {
  id: string;
  /** The key linking every member's copy. */
  key: string | null;
  owner_user_id: string | null;
  google_calendar_id: string | null;
  gcal_event_id: string | null;
  etag: string | null;
  chord_uid: string | null;
  role: string;
  gcal_sync_status: string | null;
  local_dirty: number;
}

interface OwnerCalendars {
  defaultId: string | null;
  primaryId: string | null;
}

export type InsertPlan<R> =
  | { kind: 'insert'; waiting: R[] }
  | { kind: 'adopt'; from: R }
  | { kind: 'wait' };

export class FanoutCopies<R extends CopyRow> {
  private constructor(
    private readonly owners: Map<string, OwnerCalendars>,
    /** Other owners' live copies sharing a key with a pushed row. */
    private readonly byKey: Map<string, R[]>,
    /** Other owners' live rows bound to a Google event id a pushed row holds. */
    private readonly byGcalId: Map<string, R[]>,
  ) {}

  /**
   * `others` returns other owners' live rows matching any of the keys or
   * Google ids, already shaped as `CopyRow`s.
   */
  static async load<R extends CopyRow>(
    db: Kysely<DB>,
    userId: string,
    rows: CopyRow[],
    others: (keys: string[], gcalIds: string[]) => Promise<R[]>,
  ): Promise<FanoutCopies<R>> {
    const keys = [...new Set(rows.map((r) => r.key).filter((u): u is string => !!u))];
    const gids = [...new Set(rows.map((r) => r.gcal_event_id).filter((g): g is string => !!g))];
    const found = keys.length === 0 && gids.length === 0 ? [] : await others(keys, gids);
    const byKey = new Map<string, R[]>();
    const byGcalId = new Map<string, R[]>();
    for (const o of found) {
      if (o.key && keys.includes(o.key)) push(byKey, o.key, o);
      if (o.gcal_event_id && gids.includes(o.gcal_event_id)) push(byGcalId, o.gcal_event_id, o);
    }
    const owners = new Map<string, OwnerCalendars>();
    if (found.length > 0) {
      const ownerIds = [
        ...new Set([userId, ...found.map((o) => o.owner_user_id).filter((o): o is string => !!o)]),
      ];
      const users = await db
        .selectFrom('users')
        .select(['id', 'default_calendar_id'])
        .where('id', 'in', ownerIds)
        .execute();
      const primaries = await db
        .selectFrom('calendar_sources')
        .select(['user_id', 'google_calendar_id'])
        .where('user_id', 'in', ownerIds)
        .where('provider', '=', 'google')
        .where('is_primary', '=', 1)
        .execute();
      const primaryOf = new Map(primaries.map((p) => [p.user_id, p.google_calendar_id]));
      for (const u of users) {
        owners.set(u.id, { defaultId: u.default_calendar_id, primaryId: primaryOf.get(u.id) ?? null });
      }
    }
    return new FanoutCopies(owners, byKey, byGcalId);
  }

  /** The real calendar a row writes to, comparable across owners. */
  private target(row: CopyRow, literal?: string): string {
    const owner = row.owner_user_id ?? '';
    const cal = this.owners.get(owner);
    const id = literal ?? row.google_calendar_id ?? cal?.defaultId ?? 'primary';
    if (id !== 'primary') return id;
    return cal?.primaryId ?? `primary:${owner}`;
  }

  /**
   * What a not-yet-pushed row should do: insert it, take a sibling's existing
   * event on the same calendar, or wait for the sibling that will insert it.
   */
  planInsert(row: CopyRow, calendarId: string): InsertPlan<R> {
    const siblings = row.key ? this.byKey.get(row.key) ?? [] : [];
    if (siblings.length === 0) return { kind: 'insert', waiting: [] };
    const mine = this.target(row, calendarId);
    const same = siblings.filter((s) => this.target(s) === mine);
    const bound = same.find((s) => s.gcal_event_id);
    if (bound) return { kind: 'adopt', from: bound };
    // A sibling the provider rejected outright will not insert; skip it.
    const live = same.filter((s) => !(s.gcal_sync_status === 'error' && s.local_dirty === 0));
    return leader<CopyRow>([row, ...live]).id === row.id
      ? { kind: 'insert', waiting: live }
      : { kind: 'wait' };
  }

  /** Other owners' live rows on the same Google event as this row. */
  private peers(row: CopyRow, calendarId: string): R[] {
    if (!row.gcal_event_id) return [];
    const mine = this.target(row, calendarId);
    return (this.byGcalId.get(row.gcal_event_id) ?? []).filter(
      (p) => p.id !== row.id && this.target(p) === mine,
    );
  }

  /** Another copy still shows this Google event: do not remove it. */
  keepRemoteOnDelete(row: CopyRow, calendarId: string): boolean {
    return this.peers(row, calendarId).length > 0;
  }

  /** Another copy on the same Google event is its writer: do not patch. */
  isReflection(row: CopyRow, calendarId: string): boolean {
    const peers = this.peers(row, calendarId);
    return peers.length > 0 && leader<CopyRow>([row, ...peers]).id !== row.id;
  }
}

/** Other owners' live `events` copies, for `FanoutCopies.load`. */
export function otherEventCopies(db: Kysely<DB>, userId: string) {
  return async (keys: string[], gids: string[]) =>
    (
      await db
        .selectFrom('events')
        .selectAll()
        .where('owner_user_id', '!=', userId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            ...(keys.length ? [eb('ical_uid', 'in', keys)] : []),
            ...(gids.length ? [eb('gcal_event_id', 'in', gids)] : []),
          ]),
        )
        .execute()
    ).map((r) => ({ ...r, key: r.ical_uid }));
}

/** Other owners' live `event_series` copies, for `FanoutCopies.load`. */
export function otherSeriesCopies(db: Kysely<DB>, userId: string) {
  return async (keys: string[], gids: string[]) =>
    (
      await db
        .selectFrom('event_series')
        .selectAll()
        .where('owner_user_id', '!=', userId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            ...(keys.length ? [eb('series_uid', 'in', keys)] : []),
            ...(gids.length ? [eb('gcal_event_id', 'in', gids)] : []),
          ]),
        )
        .execute()
    ).map((r) => ({ ...r, key: r.series_uid }));
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** The organizer's copy writes; failing that, the oldest id, so every pass agrees. */
function leader<T extends { id: string; role: string }>(rows: T[]): T {
  return [...rows].sort((a, b) => {
    const ra = a.role === 'organizer' ? 0 : 1;
    const rb = b.role === 'organizer' ? 0 : 1;
    return ra - rb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  })[0]!;
}

/**
 * The pull found no row of the user's for an event Chord made (it carries a
 * `chordUid`). If that event is another member's copy of something the user
 * already has their own copy of, it is the same logical event seen through
 * a calendar the user subscribes to, and must not become a second row.
 */
export async function isAnotherMembersCopyOfMine(
  db: Kysely<DB>,
  userId: string,
  chordUid: string,
): Promise<boolean> {
  const hit = await db
    .selectFrom('events as theirs')
    .innerJoin('events as mine', 'mine.ical_uid', 'theirs.ical_uid')
    .select('mine.id')
    .where('theirs.chord_uid', '=', chordUid)
    .where('theirs.owner_user_id', '!=', userId)
    .where('mine.owner_user_id', '=', userId)
    .where('mine.deleted_at', 'is', null)
    .executeTakeFirst();
  if (hit) return true;
  // A series master carries its series' chordUid.
  const series = await db
    .selectFrom('event_series as theirs')
    .innerJoin('event_series as mine', 'mine.series_uid', 'theirs.series_uid')
    .select('mine.id')
    .where('theirs.chord_uid', '=', chordUid)
    .where('theirs.owner_user_id', '!=', userId)
    .where('mine.owner_user_id', '=', userId)
    .where('mine.deleted_at', 'is', null)
    .executeTakeFirst();
  return !!series;
}
