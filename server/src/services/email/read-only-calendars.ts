import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

/** The calendar an event row was pulled from, if any: an explicit
 *  `google_calendar_id`, else the one in a `gcal:<cal>:…` / `device:<cal>:…`
 *  key. A bare `gcal:<id>` is the primary, which is the user's own. */
export function sourceCalendarOf(row: { google_calendar_id: string | null; external_uid: string | null }): string | null {
  if (row.google_calendar_id) return row.google_calendar_id;
  const uid = row.external_uid ?? '';
  for (const prefix of ['gcal:', 'device:']) {
    if (!uid.startsWith(prefix)) continue;
    const rest = uid.slice(prefix.length);
    const sep = rest.indexOf(':');
    return sep === -1 ? null : rest.slice(0, sep);
  }
  return null;
}

/** Calendars the user can read but not change (a subscribed feed). */
export async function readOnlyCalendars(db: Kysely<DB>, userId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom('calendar_sources')
    .select('google_calendar_id')
    .where('user_id', '=', userId)
    .where('access_role', 'in', ['reader', 'freeBusyReader'])
    .execute();
  return new Set(rows.map((r) => r.google_calendar_id));
}
