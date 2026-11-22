/**
 * Whether an event (or another trip) clashes with a trip — ADR 0289.
 *
 * Time overlap alone is not enough when the trip names who is travelling: a
 * parent's dentist appointment does not clash with a child's school trip. So a
 * clash needs BOTH the time and a person in common. When the trip names nobody,
 * time alone decides, as before.
 *
 * Who an event is for: its assignee (a member, or a managed family member by
 * name), else the owner of that calendar copy — plus any traveller whose FIRST
 * name the title spells out ("Ben soccer"). First name only: a family shares
 * a surname, and "Doe dinner" is not about any one traveller.
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { fullName, resolveMetro } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { instantInZoneMs } from '../../utils/tz.js';
import { displayTravelerName, isNameSubset, nameTokens, tokenSetKey } from './chain.js';
import { loadTripNamedTravelers } from './travelers.js';

/** One person on a trip: a Chord member (by id) and/or a name off a ticket. */
export interface TripTraveler {
  userId: string | null;
  name: string | null;
}

/** One person an event is for. */
export interface PersonRef {
  userId: string | null;
  names: string[];
}

type NameRow = {
  username: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
};

export const memberName = (u: NameRow): string | null =>
  u.username
    ? fullName({
        username: u.username,
        displayName: u.display_name ?? undefined,
        firstName: u.first_name ?? undefined,
        lastName: u.last_name ?? undefined,
      })
    : null;

/** The people on each trip: members on it (`trip_participants`, a leg's
 *  `persona_id` — both user ids), anyone else said to be going
 *  (`trip_named_travelers`: family or friends, by name) and the names on its
 *  live tickets, in departure order. A trip that names nobody maps to an empty list. */
export async function loadTripTravelers(
  db: Kysely<DB>,
  tripIds: readonly string[],
  tz: string | null,
): Promise<Map<string, TripTraveler[]>> {
  const out = new Map<string, TripTraveler[]>();
  if (tripIds.length === 0) return out;
  const [participants, legs, familyMembers] = await Promise.all([
    db
      .selectFrom('trip_participants')
      .innerJoin('users', 'users.id', 'trip_participants.persona_id')
      .where('trip_participants.trip_id', 'in', [...tripIds])
      .select(['trip_participants.trip_id', 'users.id', 'users.username', 'users.display_name', 'users.first_name', 'users.last_name'])
      .execute(),
    db
      .selectFrom('travel_legs')
      .leftJoin('users', 'users.id', 'travel_legs.persona_id')
      .where('travel_legs.trip_id', 'in', [...tripIds])
      .where('travel_legs.cancelled_at', 'is', null)
      .select([
        'travel_legs.trip_id',
        'travel_legs.passenger_name',
        'users.id',
        'users.username',
        'users.display_name',
        'users.first_name',
        'users.last_name',
      ])
      .orderBy(sql`${textInstant('travel_legs.depart_at', tz)} asc`)
      .execute(),
    loadTripNamedTravelers(db, tripIds),
  ]);
  const add = (tripId: string, t: TripTraveler): void => {
    if (!t.userId && !t.name) return;
    const list = out.get(tripId) ?? [];
    list.push(t);
    out.set(tripId, list);
  };
  for (const p of participants) add(p.trip_id, { userId: p.id, name: memberName(p) });
  for (const [tripId, list] of familyMembers) {
    for (const p of list) add(tripId, { userId: null, name: p.name });
  }
  for (const l of legs) {
    if (l.id) add(l.trip_id, { userId: l.id, name: memberName(l) });
    if (l.passenger_name) add(l.trip_id, { userId: null, name: l.passenger_name });
  }
  return out;
}

function sameName(a: string, b: string): boolean {
  const ta = nameTokens(displayTravelerName(a));
  const tb = nameTokens(displayTravelerName(b));
  if (ta.length === 0 || tb.length === 0) return false;
  return tokenSetKey(ta) === tokenSetKey(tb) || isNameSubset(ta, tb);
}

/** True when the person is one of the trip's travellers. */
export function isOnTrip(person: PersonRef, travelers: readonly TripTraveler[]): boolean {
  return travelers.some(
    (t) =>
      (!!person.userId && t.userId === person.userId) ||
      (!!t.name && person.names.some((n) => sameName(n, t.name!))),
  );
}

/** An event overlapping a trip in time clashes with it only if one of its
 *  people is travelling; a trip that names nobody clashes on time alone. The
 *  title is not read: "Send Ben money" during Ben's trip is something his
 *  parent does, not something Ben misses. */
export function eventClashesWithTrip(
  event: { title: string; people: readonly PersonRef[] },
  travelers: readonly TripTraveler[],
): boolean {
  if (travelers.length === 0) return true;
  return event.people.some((p) => isOnTrip(p, travelers));
}

