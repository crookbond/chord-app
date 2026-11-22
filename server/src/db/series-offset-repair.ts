/**
 * Repair repeating-event occurrences stored with the wrong UTC offset.
 *
 * `storedStart` writes an occurrence as `<local wall time><offset>`. Until
 * 2026-10-31 the offset came from a one-pass conversion that read it at the
 * wall time taken as UTC, hours from the real instant, so an occurrence in
 * the hours around a clock change got the old offset: a weekly Sunday 8:00
 * Los Angeles event's 1 Nov occurrence was stored as 08:00-07:00 (7:00 PST).
 * The 365-day materialization had already written such rows for the next
 * spring change too.
 *
 * A row is changed only when its offset is EXACTLY what the old conversion
 * produced for its wall time in the series zone AND that differs from the
 * correct one. That is the bug's fingerprint; an occurrence the user moved
 * to a different time, or one stored in another shape, is left alone. The
 * local wall time is kept; only the offset is rewritten. Idempotent.
 */
import type { Kysely } from 'kysely';

import { logger } from '../config/logging.js';
import { offsetForLocalDatetime, svWall } from '../utils/tz.js';
import type { DB } from './schema.js';

const WALL_WITH_OFFSET = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/;

/** The offset the old one-pass conversion gave `wall` in `tz`. */
function oldOffset(wall: string, tz: string): string {
  const naive = Date.parse(`${wall}Z`);
  const drift = Date.parse(`${svWall(new Date(naive), tz).replace(' ', 'T')}Z`) - naive;
  const m = Math.round(drift / 60000);
  const abs = Math.abs(m);
  return `${m >= 0 ? '+' : '-'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** The corrected value, or null when `stored` does not carry the bug. */
export function repairedOffset(stored: string | null | undefined, tz: string): string | null {
  const m = stored ? WALL_WITH_OFFSET.exec(stored) : null;
  if (!m) return null;
  const [, wall, offset] = m;
  try {
    const right = offsetForLocalDatetime(tz, wall);
    if (offset === right || offset !== oldOffset(wall, tz)) return null;
    return `${wall}${right}`;
  } catch {
    return null;
  }
}

export async function repairSeriesOffsets(db: Kysely<DB>): Promise<number> {
  const rows = await db
    .selectFrom('events')
    .innerJoin('event_series', 'event_series.id', 'events.series_id')
    .select(['events.id as id', 'events.starts_at', 'events.ends_at', 'events.original_start', 'event_series.tz'])
    .execute();
  let fixed = 0;
  for (const r of rows) {
    const patch: { starts_at?: string; ends_at?: string; original_start?: string } = {};
    const start = repairedOffset(r.starts_at, r.tz);
    if (start) patch.starts_at = start;
    const end = repairedOffset(r.ends_at, r.tz);
    if (end) patch.ends_at = end;
    const original = repairedOffset(r.original_start, r.tz);
    if (original) patch.original_start = original;
    if (Object.keys(patch).length === 0) continue;
    await db.updateTable('events').set(patch).where('id', '=', r.id).execute();
    fixed += 1;
  }
  if (fixed > 0) logger.info('repeating-event occurrences re-offset after the clock-change fix', { fixed });
  return fixed;
}
