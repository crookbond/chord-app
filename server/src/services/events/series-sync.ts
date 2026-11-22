/**
 * ADR 0217 — the parts of series handling the Google pull needs. Kept apart
 * from `series.service.ts`, which pushes through the two-way sync and would
 * otherwise import it in a cycle.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { localWallOf } from './recurrence.js';

/** One occurrence's `ical_uid`: shared by the family members' copies of that
 *  occurrence, never by two occurrences of a series. */
export function occurrenceUid(seriesUid: string, local: string): string {
  return `${seriesUid}:${local.slice(0, 16)}`;
}

/**
 * An occurrence Google removed (deleted there, or absent from a full pull):
 * exclude it from its series so the next top-up does not write it back. Not
 * marked dirty: Google already knows.
 */
export async function forgetOccurrence(
  db: Kysely<DB>,
  row: { series_id?: string | null; original_start?: string | null; starts_at: string },
): Promise<void> {
  if (!row.series_id) return;
  const series = await db
    .selectFrom('event_series')
    .select(['id', 'tz', 'exdates'])
    .where('id', '=', row.series_id)
    .executeTakeFirst();
  if (!series) return;
  const local = localWallOf(row.original_start ?? row.starts_at, series.tz);
  if (series.exdates.includes(local)) return;
  await db
    .updateTable('event_series')
    .set({ exdates: JSON.stringify([...series.exdates, local]) })
    .where('id', '=', series.id)
    .execute();
}