/** Two overlapping trips clash only if someone is on both; when either names
 *  nobody, time alone decides. */
export function tripsClash(a: readonly TripTraveler[], b: readonly TripTraveler[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((t) => isOnTrip({ userId: t.userId, names: t.name ? [t.name] : [] }, b));
}

/** One side of an event-to-event overlap. `ticketTravelers` is set when the
 *  event is a ticket's (a travel leg's) calendar entry: it is then about that
 *  trip's travellers, not the calendar's owner. */
export interface OverlapSide {
  title: string;
  people: readonly PersonRef[];
  ticketTravelers: readonly TripTraveler[] | null;
  /** The trip the ticket belongs to, when known. */
  ticketTripId?: string | null;
}

/**
 * Two calendar events that overlap in time. Two of the user's own events always
 * clash. A ticket clashes with another ticket only if someone is on both trips,
 * and with an ordinary event only if that event's person is travelling — the
 * same rule a trip follows (ADR 0289). Two entries for the same trip at the
 * same time are one journey written twice, never a clash.
 */
export function eventsClash(a: OverlapSide, b: OverlapSide): boolean {
  if (!a.ticketTravelers && !b.ticketTravelers) return true;
  if (a.ticketTripId && a.ticketTripId === b.ticketTripId) return false;
  if (a.ticketTravelers && b.ticketTravelers) return tripsClash(a.ticketTravelers, b.ticketTravelers);
  const [ticket, other] = a.ticketTravelers ? [a, b] : [b, a];
  return eventClashesWithTrip({ title: other.title, people: other.people }, ticket.ticketTravelers!);
}

const TICKET_UID_PREFIX = 'chord:travel_leg:';

/** An event to classify; everything else about it is read from its row. */
type EventUid = { id: string };

export interface TicketTrip {
  tripId: string | null;
  travelers: TripTraveler[];
}

/** How far an entry's start may sit from a departure and still be that departure. */
const SAME_DEPARTURE_MS = 10 * 60_000;

/** The metros named anywhere in `text`: each run of one to three words, and
 *  each word as an airport code. */
function metrosIn(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.split(/[^A-Za-z]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      const metro = resolveMetro(words.slice(i, i + n).join(' '));
      if (metro) out.add(metro);
    }
  }
  return out;
}

type LegCandidate = {
  trip_id: string;
  depart_at: string;
  origin: string;
  destination: string;
  flight_no: string | null;
};

/** How surely an entry starting at `startMs` and reading `text` is this leg:
 *  0 = not it; it must leave at the same time, then 2 = the text names the
 *  flight number or where it goes, 1 = only where it leaves from (two
 *  journeys leaving New York at once both fit that). */
export function legMatchStrength(startMs: number, text: string, leg: LegCandidate, tz: string | null): 0 | 1 | 2 {
  const departMs = instantInZoneMs(leg.depart_at, tz);
  if (!(Math.abs(departMs - startMs) <= SAME_DEPARTURE_MS)) return 0;
  const lower = text.toLowerCase();
  const named = metrosIn(text);
  const names = (place: string): boolean => {
    const metro = resolveMetro(place);
    if (metro && named.has(metro)) return true;
    const code = place.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
    return code.length >= 3 && new RegExp(`\\b${code}\\b`).test(lower);
  };
  const flightNo = leg.flight_no?.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (flightNo && flightNo.length >= 2 && new RegExp(`\\b${flightNo}\\b`).test(lower)) return 2;
  if (names(leg.destination)) return 2;
  return names(leg.origin) ? 1 : 0;
}

/**
 * For each event among `events` that is a ticket, its trip and that trip's
 * travellers. In order:
 *  1. the user said which trip it is part of, or that it is not travel
 *     (`trip_link = 'user'`) - that wins;
 *  2. a travel leg's own calendar entry (`chord:travel_leg:<legId>`);
 *  3. a trip the matcher found before (`trip_link = 'auto'`), while that trip
 *     is live;
 *  4. otherwise the matcher: an entry departing when a leg on a trip the
 *     event's owner can see departs and naming its route or flight - the same
 *     journey arriving from Google, the phone or an email. What it finds is
 *     saved on the event (`trip_link = 'auto'`), so the entry stays that
 *     trip's and can be corrected once.
 * Other events are absent. A trip that names nobody maps to no travellers.
 */
