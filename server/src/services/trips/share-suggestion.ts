/**
 * ADR 0233 — which shared group, if any, a personal trip should be OFFERED to.
 *
 * A trip is useful to the family ("helps with planning if one person is
 * traveling"), but it starts personal like everything else (ADR 0232) and
 * sharing is a suggestion the user answers, never something that happens.
 *
 * Two signals, strongest first, both deterministic:
 *   1. someone in a shared group is NAMED on the trip — a leg's passenger, or
 *      the trip's own name ("Aarav's soccer tournament"). Same matcher as the
 *      event offer, so the two never disagree about what "names someone" means.
 *   2. otherwise, if the asker is in exactly ONE shared group with other people
 *      in it, that is their family: a trip is offered to it even with no name on
 *      it, since a booking in the mailbox usually names only the traveller.
 * With several groups and no name to choose between them, nothing is offered:
 * a guess between "Family" and "Soccer Team" is a question the user did not ask.
 *
 * Only a trip still in the asker's PERSONAL group, not deleted or cancelled and
 * not already over, is offered. Only group names the user sees leave this file
 * (ADR 0032, ADR 0101).
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { suggestFanoutGroups, type FanoutCandidate } from '../events/fanout-suggestion.js';
import { counterpartNames } from '../groups.service.js';

export async function suggestTripShareGroups(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
  now: Date = new Date(),
): Promise<FanoutCandidate[]> {
  const trip = await db
    .selectFrom('trips as t')
    .innerJoin('groups as g', 'g.id', 't.group_id')
    .select(['t.name as name', 't.destination as destination', 't.end_date as endDate', 't.created_by as createdBy'])
    .where('t.id', '=', tripId)
    .where('t.deleted_at', 'is', null)
    .where('t.cancelled_at', 'is', null)
    .where('g.kind', '=', 'personal')
    .executeTakeFirst();
  if (!trip || trip.createdBy !== userId) return [];
  // End dates are plain days; a day of slack keeps a trip ending today offerable
  // whatever zone the server's clock is in.
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (trip.endDate < yesterday) return [];

  const passengers = await db
    .selectFrom('travel_legs')
    .leftJoin('users', 'users.id', 'travel_legs.persona_id')
    .select(['travel_legs.passenger_name', 'users.display_name', 'users.username'])
    .where('travel_legs.trip_id', '=', tripId)
    .execute();
  // A family member on a leg is named by their display name, like a raw name.
  const text = [
    trip.name,
    ...passengers.map((p) => p.passenger_name ?? (p.display_name || p.username)),
  ]
    .filter(Boolean)
    .join(' . ');
  const named = await suggestFanoutGroups(db, userId, text);
  if (named.length > 0) return named;

  const all = await db
    .selectFrom('group_members as gm')
    .innerJoin('groups as g', 'g.id', 'gm.group_id')
    .select([
      'g.id as id',
      'g.kind as kind',
      'g.name as name',
      'g.name_is_custom as name_is_custom',
      'g.family_owner_id as familyOwnerId',
    ])
    .where('gm.user_id', '=', userId)
    .where('g.kind', '=', 'group')
    .execute();
  // ADR 0234 — the family's own chat is where a trip is wanted even when the
  // asker is also in a soccer team and a book club; with no family chat the
  // old rule holds (one shared group, else nothing).
  const family = all.filter((g) => g.familyOwnerId);
  const shared = family.length === 1 ? family : all;
  if (shared.length !== 1) return [];
  const others = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', shared[0]!.id)
    .where('user_id', '!=', userId)
    .executeTakeFirst();
  if (!others) return [];
  const shown = await counterpartNames(db, userId, shared);
  return [{ id: shared[0]!.id, name: shown.get(shared[0]!.id) ?? shared[0]!.name }];
}
