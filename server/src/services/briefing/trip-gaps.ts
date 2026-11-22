/**
 * "Accommodation pending" is worth saying twice, not every morning. A trip
 * often has no hotel on purpose (staying with family, a day trip), and the
 * same line in every briefing teaches the reader to skip the section.
 *
 * Counted by DAY mentioned, not by briefing built: a briefing that fails and
 * is rebuilt the same morning must not use up a mention. Kept per trip and
 * gap ("no accommodation", "no travel legs"); entries for trips that are no
 * longer on the radar are dropped when the record is rewritten.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/schema.js';
import { defineUserDefault } from '../user-defaults.service.js';

export const TRIP_GAP_MAX_MENTIONS = 2;

const tripGapsTold = defineUserDefault(
  'briefing_trip_gaps_told',
  z.record(z.string(), z.array(z.string()).max(TRIP_GAP_MAX_MENTIONS)),
);

/** Which gaps to mention today, and the record to store after. */
export function decideTripGaps(
  told: Record<string, string[]>,
  gapKeys: readonly string[],
  today: string,
): { show: Set<string>; next: Record<string, string[]> } {
  const show = new Set<string>();
  const next: Record<string, string[]> = {};
  for (const key of gapKeys) {
    const days = told[key] ?? [];
    if (days.includes(today)) {
      show.add(key);
      next[key] = days;
    } else if (days.length < TRIP_GAP_MAX_MENTIONS) {
      show.add(key);
      next[key] = [...days, today];
    } else {
      next[key] = days;
    }
  }
  return { show, next };
}

/** Today's gaps to mention, recording the mention. */
export async function tripGapsToMention(
  db: Kysely<DB>,
  userId: string,
  gapKeys: readonly string[],
  today: string,
): Promise<Set<string>> {
  const told = (await tripGapsTold.get(db, userId)) ?? {};
  const { show, next } = decideTripGaps(told, gapKeys, today);
  if (JSON.stringify(next) !== JSON.stringify(told)) {
    await tripGapsTold.set(db, userId, Object.keys(next).length ? next : null);
  }
  return show;
}