export async function ticketTrips(
  db: Kysely<DB>,
  events: ReadonlyArray<EventUid>,
  tz: string | null,
): Promise<Map<string, TicketTrip>> {
  const out = new Map<string, TicketTrip>();
  const ids = [...new Set(events.map((e) => e.id))];
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom('events')
    .leftJoin('trips', (j) =>
      j
        .onRef('trips.id', '=', 'events.trip_id')
        .on('trips.deleted_at', 'is', null)
        .on('trips.cancelled_at', 'is', null),
    )
    .where('events.id', 'in', ids)
    .select([
      'events.id',
      'events.external_uid',
      'events.starts_at',
      'events.title',
      'events.location',
      'events.owner_user_id',
      'events.trip_id',
      'events.trip_link',
      'trips.id as live_trip_id',
    ])
    .execute();

  const tripOfEvent = new Map<string, string | null>();
  const legOf = new Map<string, string>();
  const others: typeof rows = [];
  for (const r of rows) {
    if (r.trip_link === 'user') {
      if (r.trip_id && r.live_trip_id) tripOfEvent.set(r.id, r.trip_id);
      continue;
    }
    if (r.external_uid?.startsWith(TICKET_UID_PREFIX)) {
      legOf.set(r.id, r.external_uid.slice(TICKET_UID_PREFIX.length));
      continue;
    }
    if (r.trip_link === 'auto' && r.live_trip_id) {
      tripOfEvent.set(r.id, r.live_trip_id);
      continue;
    }
    if (r.starts_at && r.owner_user_id && (r.title || r.location)) others.push(r);
  }
  if (legOf.size > 0) {
    const legs = await db
      .selectFrom('travel_legs')
      .select(['id', 'trip_id'])
      .where('id', 'in', [...new Set(legOf.values())])
      .execute();
    const tripOfLeg = new Map(legs.map((l) => [l.id, l.trip_id]));
    for (const [eventId, legId] of legOf) tripOfEvent.set(eventId, tripOfLeg.get(legId) ?? null);
  }
  if (others.length > 0) {
    const starts = others.map((e) => instantInZoneMs(e.starts_at, tz)).filter((ms) => Number.isFinite(ms));
    if (starts.length > 0) {
      const lo = new Date(Math.min(...starts) - SAME_DEPARTURE_MS - 36 * 3_600_000).toISOString();
      const hi = new Date(Math.max(...starts) + SAME_DEPARTURE_MS + 36 * 3_600_000).toISOString();
      const owners = [...new Set(others.map((e) => e.owner_user_id!))];
      const legs = await db
        .selectFrom('travel_legs')
        .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
        .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
        .where('group_members.user_id', 'in', owners)
        .where('travel_legs.cancelled_at', 'is', null)
        .where('trips.cancelled_at', 'is', null)
        .where('trips.deleted_at', 'is', null)
        .where(textInstant('travel_legs.depart_at', tz), '>=', lo)
        .where(textInstant('travel_legs.depart_at', tz), '<=', hi)
        .select([
          'group_members.user_id as member',
          'travel_legs.trip_id',
          'travel_legs.depart_at',
          'travel_legs.origin',
          'travel_legs.destination',
          'travel_legs.flight_no',
        ])
        .execute();
      for (const e of others) {
        const startMs = instantInZoneMs(e.starts_at, tz);
        const text = `${e.title ?? ''} ${e.location ?? ''}`;
        const scored = legs
          .filter((l) => l.member === e.owner_user_id)
          .map((l) => ({ trip: l.trip_id, strength: legMatchStrength(startMs, text, l, tz) }));
        const best = Math.max(0, ...scored.map((s) => s.strength));
        const trips = new Set(scored.filter((s) => best > 0 && s.strength === best).map((s) => s.trip));
        // Two different trips fit equally well: not sure which journey it is,
        // so it stays an ordinary event.
        if (trips.size !== 1) continue;
        const tripId = [...trips][0]!;
        tripOfEvent.set(e.id, tripId);
        // Never over a user's own answer, which may have landed meanwhile.
        await db
          .updateTable('events')
          .set({ trip_id: tripId, trip_link: 'auto' })
          .where('id', '=', e.id)
          .where((eb) => eb.or([eb('trip_link', 'is', null), eb('trip_link', '=', 'auto')]))
          .execute();
      }
    }
  }
  if (tripOfEvent.size === 0) return out;
  const travelers = await loadTripTravelers(
    db,
    [...new Set([...tripOfEvent.values()].filter((t): t is string => !!t))],
    tz,
  );
  for (const [eventId, tripId] of tripOfEvent) {
    out.set(eventId, { tripId, travelers: tripId ? (travelers.get(tripId) ?? []) : [] });
  }
  return out;
}

/** `ticketTrips`, travellers only. */
export async function ticketTravelers(
  db: Kysely<DB>,
  events: ReadonlyArray<EventUid>,
  tz: string | null,
): Promise<Map<string, TripTraveler[]>> {
  const trips = await ticketTrips(db, events, tz);
  return new Map([...trips].map(([id, t]) => [id, t.travelers]));
}

