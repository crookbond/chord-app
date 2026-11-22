/**
 * Trips Chord asked "who is going?" about and has no answer for yet (ADR 0289
 * addendum). The question is posted when a trip names nobody, in place of a
 * conflict check that would have had to guess. The answer ("it's Ben") has
 * no trip in it and arrives in a later turn, so the trip id is kept here and
 * read back into the prompt until set_trip_passengers answers it (ADR 0166's
 * pattern for a question whose referent dies with the turn).
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { deletePendingState, getPendingState, putPendingState } from './pending-state.js';

const TTL_MS = 3 * 24 * 60 * 60_000;

export interface PendingTripTravelers {
  tripId: string;
  tripName: string;
  dates: string;
  at: number;
}

const fresh = (list: PendingTripTravelers[]): PendingTripTravelers[] =>
  list.filter((e) => e.at >= Date.now() - TTL_MS);

export async function listPendingTripTravelers(
  db: Kysely<DB>,
  userId: string,
): Promise<PendingTripTravelers[]> {
  return fresh((await getPendingState<PendingTripTravelers[]>(db, 'trip_travelers', userId)) ?? []);
}

export async function recordPendingTripTravelers(
  db: Kysely<DB>,
  userId: string,
  trip: Omit<PendingTripTravelers, 'at'>,
): Promise<void> {
  const rest = (await listPendingTripTravelers(db, userId)).filter((e) => e.tripId !== trip.tripId);
  await putPendingState(db, 'trip_travelers', userId, [...rest, { ...trip, at: Date.now() }], TTL_MS);
}

/** Drop the question about `tripId`. True when it had been asked. */
export async function answerPendingTripTravelers(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
): Promise<boolean> {
  const list = await listPendingTripTravelers(db, userId);
  const rest = list.filter((e) => e.tripId !== tripId);
  if (rest.length === list.length) return false;
  if (rest.length === 0) await deletePendingState(db, 'trip_travelers', userId);
  else await putPendingState(db, 'trip_travelers', userId, rest, TTL_MS);
  return true;
}
