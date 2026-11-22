/**
 * Where the user will be on a given day, read off their trips (ADR 0245).
 *
 * The reply drafter offered in-person times on days a trip puts the user in
 * another city: the calendar's busy blocks say when someone is occupied, not
 * where they are. This reads trips, travel legs and stays, and says for each
 * local day whether the user is away and in which city. It decides nothing
 * about a meeting; `availability.service` attaches the fact to the day.
 *
 * Deterministic and trip data only: no model, and nothing inferred from mail.
 * Cancelled legs, stays and trips (ADR 0168) and deleted trips (ADR 0171)
 * never count.
 */
import type { Kysely } from 'kysely';

import { metroCity, resolvePlaceMetro } from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { instantMs } from '../db/text-instant.js';
import { isNameSubset, nameTokens, samePlaceText, tokenSetKey } from './trips/chain.js';

export interface AwayDay {
  /** `YYYY-MM-DD`. Leg and stay dates are taken as written, on their own clocks. */
  day: string;
  /** Cities the user is in that day, for display: one for a day spent there,
   *  the two ends for a day of travel. */
  places: string[];
  /** The same places as metro keys, where the table knows them. */
  metros: string[];
  /** Set on a day the user is in transit. */
  travel: { from: string; to: string } | null;
  tripName: string;
}

const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const display = (place: string): string => metroCity(resolvePlaceMetro(place)) ?? place.trim();

/**
 * The user's home, as a place string, or null when nothing says.
 *
 * In order: the weather location they set or confirmed (ADR 0091), then a
 * confirmed `home_airport` fact about them. With neither, each trip's own
 * starting point stands in for home (a chain closes where it began, ADR
 * 0190), which is decided per trip in `userAwayDays`.
 */
export async function userHomePlace(db: Kysely<DB>, userId: string): Promise<string | null> {
  const me = await db
    .selectFrom('users')
    .select(['weather_place', 'weather_place_source'])
    .where('id', '=', userId)
    .executeTakeFirst();
  // Only a place the user gave. One derived from an IP address or a time
  // zone follows them around and may BE the trip.
  if (me?.weather_place && me.weather_place_source === 'user') return me.weather_place;
  const fact = await db
    .selectFrom('memories')
    .select('value')
    // A fact about the user is subject_type 'user' (persona_id on older rows
    // is the same user id, not a personas row).
    .where((eb) =>
      eb.or([
        eb.and([eb('subject_type', '=', 'user'), eb('subject_id', '=', userId)]),
        eb('persona_id', '=', userId),
      ]),
    )
    .where('key', '=', 'home_airport')
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return fact?.value ?? null;
}

/**
 * The days in `[fromDay, toDay]` a trip puts the user away from home.
 *
 * Whose trip: a trip in a group the user belongs to counts when the user is
 * on it: named as a participant, named on a leg (their persona, or a
 * passenger name that is theirs), or, when nobody is named anywhere on it,
 * when they created it. A trip whose legs and participants all name other
 * people is someone else's travel.
 *
 * Where, per day:
 * - a leg's departure day through its arrival day is a TRAVEL day between
 *   its two ends;
 * - from the day after arriving somewhere that is not home, until the day
 *   before the next leg leaves (or the trip's last day, when no leg brings
 *   them back), the user is in that city;
 * - a stay's check-in day through its check-out day is in the stay's city,
 *   unless that city is home.
 */
