/**
 * ADR 0153 — fill the blanks in a `suggest_external_action` query from what
 * the harness already knows about this family: the roster size, the household
 * airport and address, the live trip, a saved place.
 *
 * Runs in the executor (it needs `db`), so `buildExternalAction` stays a pure
 * function. Fills ONLY fields the model left blank, reads ONLY the triggering
 * group (ADR 0032), and is best-effort — any failure returns the query
 * untouched and the card still renders.
 */
import type { Kysely } from 'kysely';

import { flightDesignator } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { dayOf } from '../../utils/tz.js';
import { findUpcomingFlights } from '../trips.service.js';
import { findCalendarFlights } from './calendar-flights.js';
import type { ExternalActionKind, ExternalActionQuery } from './external-actions.js';

const PARTY_KINDS = new Set<ExternalActionKind>(['restaurant', 'takeout', 'hotel', 'activity']);
const CITY_KINDS = new Set<ExternalActionKind>(['restaurant', 'hotel', 'activity']);
const MAX_PARTY = 20;

/** A blank `map` term, or one that just says "home" — where a household
 *  address is the answer. */
const HOME_REF_RE = /^(home|house|our (home|house|place)|the (home|house|place))$/i;

/**
 * A confirmed `key` fact for this group — the household copy wins, else the
 * asker's own. Same lookup `home_airport` and `home_address` both need.
 */
async function householdOrOwnFact(
  db: Kysely<DB>,
  groupId: string,
  userId: string | null,
  key: string,
): Promise<string | null> {
  let sel = db
    .selectFrom('memories')
    .where('group_id', '=', groupId)
    .where('key', '=', key)
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null);
  sel = userId
    ? sel.where((eb) =>
        eb.or([
          eb('subject_type', '=', 'household'),
          eb.and([eb('subject_type', '=', 'user'), eb('subject_id', '=', userId)]),
        ]),
      )
    : sel.where('subject_type', '=', 'household');
  const rows = await sel.select(['value', 'subject_type']).execute();
  const pick = rows.find((r) => r.subject_type === 'household') ?? rows[0];
  return pick?.value?.trim() || null;
}

/** Rough lowercase token set, alnum runs of 3+ chars. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/** A saved place matches the model's name if one string contains the other or
 *  they share a 3+ char token. Deliberately generous — it only ever acts on a
 *  SINGLE match. */
function placeNameMatches(supplied: string, title: string): boolean {
  const a = supplied.toLowerCase().trim();
  const b = title.toLowerCase().trim();
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const ta = tokens(a);
  for (const t of tokens(b)) if (ta.has(t)) return true;
  return false;
}

export async function enrichExternalActionQuery(
  db: Kysely<DB>,
  ctx: { groupId: string; userId: string | null },
  kind: ExternalActionKind,
  query: ExternalActionQuery,
): Promise<ExternalActionQuery> {
  const q: ExternalActionQuery = { ...query };
  const { groupId, userId } = ctx;

  try {
    // The user's own day: a trip ending today is still "the trip" on their evening.
    const owner = userId
      ? await db.selectFrom('users').select('last_tz').where('id', '=', userId).executeTakeFirst()
      : undefined;
    const today = dayOf(new Date().toISOString(), owner?.last_tz ?? null);
    // ── partySize ← the roster count ────────────────────────────────────────
    // Personal groups have no personas (ADR 0151), so this naturally no-ops
    // in a 1:1.
    if (PARTY_KINDS.has(kind) && (q.partySize == null || q.partySize <= 0)) {
      const row = await db
        .selectFrom('personas')
        .where('group_id', '=', groupId)
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirst();
      const n = row ? Number(row.n) : 0;
      if (n >= 2) q.partySize = Math.min(n, MAX_PARTY);
    }

    // ── flight origin ← a home_airport fact ────────────────────────────────
    if (kind === 'flight' && !q.origin) {
      const airport = await householdOrOwnFact(db, groupId, userId, 'home_airport');
      if (airport) q.origin = airport;
    }

    // ── map destination ← the household address, when the ask is "home" ─────
    if (kind === 'map' && (!q.q?.trim() || HOME_REF_RE.test(q.q.trim()))) {
      const addr = await householdOrOwnFact(db, groupId, userId, 'home_address');
      if (addr) q.q = addr;
    }

    // ── the soonest open trip: destination / dates / city ──────────────────
    const needsTrip =
      (kind === 'flight' && (!q.destination || !q.departDate || !q.returnDate)) ||
      (CITY_KINDS.has(kind) && !q.city);
    if (needsTrip) {
      const trip = await db
        .selectFrom('trips')
        .where('group_id', '=', groupId)
        .where('end_date', '>=', today)
        .orderBy('start_date', 'asc')
        .select(['destination', 'start_date', 'end_date'])
        .executeTakeFirst();
      if (trip) {
        if (kind === 'flight') {
          if (!q.destination) q.destination = trip.destination;
          if (!q.departDate) q.departDate = trip.start_date;
          if (!q.returnDate) q.returnDate = trip.end_date;
        }
        if (CITY_KINDS.has(kind) && !q.city) q.city = trip.destination;
      }
    }

    // ── restaurantName ← a saved place, canonicalised on a single match ────
    if ((kind === 'restaurant' || kind === 'takeout') && q.restaurantName) {
      const saves = await db
        .selectFrom('saves')
        .where('group_id', '=', groupId)
        .where('kind', '=', 'place')
        .select(['title'])
        .execute();
      const hits = saves.filter((s) => placeNameMatches(q.restaurantName!, s.title));
      if (hits.length === 1 && hits[0].title.trim()) q.restaurantName = hits[0].title.trim();
    }
  } catch {
    return query;
  }

  return q;
}

