import type { TripStatus } from './types/trip';
import type { IsoDate } from './types/ids';

/**
 * Trip-archive classification (ADR 0046). "Archive" is a pure function of the
 * trip's end date and the current day — there is no stored flag. A trip is
 * archived once its last day has passed; its source documents archive with it.
 *
 * Dates are compared as `YYYY-MM-DD` strings (lexicographic == chronological
 * for ISO dates), matching the server's `pickActiveTrip` convention.
 */

/** Today's date as `YYYY-MM-DD`. Pass the clock in so callers stay testable. */
export function isoDay(now: Date): IsoDate {
  return now.toISOString().slice(0, 10);
}

/**
 * A trip is archived once its last day has passed. A trip that spans `today`
 * (startDate <= today <= endDate) is still live, not archived.
 */
export function isTripArchived(endDate: IsoDate, today: IsoDate): boolean {
  return endDate < today;
}

/**
 * The set of attachment ids that are source documents (`sourceDocId`) of legs
 * or stays belonging to archived trips. Used to archive a past trip's files
 * alongside the trip itself.
 */
export function archivedSourceDocIds(trips: TripStatus[], today: IsoDate): Set<string> {
  const ids = new Set<string>();
  for (const t of trips) {
    if (!isTripArchived(t.trip.endDate, today)) continue;
    for (const leg of t.legs) if (leg.sourceDocId) ids.add(leg.sourceDocId);
    for (const stay of t.accommodations) if (stay.sourceDocId) ids.add(stay.sourceDocId);
  }
  return ids;
}