export async function userAwayDays(
  db: Kysely<DB>,
  userId: string,
  opts: { fromDay: string; toDay: string },
): Promise<Map<string, AwayDay>> {
  const out = new Map<string, AwayDay>();
  const trips = await db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .select([
      'trips.id as id',
      'trips.name as name',
      'trips.destination as destination',
      'trips.start_date as startDate',
      'trips.end_date as endDate',
      'trips.created_by as createdBy',
    ])
    .where('group_members.user_id', '=', userId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .where('trips.end_date', '>=', addDays(opts.fromDay, -1))
    .where('trips.start_date', '<=', addDays(opts.toDay, 1))
    .execute();
  if (trips.length === 0) return out;
  const tripIds = trips.map((t) => t.id);

  const legs = await db
    .selectFrom('travel_legs')
    .select([
      'travel_legs.trip_id as tripId',
      'travel_legs.persona_id as personaId',
      'travel_legs.passenger_name as passengerName',
      'travel_legs.origin as origin',
      'travel_legs.destination as destination',
      'travel_legs.depart_at as departAt',
      'travel_legs.arrive_at as arriveAt',
    ])
    .where('travel_legs.trip_id', 'in', tripIds)
    .where('travel_legs.cancelled_at', 'is', null)
    .execute();
  const stays = await db
    .selectFrom('accommodations')
    .select(['trip_id as tripId', 'property_name as propertyName', 'address', 'checkin_date as checkin', 'checkout_date as checkout'])
    .where('trip_id', 'in', tripIds)
    .where('cancelled_at', 'is', null)
    .execute();
  // `persona_id` on trip_participants and travel_legs is a USER id (the
  // foreign key points at users), not a personas row.
  const participants = await db
    .selectFrom('trip_participants')
    .select(['trip_id as tripId', 'persona_id as userId'])
    .where('trip_id', 'in', tripIds)
    .execute();

  const me = await db
    .selectFrom('users')
    .select(['display_name', 'username', 'first_name', 'last_name', 'preferred_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const myNames = [
    me?.display_name,
    [me?.first_name, me?.last_name].filter(Boolean).join(' '),
    me?.preferred_name,
    me?.username,
  ]
    .map((n) => nameTokens(n))
    .filter((t) => t.length > 0);
  const isMyName = (name: string | null): boolean => {
    const t = nameTokens(name);
    return t.length > 0 && myNames.some((mine) => tokenSetKey(mine) === tokenSetKey(t) || isNameSubset(mine, t));
  };

  const home = await userHomePlace(db, userId);
  const sameCity = (a: string, b: string): boolean => {
    const ma = resolvePlaceMetro(a);
    const mb = resolvePlaceMetro(b);
    return ma && mb ? ma === mb : samePlaceText(a, b);
  };

  const mark = (day: string, place: string, tripName: string, travel: AwayDay['travel']): void => {
    if (day < opts.fromDay || day > opts.toDay) return;
    const held = out.get(day) ?? { day, places: [], metros: [], travel: null, tripName };
    const shown = display(place);
    if (!held.places.includes(shown)) held.places.push(shown);
    const metro = resolvePlaceMetro(place);
    if (metro && !held.metros.includes(metro)) held.metros.push(metro);
    if (travel) held.travel = { from: display(travel.from), to: display(travel.to) };
    out.set(day, held);
  };

  for (const trip of trips) {
    const tripLegs = legs.filter((l) => l.tripId === trip.id);
    const named = (l: (typeof tripLegs)[number]): boolean => !!l.personaId || !!l.passengerName;
    const mine = (l: (typeof tripLegs)[number]): boolean =>
      l.personaId === userId || (!l.personaId && isMyName(l.passengerName));
    const people = participants.filter((p) => p.tripId === trip.id);
    const myLegsNamed = tripLegs.filter(mine);
    const nobodyNamed = people.length === 0 && !tripLegs.some(named);
    const onTrip =
      people.some((p) => p.userId === userId) ||
      myLegsNamed.length > 0 ||
      (nobodyNamed && trip.createdBy === userId);
    if (!onTrip) continue;

    const myLegs = tripLegs
      .filter((l) => mine(l) || !named(l))
      .sort((a, b) => (instantMs(a.departAt) ?? 0) - (instantMs(b.departAt) ?? 0));
    const tripHome = home ?? myLegs[0]?.origin ?? null;
    const isHome = (place: string): boolean => !!tripHome && sameCity(place, tripHome);

    myLegs.forEach((leg, i) => {
      const departDay = leg.departAt.slice(0, 10);
      const arriveDay = leg.arriveAt.slice(0, 10);
      for (let d = departDay; d <= arriveDay; d = addDays(d, 1)) {
        for (const place of [leg.origin, leg.destination]) {
          mark(d, place, trip.name, { from: leg.origin, to: leg.destination });
        }
      }
      if (isHome(leg.destination)) return;
      const next = myLegs[i + 1];
      const until = next ? addDays(next.departAt.slice(0, 10), -1) : trip.endDate;
      for (let d = addDays(arriveDay, 1); d <= until; d = addDays(d, 1)) {
        mark(d, leg.destination, trip.name, null);
      }
    });

    for (const stay of stays.filter((s) => s.tripId === trip.id)) {
      const place = resolvePlaceMetro(stay.address) ? stay.address! : resolvePlaceMetro(trip.destination) ? trip.destination : (stay.address ?? stay.propertyName);
      if (isHome(place)) continue;
      for (let d = stay.checkin; d <= stay.checkout; d = addDays(d, 1)) {
        mark(d, place, trip.name, null);
      }
    }
  }
  return out;
}

/** "in Denver", or "travelling New York → Denver" for a day in transit. */
export function describeAway(a: AwayDay): string {
  return a.travel ? `travelling ${a.travel.from} → ${a.travel.to}` : `in ${a.places.join(' / ')}`;
}
