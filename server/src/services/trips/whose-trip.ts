/**
 * Whose trip it is, in words, for any message that mentions one — the morning
 * briefing and the check that runs when an event is added both name it, so
 * one rule decides it.
 *
 * Named travellers when anyone is named (Chord members on the trip first —
 * `persona_id` on both tables is a user id — then anyone else said to be going
 * (`trip_named_travelers`, family or friends), then the names on the tickets,
 * cancelled legs left out). Otherwise who booked it, ADR 0190's rule for
 * whose trip it is, said as "booked by" because the booker may not be going.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { fullName } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { tripTravelerNames } from './chain.js';
import { loadTripNamedTravelers } from './travelers.js';

type NameRow = {
  username: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
};

const memberName = (u: NameRow): string | null =>
  u.username
    ? fullName({
        username: u.username,
        displayName: u.display_name ?? undefined,
        firstName: u.first_name ?? undefined,
        lastName: u.last_name ?? undefined,
      })
    : null;

/** Trip id → "travelers: A, B" or "booked by: C"; absent when neither is known. */
export async function whoseTrips(
  db: Kysely<DB>,
  trips: ReadonlyArray<{ id: string; created_by: string | null }>,
  tz: string | null,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (trips.length === 0) return out;
  const tripIds = trips.map((t) => t.id);
  const creatorIds = [...new Set(trips.map((t) => t.created_by).filter((id): id is string => !!id))];
  const [legs, participants, creators, familyMembers] = await Promise.all([
    db
      .selectFrom('travel_legs')
      .leftJoin('users', 'users.id', 'travel_legs.persona_id')
      .where('travel_legs.trip_id', 'in', tripIds)
      .where('travel_legs.cancelled_at', 'is', null)
      .select([
        'travel_legs.trip_id',
        'travel_legs.passenger_name',
        'users.username',
        'users.display_name',
        'users.first_name',
        'users.last_name',
      ])
      .orderBy(sql`${textInstant('travel_legs.depart_at', tz)} asc`)
      .execute(),
    db
      .selectFrom('trip_participants')
      .innerJoin('users', 'users.id', 'trip_participants.persona_id')
      .where('trip_participants.trip_id', 'in', tripIds)
      .select([
        'trip_participants.trip_id',
        'users.username',
        'users.display_name',
        'users.first_name',
        'users.last_name',
      ])
      .execute(),
    creatorIds.length
      ? db
          .selectFrom('users')
          .where('id', 'in', creatorIds)
          .select(['id', 'username', 'display_name', 'first_name', 'last_name'])
          .execute()
      : Promise.resolve([]),
    loadTripNamedTravelers(db, tripIds),
  ]);

  const names = new Map<string, Array<string | null>>();
  const add = (tripId: string, name: string | null): void => {
    const list = names.get(tripId) ?? [];
    list.push(name);
    names.set(tripId, list);
  };
  for (const p of participants) add(p.trip_id, memberName(p));
  for (const [tripId, list] of familyMembers) for (const p of list) add(tripId, p.name);
  for (const l of legs) {
    add(l.trip_id, memberName(l));
    add(l.trip_id, l.passenger_name);
  }
  const creatorName = new Map(creators.map((u) => [u.id, memberName(u)]));

  for (const t of trips) {
    const travelers = tripTravelerNames(names.get(t.id) ?? []);
    if (travelers.length) {
      out.set(t.id, `travelers: ${travelers.join(', ')}`);
      continue;
    }
    const booker = t.created_by ? creatorName.get(t.created_by) : null;
    if (booker) out.set(t.id, `booked by: ${booker}`);
  }
  return out;
}