/** How far back a departed flight still counts as "the flight" - it may be
 *  in the air. Matches the travel block in the prompt. */
const PASSENGER_FLIGHT_BACK_MS = 6 * 60 * 60 * 1000;
const PASSENGER_FLIGHT_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * "Ben" names "DOE, BEN" and "Ben Doe" names "Ben", but "John
 * Doe" does not name "Ben Doe": one name's tokens must all appear in the
 * other. A shared surname is the normal case in a family, so any-token
 * overlap would hand one person another's flight.
 */
function personNameMatches(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const within = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
  return within(ta, tb) || within(tb, ta);
}

/**
 * `flight_status` for "track Ben's flight": the soonest leg (in the air or
 * next to depart) whose passenger matches the name, else a flight-looking
 * calendar event naming them - the same Trips and calendar the prompt's
 * travel block shows, across every group the asker belongs to on a personal
 * turn, else just this group (ADR 0096 / 0032). Returns the flight in a form
 * `flightTrackingUrl` accepts, or null when nothing matches.
 */
export async function findFlightForPassenger(
  db: Kysely<DB>,
  ctx: { groupId: string; userId: string; isPersonal: boolean },
  passengerName: string,
): Promise<{ flightNumber: string } | null> {
  const want = passengerName.trim();
  if (!want) return null;
  const now = Date.now();
  const legs = await findUpcomingFlights(db, {
    userId: ctx.userId,
    groupId: ctx.isPersonal ? undefined : ctx.groupId,
    sinceMs: now - PASSENGER_FLIGHT_BACK_MS,
    untilMs: now + PASSENGER_FLIGHT_AHEAD_MS,
    limit: 50,
  });
  const leg = legs.find((l) => l.passengerName && personNameMatches(want, l.passengerName));
  if (leg?.flightNo) {
    const flightNumber =
      flightDesignator(leg.carrier, leg.flightNo) ??
      [leg.carrier, leg.flightNo].filter(Boolean).join(' ');
    return { flightNumber };
  }

  // Not in Trips: a calendar event that names both the person and a flight
  // ("Ben - UA 512 to Denver").
  const events = await findCalendarFlights(db, {
    userId: ctx.userId,
    groupId: ctx.isPersonal ? undefined : ctx.groupId,
    sinceMs: now - PASSENGER_FLIGHT_BACK_MS,
    untilMs: now + PASSENGER_FLIGHT_AHEAD_MS,
    limit: 20,
  });
  const wantTokens = tokens(want);
  const ev = events.find((e) => {
    if (!e.flight?.url) return false;
    const have = tokens(`${e.title} ${e.description ?? ''}`);
    return wantTokens.size > 0 && [...wantTokens].every((t) => have.has(t));
  });
  return ev?.flight ? { flightNumber: ev.flight.iata } : null;
}