/**
 * The events among `events` that are someone else's ticket: on a trip that
 * names its travellers, none of whom is `userId`. Ben's flight sits on his
 * parent's calendar, but it is not the parent's time. A trip that names nobody
 * is treated as the user's.
 */
export async function ticketsForOthers(
  db: Kysely<DB>,
  userId: string,
  events: ReadonlyArray<EventUid>,
  tz: string | null,
): Promise<Set<string>> {
  const out = new Set<string>();
  const tickets = await ticketTravelers(db, events, tz);
  if (tickets.size === 0) return out;
  const user = await db
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'first_name', 'last_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const me: PersonRef = {
    userId,
    names: user ? [memberName(user), user.display_name].filter((n): n is string => !!n) : [],
  };
  for (const [eventId, onTrip] of tickets) {
    if (onTrip.length > 0 && !isOnTrip(me, onTrip)) out.add(eventId);
  }
  return out;
}

/** Who each event is for: its assignee if it has one, else the owner of that
 *  calendar copy and, when someone else made it (a child's own event shared to
 *  the family), its maker too. */
export async function loadEventPeople(
  db: Kysely<DB>,
  eventIds: readonly string[],
): Promise<Map<string, PersonRef[]>> {
  const out = new Map<string, PersonRef[]>();
  if (eventIds.length === 0) return out;
  const rows = await db
    .selectFrom('events')
    .leftJoin('personas', 'personas.id', 'events.assignee_persona_id')
    .where('events.id', 'in', [...eventIds])
    .select([
      'events.id',
      'events.owner_user_id',
      'events.assignee_id',
      'events.assignee_persona_id',
      'events.created_by',
      'personas.name as persona_name',
      'personas.member_user_id as persona_user_id',
    ])
    .execute();
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.assignee_persona_id) {
      if (r.persona_user_id) userIds.add(r.persona_user_id);
    } else {
      const u = r.assignee_id ?? r.owner_user_id;
      if (u) userIds.add(u);
      if (!r.assignee_id && r.created_by) userIds.add(r.created_by);
    }
  }
  const users = userIds.size
    ? await db
        .selectFrom('users')
        .where('id', 'in', [...userIds])
        .select(['id', 'username', 'display_name', 'first_name', 'last_name'])
        .execute()
    : [];
  const namesOf = new Map(
    users.map((u) => [u.id, [memberName(u), u.display_name].filter((n): n is string => !!n)]),
  );
  for (const r of rows) {
    if (r.assignee_persona_id) {
      const userId = r.persona_user_id ?? null;
      const names = [r.persona_name, ...(userId ? namesOf.get(userId) ?? [] : [])].filter(
        (n): n is string => !!n,
      );
      out.set(r.id, [{ userId, names }]);
      continue;
    }
    const ids = r.assignee_id ? [r.assignee_id] : [r.owner_user_id, r.created_by];
    out.set(
      r.id,
      [...new Set(ids.filter((id): id is string => !!id))].map((userId) => ({
        userId,
        names: namesOf.get(userId) ?? [],
      })),
    );
  }
  return out;
}

export type SetEventTripResult =
  | { ok: true; tripId: string | null }
  | { ok: false; reason: 'event_not_found' | 'trip_not_found' };

/**
 * The user's answer to "which trip is this entry part of": a trip, or `null`
 * for "not travel at all". Stored as `trip_link = 'user'`, which the matcher
 * never overwrites. Only the user's own calendar copy, and only a live trip in
 * a group they belong to. The one writer for the chat tool.
 */
export async function setEventTrip(
  db: Kysely<DB>,
  opts: { eventId: string; userId: string; tripId: string | null },
): Promise<SetEventTripResult> {
  const event = await db
    .selectFrom('events')
    .select('id')
    .where('id', '=', opts.eventId)
    .where('owner_user_id', '=', opts.userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!event) return { ok: false, reason: 'event_not_found' };
  if (opts.tripId) {
    const trip = await db
      .selectFrom('trips')
      .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
      .select('trips.id')
      .where('trips.id', '=', opts.tripId)
      .where('group_members.user_id', '=', opts.userId)
      .where('trips.deleted_at', 'is', null)
      .where('trips.cancelled_at', 'is', null)
      .executeTakeFirst();
    if (!trip) return { ok: false, reason: 'trip_not_found' };
  }
  await db
    .updateTable('events')
    .set({ trip_id: opts.tripId, trip_link: 'user' })
    .where('id', '=', opts.eventId)
    .execute();
  return { ok: true, tripId: opts.tripId };
}
