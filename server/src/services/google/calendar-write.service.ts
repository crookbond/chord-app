/**
 * Google Calendar helpers shared by the calendar subsystem (ADR 0015,
 * superseded by ADR 0040's two-way-sync.service.ts).
 *
 * The original one-way Chord → Google push functions that lived here
 * have been removed; `two-way-sync.service.ts` is now the only writer.
 * What remains — scope detection and Chord-target-calendar resolution —
 * is still used by that sync path and by the flight-calendar backfill
 * script.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';

const CHORD_CALENDAR_SUMMARY = env.GCAL_TARGET_CALENDAR_NAME;
const WRITE_SCOPE_RE =
  /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.events|)(?:$|\s)/;

interface GcalCalendarResponse {
  id: string;
  summary?: string;
}

export async function hasCalendarWriteScope(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('refresh_token_scopes')
    .where('id', '=', userId)
    .executeTakeFirst();
  return WRITE_SCOPE_RE.test(row?.refresh_token_scopes ?? '');
}

/** Lightweight check: does the user's stored refresh token cover any Google
 *  calendar scope (read is enough)? Used by the "Connect Calendar" mobile UI
 *  and to decide whether a sync pass has a Google side at all. */
export async function hasCalendarScope(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('refresh_token_scopes')
    .where('id', '=', userId)
    .executeTakeFirst();
  const scopes = row?.refresh_token_scopes ?? '';
  return /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.readonly|\.events|$|\s)/.test(
    scopes,
  );
}

/**
 * Whether an event saved now can reach this user's Google calendar.
 *
 * `expired` is a user who connected Google once and whose grant has since been
 * refused: the token and its scopes are cleared on `invalid_grant`, and
 * `google_connected_at` is what is left to say they were ever connected. Their
 * events stay queued and push after a reconnect. `never` has nothing queued to
 * wait for.
 */
export async function googleCalendarConnection(
  db: Kysely<DB>,
  userId: string,
): Promise<'connected' | 'expired' | 'never'> {
  const row = await db
    .selectFrom('users')
    .select(['refresh_token_scopes', 'google_connected_at'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (WRITE_SCOPE_RE.test(row?.refresh_token_scopes ?? '')) return 'connected';
  return row?.google_connected_at ? 'expired' : 'never';
}

/**
 * Look up the dedicated Chord-target calendar id on Google. Resolution
 * order:
 *   1. Cached `users.google_calendar_id` (fastest path).
 *   2. Scan the user's calendarList for an existing calendar whose
 *      summary matches `GCAL_TARGET_CALENDAR_NAME` (default "Family").
 *      If found, cache and return its id — so a user who pre-created
 *      "Family" in Google with their own color/sharing keeps it.
 *   3. Create a new calendar with that summary (requires the full
 *      `calendar` write scope, not just `calendar.events`).
 */
export async function ensureChordCalendar(
  db: Kysely<DB>,
  userId: string,
  accessToken: string,
): Promise<string> {
  const row = await db
    .selectFrom('users')
    .select('google_calendar_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row?.google_calendar_id) return row.google_calendar_id;

  // 2. Look for an existing calendar with the configured name. Match
  // is case-insensitive on the trimmed summary so "family", "Family",
  // " Family " all hit. Pick the highest accessRole (owner > writer)
  // to avoid binding to a read-only shared calendar that'd 403 on
  // events.insert.
  const target = CHORD_CALENDAR_SUMMARY.trim().toLowerCase();
  if (target) {
    try {
      const listRes = await fetch(
        'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
        { headers: { authorization: `Bearer ${accessToken}` } },
      );
      if (listRes.ok) {
        const json = (await listRes.json()) as {
          items?: Array<{ id: string; summary?: string; accessRole?: string }>;
        };
        const matches = (json.items ?? []).filter(
          (c) =>
            (c.summary ?? '').trim().toLowerCase() === target &&
            (c.accessRole === 'owner' || c.accessRole === 'writer'),
        );
        // Owner wins over writer.
        matches.sort((a, b) => (a.accessRole === 'owner' ? -1 : 1));
        const match = matches[0];
        if (match) {
          await db
            .updateTable('users')
            .set({ google_calendar_id: match.id })
            .where('id', '=', userId)
            .execute();
          logger.info(
            `gcal: bound to existing calendar "${CHORD_CALENDAR_SUMMARY}" (${match.id}) for user=${userId}`,
          );
          return match.id;
        }
      }
    } catch (err) {
      // Listing failed — fall through to create. A subsequent write
      // attempt may still succeed if creation works.
      logger.warn('gcal: calendarList scan failed; falling through to create', {
        err: (err as Error).message,
      });
    }
  }

  // 3. Create.
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ summary: CHORD_CALENDAR_SUMMARY }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gcal calendars.insert ${res.status}: ${body.slice(0, 300)}`);
  }
  const cal = (await res.json()) as GcalCalendarResponse;
  await db
    .updateTable('users')
    .set({ google_calendar_id: cal.id })
    .where('id', '=', userId)
    .execute();
  logger.info(
    `gcal: created calendar "${CHORD_CALENDAR_SUMMARY}" (${cal.id}) for user=${userId}`,
  );
  return cal.id;
}
