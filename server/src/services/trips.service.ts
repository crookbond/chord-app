import { sql, type Kysely } from 'kysely';
import { transactionThen } from '../db/after-commit.js';

import type {
  Accommodation,
  AddAccommodationRequest,
  AddTravelLegRequest,
  CreateTripRequest,
  TravelLeg,
  Trip,
  TripReservation,
  TravelMode,
  TripStatus,
  UpdateTripRequest,
} from '@chord/kernel';
import { flightDesignator, sameMetro } from '@chord/kernel';

import type {
  AccommodationsTable,
  DB,
  TravelLegsTable,
  TripReservationsTable,
  TripsTable,
} from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { likeContains } from '../utils/like.js';
import { dayOf } from '../utils/tz.js';
import { refreshTicketFreeBusy } from './trips/ticket-free-busy.js';
import { copyTripNamedTravelers } from './trips/travelers.js';
import { byInstant, textInstant } from '../db/text-instant.js';
import { fanoutAssignment } from './catchup/folders.service.js';
import { logger } from '../config/logging.js';
import { resolveTargetCalendarId } from './calendar-sources.service.js';
import { calendarForBooking } from './email/source-mailbox.js';
import { emailThreadLinkFromProvenance } from './email/thread-link.js';
import { createEvent, deleteEvent, findEventByExternalUid, updateEvent } from './events.service.js';
import {
  TRAVEL_LEG_EXTERNAL_UID_PREFIX,
  mergeDescriptions,
  passengerBlock,
  removeBlock,
  removePassenger,
} from './events/same-event.js';
import {
  MAX_RESCHEDULE_MS,
  bookingId,
  chainConnects,
  departAtMs,
  isNameSubset,
  nameTokens,
  placesMatch,
  sameFlight,
  sameTravelerLoose,
  sameTravelerStrict,
  tokenSetKey,
  type ChainLeg,
} from './trips/chain.js';

function rowToTrip(row: TripsTable, participants: string[]): Trip {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    participants,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
  };
}

function rowToLeg(row: TravelLegsTable): TravelLeg {
  return {
    id: row.id,
    tripId: row.trip_id,
    personaId: row.persona_id,
    passengerName: row.passenger_name ?? undefined,
    mode: row.mode,
    origin: row.origin,
    destination: row.destination,
    departAt: row.depart_at,
    arriveAt: row.arrive_at,
    carrier: row.carrier ?? undefined,
    flightNo: row.flight_no ?? undefined,
    confirmation: row.confirmation ?? undefined,
    notes: row.notes ?? undefined,
    sourceDocId: row.source_doc_id ?? undefined,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
  };
}

function rowToAccom(row: AccommodationsTable): Accommodation {
  return {
    id: row.id,
    tripId: row.trip_id,
    propertyName: row.property_name,
    address: row.address ?? undefined,
    checkinDate: row.checkin_date,
    checkoutDate: row.checkout_date,
    roomCount: row.room_count ?? undefined,
    confirmation: row.confirmation ?? undefined,
    notes: row.notes ?? undefined,
    sourceDocId: row.source_doc_id ?? undefined,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
  };
}

export interface CreateTripInput extends CreateTripRequest {
  groupId: string;
  createdBy: string | null;
  sourceRawContext?: string | null;
  /**
   * Pre-allocated id. Set by the bot's propose path so a trip id exists at
   * propose time and can be stamped into child proposals (ADR 0009 trip
   * bundles). Omit to let the service mint one.
   */
  id?: string;
}

export async function createTrip(
  db: Kysely<DB>,
  input: CreateTripInput,
): Promise<Trip> {
  const id = input.id ?? newId('tr');
  const row: TripsTable = {
    id,
    group_id: input.groupId,
    name: input.name,
    destination: input.destination,
    start_date: input.startDate,
    end_date: input.endDate,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    source_raw_context: input.sourceRawContext ?? null,
    cancelled_at: null,
    deleted_at: null,
  };
  await db.insertInto('trips').values(row).execute();
  if (input.participantIds.length > 0) {
    await db
      .insertInto('trip_participants')
      .values(input.participantIds.map((pid) => ({ trip_id: id, persona_id: pid })))
      .execute();
  }
  await fanoutAssignment(db, input.groupId, 'trip', id, {
    type: 'trip',
    primary: input.name,
    secondary: input.destination,
  }).catch((err) => logger.warn('catchup fanout (trip) failed', { err }));
  return rowToTrip(row, input.participantIds);
}

/**
 * Correct a trip's own name/destination/dates in place — for the case a
 * `create_trip` got a detail wrong (most commonly a year, since a boarding
 * pass or hotel confirmation rarely prints one and the resolver's best
 * guess can still miss). Only the fields supplied change; anything omitted
 * is left alone, same convention as the other partial-update tools
 * (ADR 0095's createTaskWithDedup). Rejects an inverted date range rather
 * than silently swapping it.
 */
export async function updateTrip(
  db: Kysely<DB>,
  tripId: string,
  patch: UpdateTripRequest,
): Promise<Trip | null> {
  const existing = await db.selectFrom('trips').selectAll().where('id', '=', tripId).executeTakeFirst();
  if (!existing) return null;
  const startDate = patch.startDate ?? existing.start_date;
  const endDate = patch.endDate ?? existing.end_date;
  if (startDate > endDate) {
    throw new Error('startDate must not be after endDate');
  }
  await db
    .updateTable('trips')
    .set({
      name: patch.name ?? existing.name,
      destination: patch.destination ?? existing.destination,
      start_date: startDate,
      end_date: endDate,
    })
    .where('id', '=', tripId)
    .execute();
  return getTrip(db, tripId);
}

/**
 * Soft-delete: a trip is never hard-removed by user action, so an accidental
 * "x" on the Trips tab is recoverable. Legs/accommodations aren't cascaded —
 * they stay attached, so restoring the trip brings everything back with it.
 */
export async function deleteTrip(db: Kysely<DB>, tripId: string): Promise<boolean> {
  const [result] = await db
    .updateTable('trips')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', tripId)
    .where('deleted_at', 'is', null)
    .execute();
  return result !== undefined && result.numUpdatedRows > 0n;
}

export async function restoreTrip(db: Kysely<DB>, tripId: string): Promise<boolean> {
  const [result] = await db
    .updateTable('trips')
    .set({ deleted_at: null })
    .where('id', '=', tripId)
    .where('deleted_at', 'is not', null)
    .execute();
  return result !== undefined && result.numUpdatedRows > 0n;
}

export interface MergeTripsResult {
  status: TripStatus;
  /** The trip that was folded in and soft-deleted, for an undo affordance. */
  mergedTripId: string;
}

/**
 * Fold `mergeTripId`'s legs/accommodations/reservations/participants into
 * `keepTripId` and soft-delete the now-empty source (ADR 0171's `deleted_at`
 * shape, so a mis-drop is recoverable via restoreTrip — that undo just
 * leaves the merged rows on the keeper, same as any other soft-delete).
 *
 * `keepTripId` is a caller decision (the drop TARGET in the mobile drag
 * gesture), not derived here — unlike ADR 0094's list-name merge, there is
 * no natural "oldest wins" rule for two trips someone is deliberately
 * combining by hand.
 *
 * Both trips' date ranges are unioned onto the keeper, same rule
 * `addTravelLeg` already applies when a leg extends a trip past its current
 * window. Legs are moved, not deduplicated — two trips that happen to record
 * the same flight would carry two rows after merging; that's a pre-existing
 * possibility `addTravelLeg`'s own dedup already guards at write time, and
 * re-running that check here would need a second advisory-lock pass for a
 * case a merge (a deliberate, occasional user action) doesn't need to solve.
 */
export async function mergeTrips(
  db: Kysely<DB>,
  groupId: string,
  keepTripId: string,
  mergeTripId: string,
): Promise<MergeTripsResult | null> {
  if (keepTripId === mergeTripId) throw new Error('cannot merge a trip into itself');
  return db.transaction().execute(async (trx) => {
    const [keep, merge] = await Promise.all([
      trx.selectFrom('trips').selectAll().where('id', '=', keepTripId).executeTakeFirst(),
      trx.selectFrom('trips').selectAll().where('id', '=', mergeTripId).executeTakeFirst(),
    ]);
    if (!keep || !merge || keep.group_id !== groupId || merge.group_id !== groupId) return null;

    await trx.updateTable('travel_legs').set({ trip_id: keepTripId }).where('trip_id', '=', mergeTripId).execute();
    await trx.updateTable('accommodations').set({ trip_id: keepTripId }).where('trip_id', '=', mergeTripId).execute();
    await trx.updateTable('trip_reservations').set({ trip_id: keepTripId }).where('trip_id', '=', mergeTripId).execute();

    const mergeParticipants = await trx
      .selectFrom('trip_participants')
      .select('persona_id')
      .where('trip_id', '=', mergeTripId)
      .execute();
    if (mergeParticipants.length > 0) {
      await trx
        .insertInto('trip_participants')
        .values(mergeParticipants.map((p) => ({ trip_id: keepTripId, persona_id: p.persona_id })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await copyTripNamedTravelers(trx, mergeTripId, keepTripId);

    const newStart = merge.start_date < keep.start_date ? merge.start_date : keep.start_date;
    const newEnd = merge.end_date > keep.end_date ? merge.end_date : keep.end_date;
    if (newStart !== keep.start_date || newEnd !== keep.end_date) {
      await trx.updateTable('trips').set({ start_date: newStart, end_date: newEnd }).where('id', '=', keepTripId).execute();
    }

    await trx
      .updateTable('trips')
      .set({ deleted_at: new Date().toISOString() })
      .where('id', '=', mergeTripId)
      .execute();

    const status = await getTripStatus(trx, keepTripId);
    if (!status) return null;
    return { status, mergedTripId: mergeTripId };
  });
}

export interface UndoMergeInput {
  keepTripId: string;
  mergeTripId: string;
  legIds: string[];
  accommodationIds: string[];
  reservationIds: string[];
  keepStartDate: string;
  keepEndDate: string;
}

export interface UndoMergeResult {
  keep: TripStatus;
  restored: TripStatus;
}

/**
 * Reverse one specific `mergeTrips` call: move exactly the given rows back
 * onto `mergeTripId`, restore it, and reset `keepTripId`'s date range to
 * what the caller says it was before the merge widened it. Only ever
 * called from the mobile "Undo" toast shown right after a merge, which
 * supplies the row ids and pre-merge range from the `TripStatus` it already
 * had in memory — nothing new is persisted server-side to make this
 * possible (see ADR 0171's `mergeTrips` comment).
 *
 * The `where trip_id = keepTripId` guard on each move means an id that
 * doesn't actually belong to the keeper (a stale payload, or something else
 * touched it in between) is silently skipped rather than yanked from
 * wherever it now lives. Participants the merge copied onto `keepTripId`
 * are left in place — an extra passenger listed on a trip they're not part
 * of is harmless, and telling "added by this merge" apart from "was already
 * there" needs more bookkeeping than an occasional mis-drop is worth.
 */
export async function undoMergeTrips(
  db: Kysely<DB>,
  groupId: string,
  input: UndoMergeInput,
): Promise<UndoMergeResult | null> {
  return db.transaction().execute(async (trx) => {
    const [keep, merged] = await Promise.all([
      trx.selectFrom('trips').selectAll().where('id', '=', input.keepTripId).executeTakeFirst(),
      trx.selectFrom('trips').selectAll().where('id', '=', input.mergeTripId).executeTakeFirst(),
    ]);
    if (!keep || !merged || keep.group_id !== groupId || merged.group_id !== groupId) return null;

    if (input.legIds.length > 0) {
      await trx
        .updateTable('travel_legs')
        .set({ trip_id: input.mergeTripId })
        .where('id', 'in', input.legIds)
        .where('trip_id', '=', input.keepTripId)
        .execute();
    }
    if (input.accommodationIds.length > 0) {
      await trx
        .updateTable('accommodations')
        .set({ trip_id: input.mergeTripId })
        .where('id', 'in', input.accommodationIds)
        .where('trip_id', '=', input.keepTripId)
        .execute();
    }
    if (input.reservationIds.length > 0) {
      await trx
        .updateTable('trip_reservations')
        .set({ trip_id: input.mergeTripId })
        .where('id', 'in', input.reservationIds)
        .where('trip_id', '=', input.keepTripId)
        .execute();
    }

    await trx
      .updateTable('trips')
      .set({ start_date: input.keepStartDate, end_date: input.keepEndDate })
      .where('id', '=', input.keepTripId)
      .execute();

    await trx.updateTable('trips').set({ deleted_at: null }).where('id', '=', input.mergeTripId).execute();

    const [keepStatus, restoredStatus] = await Promise.all([
      getTripStatus(trx, input.keepTripId),
      getTripStatus(trx, input.mergeTripId),
    ]);
    if (!keepStatus || !restoredStatus) return null;
    return { keep: keepStatus, restored: restoredStatus };
  });
}

async function loadTripParticipants(db: Kysely<DB>, tripId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('trip_participants')
    .select('persona_id')
    .where('trip_id', '=', tripId)
    .execute();
  return rows.map((r) => r.persona_id);
}

/** Batch variant of `loadTripParticipants` for many trips at once — avoids
 *  the N+1 (one query per trip) in `listTripsForGroup`/`listTripsForPersona`.
 *  Returns a map keyed by trip id; trips with no participants are absent. */
async function loadTripParticipantsForTrips(
  db: Kysely<DB>,
  tripIds: string[],
): Promise<Map<string, string[]>> {
  const byTrip = new Map<string, string[]>();
  if (tripIds.length === 0) return byTrip;
  const rows = await db
    .selectFrom('trip_participants')
    .select(['trip_id', 'persona_id'])
    .where('trip_id', 'in', tripIds)
    .execute();
  for (const row of rows) {
    const list = byTrip.get(row.trip_id) ?? [];
    list.push(row.persona_id);
    byTrip.set(row.trip_id, list);
  }
  return byTrip;
}

export async function getTrip(db: Kysely<DB>, id: string): Promise<Trip | null> {
  const row = await db
    .selectFrom('trips')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;
  const participants = await loadTripParticipants(db, id);
  return rowToTrip(row, participants);
}

/** Return trips in a group that have at least one travel leg belonging to personaId. */
export async function listTripsForPersona(
  db: Kysely<DB>,
  groupId: string,
  personaId: string,
): Promise<Trip[]> {
  const rows = await db
    .selectFrom('trips')
    .selectAll('trips')
    .where('trips.group_id', '=', groupId)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('travel_legs')
          .select('travel_legs.trip_id')
          .whereRef('travel_legs.trip_id', '=', 'trips.id')
          .where('travel_legs.persona_id', '=', personaId),
      ),
    )
    .orderBy('trips.start_date', 'asc')
    .execute();
  const participantsByTrip = await loadTripParticipantsForTrips(db, rows.map((r) => r.id));
  return rows.map((r) => rowToTrip(r, participantsByTrip.get(r.id) ?? []));
}

export async function listTripsForGroup(db: Kysely<DB>, groupId: string): Promise<Trip[]> {
  const rows = await db
    .selectFrom('trips')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('start_date', 'asc')
    .execute();
  const participantsByTrip = await loadTripParticipantsForTrips(db, rows.map((r) => r.id));
  return rows.map((r) => rowToTrip(r, participantsByTrip.get(r.id) ?? []));
}

export async function listTripStatusesForGroup(
  db: Kysely<DB>,
  groupId: string,
): Promise<TripStatus[]> {
  return buildTripStatuses(db, await listTripsForGroup(db, groupId));
}

export async function listTripStatusesForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<TripStatus[]> {
  const rows = await db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', userId)
    .selectAll('trips')
    .orderBy('trips.start_date', 'asc')
    .execute();
  const participantsByTrip = await loadTripParticipantsForTrips(db, rows.map((r) => r.id));
  return buildTripStatuses(db, rows.map((r) => rowToTrip(r, participantsByTrip.get(r.id) ?? [])));
}

/**
 * Pick the "active" trip for a group — the first trip whose date range
 * overlaps today, else the nearest upcoming, else the most recently created.
 * Used by the PDF auto-invoke path when no tripId is provided.
 */
export async function pickActiveTrip(
  db: Kysely<DB>,
  groupId: string,
  tz: string | null = null,
): Promise<Trip | null> {
  // The user's own day: in UTC a trip ending today is already over on a US evening.
  const today = dayOf(new Date().toISOString(), tz);
  const rows = await db
    .selectFrom('trips')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .execute();
  if (rows.length === 0) return null;

  const current = rows.find((r) => r.start_date <= today && r.end_date >= today);
  const upcoming = rows
    .filter((r) => r.start_date > today)
    .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
  const fallback = rows.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const pick = current ?? upcoming ?? fallback;
  return pick ? rowToTrip(pick, await loadTripParticipants(db, pick.id)) : null;
}

/**
 * Find a trip the user has access to (any of their groups) whose date range
 * overlaps with the given window.
 *
 * ADR 0190 — no longer used to decide trip/leg/stay IDENTITY (a shared
 * date window glued unrelated travelers together and split a single
 * traveler's own trip apart just as often as it worked — see
 * `findTripForTraveler`/`findTripForStay`). Still fine for placing a
 * reservation with a known date into an already-identified trip
 * (`add_reservation`, restaurant/movie auto-file) and for a cancellation
 * notice locating the booking it refers to (`applyCancellation`) — both are
 * "which of my already-real trips is this," not "does this new leg/stay
 * belong with someone's travel."
 *
 * Prefers trips in the current group; among equal-group ties, picks the
 * closest start date to the window start.
 */
export async function findTripByDateRange(
  db: Kysely<DB>,
  userId: string,
  windowStart: string,
  windowEnd: string,
  preferGroupId?: string,
): Promise<Trip | null> {
  const rows = await db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', userId)
    .where('trips.start_date', '<=', windowEnd)
    .where('trips.end_date', '>=', windowStart)
    // ADR 0168 — a rebooking for the same dates/destination must land on a
    // fresh trip, not the one a cancellation just closed out. Same for a
    // deleted trip: a new itinerary for the same window is a fresh trip, not
    // a silent resurrection of whatever the user deleted.
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .selectAll('trips')
    .execute();

  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const aPref = a.group_id === preferGroupId ? 0 : 1;
    const bPref = b.group_id === preferGroupId ? 0 : 1;
    if (aPref !== bPref) return aPref - bPref;
    return a.start_date.localeCompare(b.start_date);
  });

  const pick = rows[0];
  return rowToTrip(pick, await loadTripParticipants(db, pick.id));
}



/**
 * ADR 0190 — a trip's identity is one traveler's own chain of connected
 * legs, not a shared date-range window. `findTripByDateRange` above answers
 * "what else is happening around these dates" — too weak a question, since
 * it glues an unrelated family member's travel onto a long trip whenever the
 * dates happen to overlap. This answers "does this leg CONTINUE something
 * this specific traveler already has booked."
 *
 * Requires a resolved traveler identity (`personaId`, or an exact
 * `passengerName` for a traveler who isn't a Chord member) to chain against
 * anyone's own travel — the caller must not guess whose chain to check;
 * ADR 0190 says ask instead. Loads that traveler's own legs across every
 * trip in the user's groups (never another traveler's), merges the new
 * leg(s) into that timeline by departure time, and requires every seam
 * touching a new leg to connect by CITY (`sameMetro`, `airport-metro.ts`)
 * — never exact string equality, never date overlap. Several connecting
 * trips is resolved the same way `findTripByDateRange` always has: prefer
 * `preferGroupId`, then the closest start date.
 *
 * A leg that is the very same flight as one already on a trip (same route,
 * same instant) joins that trip whoever is on it — companions share one
 * itinerary — and that check needs no traveler at all.
 *
 * No identity, or an identity with nothing of theirs to connect to, falls
 * through to one narrow, safe use of date+place: a trip in `preferGroupId`
 * that has NO legs on it at all yet (a shell created ahead of any booking —
 * "create a trip to Denver," then the first flight). An empty trip has
 * nobody's travel to misattribute, which is the actual risk this whole
 * redesign closes — so date overlap is fine here in a way it never is once
 * a trip already has someone's legs on it.
 */
export async function findTripForTraveler(
  db: Kysely<DB>,
  opts: {
    userId: string;
    personaId?: string | null;
    passengerName?: string | null;
    legs: ChainLeg[];
    /** The document's booking reference. Same booking = same trip, even when
     *  the flight moved (a schedule change) or this is the return leg
     *  arriving in its own email. */
    confirmation?: string | null;
    preferGroupId?: string;
  },
): Promise<Trip | null> {
  const personaId = opts.personaId ?? null;
  const queryTokens = personaId ? [] : nameTokens(opts.passengerName);
  if (opts.legs.length === 0) return null;

  const rows = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', opts.userId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .where('travel_legs.cancelled_at', 'is', null)
    .select([
      'travel_legs.trip_id as tripId',
      'travel_legs.origin as origin',
      'travel_legs.destination as destination',
      'travel_legs.depart_at as departAt',
      'travel_legs.persona_id as personaId',
      'travel_legs.passenger_name as passengerName',
      'travel_legs.confirmation as confirmation',
      'trips.group_id as groupId',
      'trips.start_date as startDate',
    ])
    .execute();

  const pickBest = (cands: { tripId: string; groupId: string; startDate: string }[]) => {
    cands.sort((a, b) => {
      const aPref = a.groupId === opts.preferGroupId ? 0 : 1;
      const bPref = b.groupId === opts.preferGroupId ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.startDate.localeCompare(b.startDate);
    });
    return getTrip(db, cands[0]!.tripId);
  };

  // Companions first: a leg that is the very same physical flight (same
  // route, same instant) as one already on a trip is that trip's itinerary,
  // whoever the passenger is — a family on one flight is one trip, not one
  // per person. The strongest evidence there is, so it needs no name.
  const sharedTrips = new Map<string, { tripId: string; groupId: string; startDate: string }>();
  for (const r of rows) {
    if (opts.legs.some((l) => sameFlight(l, r))) {
      sharedTrips.set(r.tripId, { tripId: r.tripId, groupId: r.groupId, startDate: r.startDate });
    }
  }
  if (sharedTrips.size > 0) return pickBest([...sharedTrips.values()]);

  // The same booking reference is the same booking, wherever its flights now
  // fall: a schedule change moves the leg to a new time (which no chain rule
  // would connect to the old one), and a return leg often arrives in its own
  // email. Every booking has one id, a unique join that needs no date, place
  // or name — the same rule the regroup script applies to existing trips.
  const bid = bookingId(opts.confirmation);
  if (bid) {
    const booked = new Map<string, { tripId: string; groupId: string; startDate: string }>();
    for (const r of rows) {
      if (bookingId(r.confirmation) !== bid) continue;
      booked.set(r.tripId, { tripId: r.tripId, groupId: r.groupId, startDate: r.startDate });
    }
    if (booked.size > 0) return pickBest([...booked.values()]);
  }

  if (personaId || queryTokens.length > 0) {
    // Exact token-set match first (word order and honorifics aside, this is
    // the SAME name — no ambiguity possible). Only when that finds nothing
    // do we try a bare-name restatement of a fuller one ("Ben" vs "Ben
    // Doe") — and only when it resolves to exactly ONE identity: if the
    // subset rule would catch two travelers with genuinely different full
    // names, that's an unresolved ambiguity, not a match (this ADR's own
    // asymmetry — a wrong merge is worse than a missed one).
    let mine = personaId
      ? rows.filter((r) => r.personaId === personaId)
      : rows.filter((r) => tokenSetKey(nameTokens(r.passengerName)) === tokenSetKey(queryTokens) && r.passengerName);
    if (!personaId && mine.length === 0) {
      const subsetRows = rows.filter((r) => isNameSubset(queryTokens, nameTokens(r.passengerName)));
      const distinctIdentities = new Set(subsetRows.map((r) => tokenSetKey(nameTokens(r.passengerName))));
      if (distinctIdentities.size === 1) mine = subsetRows;
    }
    const byTrip = new Map<string, typeof mine>();
    for (const r of mine) {
      const list = byTrip.get(r.tripId);
      if (list) list.push(r);
      else byTrip.set(r.tripId, [r]);
    }

    const incoming = [...opts.legs].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt));
    const candidates: { tripId: string; groupId: string; startDate: string }[] = [];
    for (const [tripId, existingLegs] of byTrip) {
      const existing = [...existingLegs].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt));
      if (chainConnects(existing, incoming)) {
        candidates.push({ tripId, groupId: existing[0]!.groupId, startDate: existing[0]!.startDate });
      }
    }
    if (candidates.length > 0) return pickBest(candidates);
  }

  return opts.preferGroupId ? findEmptyTripInWindow(db, opts.userId, opts.preferGroupId, opts.legs) : null;
}

/** A trip with no legs at all yet — nobody's travel to misattribute, so
 *  date overlap alone is safe (see `findTripForTraveler`'s doc comment). */
async function findEmptyTripInWindow(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  legs: ChainLeg[],
): Promise<Trip | null> {
  const dates = legs.flatMap((l) => [l.departAt.slice(0, 10), (l.arriveAt ?? l.departAt).slice(0, 10)]);
  const windowStart = dates.reduce((a, b) => (a < b ? a : b));
  const windowEnd = dates.reduce((a, b) => (a > b ? a : b));

  const trips = await db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', userId)
    .where('trips.group_id', '=', groupId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .where('trips.start_date', '<=', windowEnd)
    .where('trips.end_date', '>=', windowStart)
    .selectAll('trips')
    .execute();
  if (trips.length === 0) return null;

  const legRows = await db
    .selectFrom('travel_legs')
    .select('trip_id')
    .where('trip_id', 'in', trips.map((t) => t.id))
    .execute();
  const withLegs = new Set(legRows.map((l) => l.trip_id));
  const empty = trips.filter((t) => !withLegs.has(t.id));
  if (empty.length === 0) return null;

  empty.sort((a, b) => a.start_date.localeCompare(b.start_date));
  const pick = empty[0]!;
  return rowToTrip(pick, await loadTripParticipants(db, pick.id));
}

/**
 * ADR 0190 — where a stay attaches when there's no traveler chain to check
 * (an accommodation carries no persona/passenger of its own). Scoped to ONE
 * group — a stay is never worth guessing across a family's separate chats —
 * and matched by PLACE AND DATES together: the trip's own destination or any
 * of its legs' endpoints must be the stay's city, AND the stay's nights must
 * overlap the trip's window. Neither alone is enough — place alone glues a
 * February 2027 Vail stay onto a February 2026 Vail trip; dates alone is the
 * date-window bug this ADR exists to remove. Of several trips that satisfy
 * both, the one the stay overlaps most wins, then the closest start.
 */
export async function findTripForStay(
  db: Kysely<DB>,
  opts: { userId: string; groupId: string; city: string | null; checkinDate: string; checkoutDate: string },
): Promise<Trip | null> {
  if (!opts.city) return null;
  const trips = await db
    .selectFrom('trips')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', opts.userId)
    .where('trips.group_id', '=', opts.groupId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .selectAll('trips')
    .execute();
  if (trips.length === 0) return null;

  const legs = await db
    .selectFrom('travel_legs')
    .where('trip_id', 'in', trips.map((t) => t.id))
    .select(['trip_id as tripId', 'origin', 'destination'])
    .execute();
  const legsByTrip = new Map<string, { origin: string; destination: string }[]>();
  for (const l of legs) {
    const list = legsByTrip.get(l.tripId);
    if (list) list.push(l);
    else legsByTrip.set(l.tripId, [l]);
  }

  // Same asymmetry as `chainConnects`: `sameMetro` for a real fuzzy match,
  // exact text as the fallback for a place with no airport-metro.ts entry
  // at all (a safari camp's address, not a city or airport) — which is
  // exactly what re-staging the identical hotel a second time looks like,
  // since `stageHotel`/`ensureTripForHotel` name the trip after this same
  // string on the way in.
  const placeMatches = placesMatch;
  const dayMs = (d: string) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`);
  const stayStart = dayMs(opts.checkinDate);
  const stayEnd = Math.max(dayMs(opts.checkoutDate), stayStart);
  // Inclusive day overlap, in days: a stay that ends the day the trip starts
  // (or starts the day it ends) still touches it.
  const overlapDays = (t: { start_date: string; end_date: string }) =>
    Math.min(stayEnd, dayMs(t.end_date)) - Math.max(stayStart, dayMs(t.start_date));
  const matches = trips
    .filter((t) => {
      const placeOk =
        placeMatches(t.destination, opts.city!) ||
        (legsByTrip.get(t.id) ?? []).some(
          (l) => placeMatches(l.origin, opts.city!) || placeMatches(l.destination, opts.city!),
        );
      return placeOk && overlapDays(t) >= 0;
    })
    .map((t) => ({ t, overlap: overlapDays(t) }));
  if (matches.length === 0) return null;
  matches.sort(
    (a, b) => b.overlap - a.overlap || Math.abs(dayMs(a.t.start_date) - stayStart) - Math.abs(dayMs(b.t.start_date) - stayStart),
  );
  const pick = matches[0]!.t;
  return rowToTrip(pick, await loadTripParticipants(db, pick.id));
}

/**
 * Check whether a user has access to a trip (member of the trip's group).
 * Replaces the group-scoped `resolveTripInGroup` check in the executor so that
 * cross-group trip attachment works correctly.
 */
export async function resolveTripForUser(
  db: Kysely<DB>,
  userId: string,
  tripId: string,
): Promise<Trip | null> {
  const trip = await getTrip(db, tripId);
  if (!trip) return null;
  const membership = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', trip.groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return membership ? trip : null;
}

export interface AddTravelLegInput extends AddTravelLegRequest {
  tripId: string;
  sourceRawContext?: string | null;
  /** Someone is being put on a flight already on the trip. Not a restated or
   *  rescheduled booking, so a leg on the same booking reference is never
   *  taken to be theirs (a member and a raw name cannot be compared). */
  addingPassenger?: boolean;
}

export { TRAVEL_LEG_EXTERNAL_UID_PREFIX };

function formatFlightTitle(row: TravelLegsTable): string {
  const flight = [row.carrier, row.flight_no].filter(Boolean).join(' ').trim();
  const route = `${row.origin}→${row.destination}`;
  return flight ? `${flight} ${route}` : `Flight ${route}`;
}

/** Who a leg's passenger is, by name: a family member's display name (the
 *  name the Trips tab shows), else the name from the booking. */
async function passengerNameOf(db: Kysely<DB>, row: TravelLegsTable): Promise<string | null> {
  if (row.persona_id) {
    const u = await db
      .selectFrom('users')
      .select(['username', 'display_name'])
      .where('id', '=', row.persona_id)
      .executeTakeFirst();
    const name = (u?.display_name || u?.username)?.trim();
    if (name) return name;
  }
  return row.passenger_name?.trim() || null;
}

/**
 * ADR 0158 — the calendar-event body for a flight/rail leg: the identifiers a
 * traveller actually needs at the gate, and a one-tap way back to the source
 * email. Deterministic; safe to send to Google verbatim.
 */
async function buildLegEventDescription(
  db: Kysely<DB>,
  createdBy: string | null,
  row: TravelLegsTable,
): Promise<string | null> {
  const link =
    createdBy && row.source_raw_context
      ? await emailThreadLinkFromProvenance(db, createdBy, row.source_raw_context)
      : null;
  const details = [row.notes, link ? `${link.label}: ${link.url}` : null]; // e.g. "Itinerary 73541634338201"
  // Everything about this traveler sits under their own name: on a shared
  // flight event each one may hold a different booking, from a different email.
  const who = await passengerNameOf(db, row);
  if (who) return passengerBlock(who, row.confirmation, details);
  const lines = [
    row.confirmation ? `Confirmation: ${row.confirmation}` : null,
    ...details,
  ].filter((l): l is string => !!l);
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Where and when a leg flies - what makes two passengers' legs one flight. */
type FlightSlot = Pick<TravelLegsTable, 'mode' | 'origin' | 'destination' | 'depart_at'>;

/** Every live leg in the group on this flight: one per passenger. */
async function legsOnFlight(
  db: Kysely<DB>,
  groupId: string,
  slot: FlightSlot,
): Promise<TravelLegsTable[]> {
  const ms = departAtMs(slot.depart_at);
  if (!(ms > 0)) return [];
  const rows = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .selectAll('travel_legs')
    .where('trips.group_id', '=', groupId)
    .where('trips.deleted_at', 'is', null)
    .where('trips.cancelled_at', 'is', null)
    .where('travel_legs.cancelled_at', 'is', null)
    .where('travel_legs.mode', '=', slot.mode)
    .where(sql<boolean>`${textInstant('travel_legs.depart_at')} = ${new Date(ms).toISOString()}::timestamptz`)
    .orderBy('travel_legs.created_at', 'asc')
    .execute();
  return rows.filter(
    (l) => placesMatch(l.origin, slot.origin) && placesMatch(l.destination, slot.destination),
  );
}

/**
 * The one calendar event a flight has, whichever passenger's leg made it. Found
 * by what the event says (leg-made, same departure, same route) rather than by
 * a leg id, so every passenger's leg leads to the same event.
 */
async function findFlightEvent(
  db: Kysely<DB>,
  groupId: string,
  slot: FlightSlot,
  opts: { exceptId?: string } = {},
): Promise<{ id: string; description: string | null; external_uid: string | null } | undefined> {
  const ms = departAtMs(slot.depart_at);
  if (!(ms > 0)) return undefined;
  const rows = await db
    .selectFrom('events')
    .select(['id', 'location', 'description', 'external_uid'])
    .where('group_id', '=', groupId)
    .where('deleted_at', 'is', null)
    .where('external_uid', 'like', `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}%`)
    .where(sql<boolean>`${textInstant('starts_at')} = ${new Date(ms).toISOString()}::timestamptz`)
    .execute();
  return rows.find((e) => {
    if (e.id === opts.exceptId) return false;
    const [from, to] = (e.location ?? '').split('→').map((s) => s.trim());
    return !!from && !!to && placesMatch(from, slot.origin) && placesMatch(to, slot.destination);
  });
}

/** Every passenger's details in one body: one passenger list, each
 *  confirmation and source link once. */
async function buildFlightEventDescription(
  db: Kysely<DB>,
  createdBy: string | null,
  legs: TravelLegsTable[],
): Promise<string | null> {
  let out: string | null = null;
  for (const leg of legs) {
    out = mergeDescriptions(out, await buildLegEventDescription(db, createdBy, leg));
  }
  return out;
}

async function syncFlightLegEvent(
  db: Kysely<DB>,
  tripId: string,
  row: TravelLegsTable,
  opts: { replacing?: TravelLegsTable } = {},
): Promise<void> {
  const trip = await db
    .selectFrom('trips')
    .select(['group_id', 'created_by'])
    .where('id', '=', tripId)
    .executeTakeFirst();
  if (!trip) return;
  const externalUid = `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${row.id}`;
  // One event per FLIGHT, not per passenger: a second traveler on a flight
  // already on the calendar is added to that event's passenger list.
  const shared =
    (await findEventByExternalUid(db, trip.group_id, externalUid)) ??
    (await findFlightEvent(db, trip.group_id, row));
  if (shared) {
    const legs = await legsOnFlight(db, trip.group_id, row);
    if (!legs.some((l) => l.id === row.id)) legs.push(row);
    const stored = shared.description ?? null;
    // The leg's passenger changed: what it wrote as the old passenger (or
    // before it had one) comes off. Anyone else on the flight who wrote the
    // same is put back by the merge below.
    const current = opts.replacing
      ? removeBlock(stored, await buildLegEventDescription(db, trip.created_by, opts.replacing))
      : stored;
    // Added to, never rebuilt: the event may hold lines another email put there.
    const description = mergeDescriptions(
      current,
      await buildFlightEventDescription(db, trip.created_by, legs),
    );
    if (description && description !== (stored ?? '').trim()) {
      await updateEvent(db, shared.id, { description });
    }
    const sharedUid = 'external_uid' in shared ? shared.external_uid : shared.externalUid;
    await refreshTicketFreeBusy(db, { externalUids: [sharedUid ?? externalUid] });
    return;
  }
  // Route to the same calendar a normal create_event would pick (the creator's
  // own default → primary), so the event row carries a concrete calendar id
  // rather than leaving the push to guess. A flight is personal by default
  // (ADR 0232); sharing a trip with a group is a suggestion, not a given.
  //
  // ADR 0312 — a booking that came by email goes on that mailbox's calendar;
  // only a mailbox with no calendar of its own falls back to the default.
  const mailboxCal = trip.created_by
    ? await calendarForBooking(db, trip.created_by, row.source_raw_context, row.source_doc_id)
    : null;
  const googleCalendarId = trip.created_by
    ? mailboxCal ?? (await resolveTargetCalendarId(db, { userId: trip.created_by })).calendarId
    : null;
  await createEvent(db, {
    groupId: trip.group_id,
    title: formatFlightTitle(row),
    description: await buildLegEventDescription(db, trip.created_by, row),
    location: `${row.origin} → ${row.destination}`,
    startsAt: row.depart_at,
    endsAt: row.arrive_at,
    createdBy: trip.created_by,
    externalUid,
    googleCalendarId,
    sourceRawContext: row.source_raw_context,
  });
  // Each family member's copy: free unless they are travelling.
  await refreshTicketFreeBusy(db, { externalUids: [externalUid] });
}

/**
 * Tolerant duplicate match for a re-uploaded flight leg: same trip + same
 * passenger + same departure DATE + same flight identity (flight number, or
 * confirmation/PNR, or origin→destination route). Date-level (not exact
 * timestamp) so a re-upload with minor datetime-format variance from the LLM
 * still dedups. Returns the existing leg, or null. Exported so the auto-filer
 * can tell the user "already added" without re-adding.
 */
const FORMAT_SLOP_MS = 5 * 60_000;

/** The same moment however it is written; text equality only when unreadable. */
function sameWrittenInstant(a: string | null, b: string | null | undefined): boolean {
  const am = a ? departAtMs(a) : 0;
  const bm = b ? departAtMs(b) : 0;
  return am > 0 && bm > 0 ? am === bm : a === b;
}

export async function findExistingLeg(
  db: Kysely<DB>,
  input: AddTravelLegInput,
): Promise<TravelLeg | null> {
  const all = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('trip_id', '=', input.tripId)
    .where('mode', '=', input.mode)
    .execute();
  // Same PERSON by the matcher's own rule — word order, honorifics and a bare
  // first name restating a full one all count ("STONE SIMON MR" is
  // "SIMON STONE") — not by exact string.
  const who = { personaId: input.personaId, name: input.passengerName };
  const candidates = all.filter((c) =>
    sameTravelerStrict({ personaId: c.persona_id, name: c.passenger_name }, who),
  );

  const departDate = input.departAt.slice(0, 10);
  const fno = input.flightNo?.toLowerCase();
  const pnr = input.confirmation?.toLowerCase();
  const match = candidates.find((c) => {
    // Same route by CITY (LGA is New York La Guardia), so a restated leg with
    // the airport spelled differently is still the same leg.
    if (!placesMatch(c.origin, input.origin) || !placesMatch(c.destination, input.destination)) return false;
    // The very same instant is the very same flight, whatever offset either
    // string prints — for one traveler on one route there is nothing else it
    // could be.
    const oldMs = departAtMs(c.depart_at);
    const newMs = departAtMs(input.departAt);
    if (oldMs > 0 && oldMs === newMs) return true;
    // A different TIME is a different departure, not a formatting variance -
    // and the same booking with a new time is a rescheduled flight
    // (`rescheduleBookedLegs`), never a duplicate to skip. Only a few minutes'
    // slop is variance (seconds dropped, a rounded time), measured between
    // instants: one flight printed with two offsets can fall on two dates.
    // Only an unreadable time falls back to comparing the written date.
    if (oldMs > 0 && newMs > 0) {
      if (Math.abs(oldMs - newMs) > FORMAT_SLOP_MS) return false;
    } else if (c.depart_at.slice(0, 10) !== departDate) {
      return false;
    }
    // Within that: a matching flight number or PNR means the same leg even if
    // the timestamp formatting differs slightly. With neither, only identical
    // timestamps count.
    if (fno && c.flight_no?.toLowerCase() === fno) return true;
    if (pnr && c.confirmation?.toLowerCase() === pnr) return true;
    return sameWrittenInstant(c.depart_at, input.departAt) && sameWrittenInstant(c.arrive_at, input.arriveAt);
  });
  return match ? rowToLeg(match) : null;
}

export interface BookedLegInput {
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  carrier?: string | null;
  flightNo?: string | null;
}

export interface ReconcileResult<T extends BookedLegInput> {
  /** Legs already on the trip and unchanged — nothing to do. */
  unchanged: TravelLeg[];
  /** Same route, new time — updated in place. */
  moved: TravelLeg[];
  /** Route changed — the old leg was replaced in place. */
  replaced: TravelLeg[];
  /** Incoming legs with no counterpart on the booking — the caller adds them. */
  remaining: T[];
  /** Legs of this booking the notice no longer accounts for, left untouched:
   *  only reported when route changes were allowed (a full itinerary). */
  unresolved: TravelLeg[];
}

/**
 * The booking reference is a unique join, so for one booking on one trip the
 * legs on file are known EXACTLY and the question is only how the incoming
 * legs pair with them. In order:
 *  1. unchanged — same route (by city) and the same instant: nothing to do;
 *  2. moved — same route, a different time within `MAX_RESCHEDULE_DAYS`: the
 *     leg is updated in place, with its calendar event (legs sharing the old
 *     time — a family on one flight — move together, it is one flight);
 *  3. replaced (only with `allowRouteChange`, i.e. the caller holds the WHOLE
 *     document, so what it does not mention is genuinely gone) — the route
 *     changed. Old and new legs pair only where the pairing is unambiguous:
 *     a one-for-one leftover, a leg sharing an origin or destination with
 *     exactly one old flight (and the reverse), or equal counts that line up
 *     in date order. Anything else is left alone and reported, never guessed.
 * A leg the notice does not mention is never removed here — dropping a leg
 * needs an explicit cancellation. Only legs whose traveler is not visibly a
 * different person are considered.
 */
export async function reconcileBookedLegs<T extends BookedLegInput>(
  db: Kysely<DB>,
  opts: {
    tripId: string;
    confirmation?: string | null;
    personaId?: string | null;
    passengerName?: string | null;
    legs: T[];
    allowRouteChange?: boolean;
  },
): Promise<ReconcileResult<T>> {
  const empty: ReconcileResult<T> = { unchanged: [], moved: [], replaced: [], remaining: [...opts.legs], unresolved: [] };
  const bid = bookingId(opts.confirmation);
  if (!bid) return empty;

  const rows = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('trip_id', '=', opts.tripId)
    .where('cancelled_at', 'is', null)
    .execute();
  const pool = rows.filter(
    (c) =>
      bookingId(c.confirmation) === bid &&
      sameTravelerLoose(
        { personaId: c.persona_id, name: c.passenger_name },
        { personaId: opts.personaId, name: opts.passengerName },
      ),
  );
  if (pool.length === 0) return empty;

  const used = new Set<string>();
  const unchanged: TravelLegsTable[] = [];
  const moved: TravelLegsTable[] = [];
  const replaced: TravelLegsTable[] = [];
  let open = [...opts.legs];

  const sameRoute = (c: TravelLegsTable, n: BookedLegInput) =>
    placesMatch(c.origin, n.origin) && placesMatch(c.destination, n.destination);
  const gap = (c: TravelLegsTable, n: BookedLegInput) => Math.abs(departAtMs(c.depart_at) - departAtMs(n.departAt));
  const timed = (c: TravelLegsTable, n: BookedLegInput) => departAtMs(c.depart_at) > 0 && departAtMs(n.departAt) > 0;

  const apply = async (leg: TravelLegsTable, n: BookedLegInput, target: TravelLegsTable[]) => {
    const next: TravelLegsTable = {
      ...leg,
      origin: n.origin,
      destination: n.destination,
      depart_at: n.departAt,
      arrive_at: n.arriveAt,
      carrier: n.carrier ?? leg.carrier,
      flight_no: n.flightNo ?? leg.flight_no,
    };
    await db
      .updateTable('travel_legs')
      .set({
        origin: next.origin,
        destination: next.destination,
        depart_at: next.depart_at,
        arrive_at: next.arrive_at,
        carrier: next.carrier,
        flight_no: next.flight_no,
      })
      .where('id', '=', leg.id)
      .execute();
    used.add(leg.id);
    target.push(next);
    if (next.mode === 'flight' || next.mode === 'train') {
      await syncMovedLegEvent(db, opts.tripId, next, leg).catch((err) => {
        logger.warn('travel-leg calendar reschedule failed', {
          err: err instanceof Error ? err.message : String(err),
          legId: leg.id,
        });
      });
    }
    await widenTripWindow(db, opts.tripId, n.departAt, n.arriveAt);
  };

  // 1. unchanged
  open = open.filter((n) => {
    const hits = pool.filter((c) => !used.has(c.id) && sameRoute(c, n) && timed(c, n) && gap(c, n) <= FORMAT_SLOP_MS);
    if (hits.length === 0) return true;
    for (const h of hits) {
      used.add(h.id);
      unchanged.push(h);
    }
    return false;
  });

  // 2. same route, a new time
  for (const n of [...open]) {
    const cands = pool.filter((c) => !used.has(c.id) && sameRoute(c, n) && timed(c, n) && gap(c, n) <= MAX_RESCHEDULE_MS);
    if (cands.length === 0) continue;
    const nearest = cands.reduce((a, b) => (gap(a, n) <= gap(b, n) ? a : b));
    const at = departAtMs(nearest.depart_at);
    for (const leg of cands.filter((c) => departAtMs(c.depart_at) === at)) await apply(leg, n, moved);
    open = open.filter((x) => x !== n);
  }

  // 3. the route changed
  if (opts.allowRouteChange && open.length > 0) {
    const left = pool.filter((c) => !used.has(c.id));
    const groups = new Map<string, TravelLegsTable[]>();
    for (const c of left) {
      const k = `${c.origin.trim().toLowerCase()}|${c.destination.trim().toLowerCase()}|${departAtMs(c.depart_at)}`;
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const flights = [...groups.values()].sort((a, b) => departAtMs(a[0]!.depart_at) - departAtMs(b[0]!.depart_at));
    const sharesEnd = (c: TravelLegsTable, n: BookedLegInput) =>
      placesMatch(c.origin, n.origin) || placesMatch(c.destination, n.destination);
    const allowed = (g: TravelLegsTable[], n: BookedLegInput) =>
      timed(g[0]!, n) &&
      gap(g[0]!, n) <= MAX_RESCHEDULE_MS &&
      (sharesEnd(g[0]!, n) || (flights.length === 1 && open.length === 1));

    const pairs: [TravelLegsTable[], T][] = [];
    for (const g of flights) {
      const cs = open.filter((n) => allowed(g, n));
      if (cs.length !== 1) continue;
      const n = cs[0]!;
      if (flights.filter((h) => allowed(h, n)).length === 1) pairs.push([g, n]);
    }
    if (pairs.length === 0 && flights.length === open.length && flights.length > 1) {
      // Equal counts that line up in date order, every pair plausible.
      const ordered = [...open].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt));
      if (flights.every((g, i) => allowed(g, ordered[i]!))) flights.forEach((g, i) => pairs.push([g, ordered[i]!]));
    }
    for (const [g, n] of pairs) {
      for (const leg of g) await apply(leg, n, replaced);
      open = open.filter((x) => x !== n);
    }
  }

  const unresolved = opts.allowRouteChange ? pool.filter((c) => !used.has(c.id)).map(rowToLeg) : [];
  return {
    unchanged: unchanged.map(rowToLeg),
    moved: moved.map(rowToLeg),
    replaced: replaced.map(rowToLeg),
    remaining: open,
    unresolved,
  };
}

/** How far apart two departures of one flight number can be and still be the
 *  same flight moved, when no booking reference ties them: an airline schedule
 *  change is minutes to a few hours; the same flight number a day later is a
 *  different flight. */
const SAME_FLIGHT_MOVED_MS = 12 * 3_600_000;

export interface SameFlightInput extends BookedLegInput {
  mode: TravelMode;
  confirmation?: string | null;
  notes?: string | null;
  personaId?: string | null;
  passengerName?: string | null;
}

export type SameFlightResult =
  | { status: 'none' }
  | { status: 'unchanged'; leg: TravelLeg }
  | { status: 'moved'; leg: TravelLeg };

/**
 * The same flight already on one of the user's trips, booked a second way: the
 * same traveler, the same flight number on the same route, departing within a
 * few hours. A booking made in chat has no booking reference, so when the
 * airline's email later arrives with a changed time (Delta DL2503 moved from
 * 9:20 to 9:25 ET, prod 2026-11-17) `reconcileBookedLegs` had nothing to join on
 * and a second leg, and a second calendar event, were made. Two booking
 * references that disagree are two bookings and never match. Looks across every
 * group the user belongs to, because the first booking may sit on a trip in
 * another chat. One clear match is updated in place (time, missing booking
 * reference and notes) with its calendar event; anything ambiguous is left for
 * the caller to add as before.
 */
export async function rescheduleSameFlight(
  db: Kysely<DB>,
  userId: string,
  input: SameFlightInput,
  opts: { groupId?: string } = {},
): Promise<SameFlightResult> {
  const newMs = departAtMs(input.departAt);
  const designator = flightDesignator(input.carrier, input.flightNo);
  const digits = flightDigits(input.flightNo);
  if (!(newMs > 0) || (!designator && !digits)) return { status: 'none' };
  const rows = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .selectAll('travel_legs')
    .where('group_members.user_id', '=', userId)
    .$if(!!opts.groupId, (q) => q.where('trips.group_id', '=', opts.groupId!))
    .where('trips.deleted_at', 'is', null)
    .where('trips.cancelled_at', 'is', null)
    .where('travel_legs.cancelled_at', 'is', null)
    .where('travel_legs.mode', '=', input.mode)
    .execute();
  const bid = bookingId(input.confirmation);
  const who = { personaId: input.personaId, name: input.passengerName };
  const matches = rows.filter((c) => {
    const ms = departAtMs(c.depart_at);
    if (!(ms > 0) || Math.abs(ms - newMs) > SAME_FLIGHT_MOVED_MS) return false;
    if (!placesMatch(c.origin, input.origin) || !placesMatch(c.destination, input.destination)) return false;
    const theirs = flightDesignator(c.carrier, c.flight_no);
    if (designator && theirs ? designator !== theirs : !digits || flightDigits(c.flight_no) !== digits) return false;
    const theirBid = bookingId(c.confirmation);
    if (bid && theirBid && bid !== theirBid) return false;
    return sameTravelerStrict({ personaId: c.persona_id, name: c.passenger_name }, who);
  });
  if (matches.length !== 1) return { status: 'none' };
  const leg = matches[0]!;
  const timeChanged = departAtMs(leg.depart_at) !== newMs || departAtMs(leg.arrive_at) !== departAtMs(input.arriveAt);
  const next: TravelLegsTable = {
    ...leg,
    depart_at: timeChanged ? input.departAt : leg.depart_at,
    arrive_at: timeChanged ? input.arriveAt : leg.arrive_at,
    carrier: leg.carrier ?? input.carrier ?? null,
    flight_no: leg.flight_no ?? input.flightNo ?? null,
    confirmation: leg.confirmation ?? input.confirmation ?? null,
    notes: leg.notes ?? input.notes ?? null,
  };
  const filled =
    next.carrier !== leg.carrier ||
    next.flight_no !== leg.flight_no ||
    next.confirmation !== leg.confirmation ||
    next.notes !== leg.notes;
  if (!timeChanged && !filled) return { status: 'unchanged', leg: rowToLeg(leg) };
  await db
    .updateTable('travel_legs')
    .set({
      depart_at: next.depart_at,
      arrive_at: next.arrive_at,
      carrier: next.carrier,
      flight_no: next.flight_no,
      confirmation: next.confirmation,
      notes: next.notes,
    })
    .where('id', '=', leg.id)
    .execute();
  if (timeChanged) {
    await syncMovedLegEvent(db, leg.trip_id, next, leg).catch((err) => {
      logger.warn('travel-leg calendar reschedule failed', {
        err: err instanceof Error ? err.message : String(err),
        legId: leg.id,
      });
    });
    await widenTripWindow(db, leg.trip_id, next.depart_at, next.arrive_at);
  } else {
    // Same time, a booking reference or notes newly known: onto the event body.
    await syncFlightLegEvent(db, leg.trip_id, next).catch((err) => {
      logger.warn('travel-leg calendar sync failed', {
        err: err instanceof Error ? err.message : String(err),
        legId: leg.id,
      });
    });
  }
  return { status: timeChanged ? 'moved' : 'unchanged', leg: rowToLeg(next) };
}

function flightDigits(flightNo: string | null | undefined): string | null {
  const m = /(\d{1,4})\s*$/.exec((flightNo ?? '').trim());
  return m ? m[1]!.replace(/^0+/, '') || null : null;
}

/** One leg arriving alone (the bot tool, a confirmed proposal): only what a
 *  single leg can settle — it is already there, or it is the same flight at a
 *  new time. A route change needs the whole document (`reconcileBookedLegs`).
 *  Returns the legs it matched, empty when the caller should add the leg. */
export async function rescheduleBookedLegs(
  db: Kysely<DB>,
  input: {
    tripId: string;
    origin: string;
    destination: string;
    departAt: string;
    arriveAt: string;
    carrier?: string | null;
    flightNo?: string | null;
    confirmation?: string | null;
    personaId?: string | null;
    passengerName?: string | null;
  },
): Promise<TravelLeg[]> {
  const r = await reconcileBookedLegs(db, {
    tripId: input.tripId,
    confirmation: input.confirmation,
    personaId: input.personaId,
    passengerName: input.passengerName,
    legs: [input],
  });
  return [...r.unchanged, ...r.moved];
}

/** The trip's window only ever WIDENS here (a stay, or a manual edit, may be
 *  what holds an edge open). */
async function widenTripWindow(db: Kysely<DB>, tripId: string, departAt: string, arriveAt: string): Promise<void> {
  const tripRow = await db.selectFrom('trips').select(['start_date', 'end_date']).where('id', '=', tripId).executeTakeFirst();
  if (!tripRow) return;
  const d = departAt.slice(0, 10);
  const a = arriveAt.slice(0, 10);
  const start = d < tripRow.start_date ? d : tripRow.start_date;
  const end = a > tripRow.end_date ? a : tripRow.end_date;
  if (start !== tripRow.start_date || end !== tripRow.end_date) {
    await db.updateTable('trips').set({ start_date: start, end_date: end }).where('id', '=', tripId).execute();
  }
}

/**
 * A leg's flight changed (time or route). `prev` is the leg as it was. The
 * event is shared by everyone on the flight, so moving one passenger must not
 * drag the others' event along with them.
 */
async function syncMovedLegEvent(
  db: Kysely<DB>,
  tripId: string,
  row: TravelLegsTable,
  prev: TravelLegsTable,
): Promise<void> {
  const trip = await db.selectFrom('trips').select('group_id').where('id', '=', tripId).executeTakeFirst();
  if (!trip) return;
  const ownUid = `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${row.id}`;
  const old =
    (await db
      .selectFrom('events')
      .select(['id', 'description', 'external_uid'])
      .where('group_id', '=', trip.group_id)
      .where('deleted_at', 'is', null)
      .where('external_uid', '=', ownUid)
      .executeTakeFirst()) ?? (await findFlightEvent(db, trip.group_id, prev));
  if (!old) {
    await syncFlightLegEvent(db, tripId, row);
    return;
  }
  // The leg row is already updated, so this is everyone ELSE still on the old flight.
  const staying = (await legsOnFlight(db, trip.group_id, prev)).filter((l) => l.id !== row.id);

  if (staying.length === 0) {
    const target = await findFlightEvent(db, trip.group_id, row, { exceptId: old.id });
    if (!target) {
      // Nobody left behind and nothing at the new time: the event moves.
      await updateEvent(db, old.id, {
        title: formatFlightTitle(row),
        location: `${row.origin} → ${row.destination}`,
        startsAt: row.depart_at,
        endsAt: row.arrive_at,
      });
      return;
    }
    // The new flight already has its event: this one is now nobody's.
    await deleteEvent(db, old.id);
    await syncFlightLegEvent(db, tripId, row);
    return;
  }

  // Others stay on the old flight: take this passenger off its event, and
  // hand the event to one of them if it was keyed to the leg that is leaving.
  const description = removePassenger(old.description, await passengerNameOf(db, prev));
  if (description !== old.description) await updateEvent(db, old.id, { description });
  if (old.external_uid === ownUid) {
    await db
      .updateTable('events')
      .set({ external_uid: `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${staying[0]!.id}` })
      .where('id', '=', old.id)
      .execute();
  }
  await syncFlightLegEvent(db, tripId, row);
}

export async function addTravelLeg(
  db: Kysely<DB>,
  input: AddTravelLegInput,
): Promise<TravelLeg> {
  // Two overlapping calls (a double-tap on a bundle-confirm card, or two
  // concurrent magics passes) can both run findExistingLeg's SELECT before
  // either INSERT commits, minting duplicate legs — the exact check-then-
  // insert race ADR 0165 fixed for list creation. Take a transaction-scoped
  // advisory lock on this trip before checking, so a second overlapping call
  // waits for the first to commit and then finds what it just inserted.
  // `_xact_` releases on commit/rollback and is the only advisory-lock form
  // safe under transaction-mode pooling (ADR 0038); a bundle confirm (ADR
  // 0158) already holds a transaction, so take the lock on it rather than
  // nesting one.
  const run = async (trx: Kysely<DB>): Promise<TravelLeg> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.tripId}), hashtext('leg'))`.execute(trx);

    // Idempotent: a re-upload of the same flight for the same passenger
    // returns the existing leg instead of creating a duplicate (and a
    // duplicate calendar event). Different people on the same flight still
    // get their own leg.
    const existing = await findExistingLeg(trx, input);
    if (existing) return existing;

    // Same booking, flight moved: update it, don't add a second one beside it.
    const moved = input.addingPassenger ? [] : await rescheduleBookedLegs(trx, input);
    if (moved.length > 0) return moved[0]!;

    // The same flight already on one of the trip owner's trips IN THIS CHAT
    // from a booking with no reference (a card staged before that booking
    // existed, the bot tool): that leg, updated, not a second one. Only this
    // chat: a suggestion confirmed into several chats (ADR 0247) makes one
    // trip per chat on purpose, each with its own copy of the flight.
    if (!input.addingPassenger) {
      const owner = await trx
        .selectFrom('trips')
        .select(['created_by', 'group_id'])
        .where('id', '=', input.tripId)
        .executeTakeFirst();
      if (owner?.created_by) {
        const same = await rescheduleSameFlight(
          trx,
          owner.created_by,
          { ...input, personaId: input.personaId ?? null, passengerName: input.passengerName ?? null },
          { groupId: owner.group_id },
        );
        if (same.status !== 'none') return same.leg;
      }
    }

    const id = newId('leg');
    const row: TravelLegsTable = {
      id,
      trip_id: input.tripId,
      persona_id: input.personaId ?? null,
      passenger_name: input.passengerName ?? null,
      mode: input.mode,
      origin: input.origin,
      destination: input.destination,
      depart_at: input.departAt,
      arrive_at: input.arriveAt,
      carrier: input.carrier ?? null,
      flight_no: input.flightNo ?? null,
      confirmation: input.confirmation ?? null,
      notes: input.notes ?? null,
      source_doc_id: input.sourceDocId ?? null,
      created_at: new Date().toISOString(),
      source_raw_context: input.sourceRawContext ?? null,
      cancelled_at: null,
    };
    await trx.insertInto('travel_legs').values(row).execute();

    // Flights and rail surface in the family calendar too — one event per leg,
    // routed to the trip creator's Chord calendar (their Google calendar shared
    // with the family acts as the de-facto common calendar). Car/ferry/other
    // stay out: the data shape fits but the calendar value is a scheduled
    // boarding time, which those modes rarely have (ADR 0158).
    if (input.mode === 'flight' || input.mode === 'train') {
      // Awaited, not fire-and-forget: this already runs inside a
      // transaction (this function's own lock, or an outer bundle
      // confirm), so the event insert must land before it commits. A
      // calendar failure is still non-fatal.
      await syncFlightLegEvent(trx, input.tripId, row).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('travel-leg calendar sync failed', { err: message, legId: row.id });
      });
    }

    // Track the leg's passenger as a trip participant so participantNames is populated.
    if (input.personaId) {
      await trx
        .insertInto('trip_participants')
        .values({ trip_id: input.tripId, persona_id: input.personaId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    // Keep the trip's date range in sync with its legs so that subsequent
    // date-range lookups (e.g. for a return leg) find the same trip.
    const departDate = input.departAt.slice(0, 10);
    const arriveDate = input.arriveAt.slice(0, 10);
    const tripRow = await trx.selectFrom('trips').where('id', '=', input.tripId)
      .select(['start_date', 'end_date']).executeTakeFirst();
    if (tripRow) {
      const newStart = departDate < tripRow.start_date ? departDate : tripRow.start_date;
      const newEnd   = arriveDate > tripRow.end_date   ? arriveDate  : tripRow.end_date;
      if (newStart !== tripRow.start_date || newEnd !== tripRow.end_date) {
        await trx.updateTable('trips')
          .set({ start_date: newStart, end_date: newEnd })
          .where('id', '=', input.tripId)
          .execute();
      }
    }

    return rowToLeg(row);
  };
  return transactionThen(db, run);
}

export interface AddAccommodationInput extends AddAccommodationRequest {
  tripId: string;
  sourceRawContext?: string | null;
}

/**
 * Tolerant duplicate match for a re-uploaded hotel: same trip + same
 * confirmation/PNR, or same property name + same check-in/check-out dates.
 * Returns the existing accommodation, or null.
 */
export async function findExistingAccommodation(
  db: Kysely<DB>,
  input: AddAccommodationInput,
): Promise<Accommodation | null> {
  const candidates = await db
    .selectFrom('accommodations')
    .selectAll()
    .where('trip_id', '=', input.tripId)
    .execute();
  const pnr = input.confirmation?.toLowerCase();
  const prop = input.propertyName.trim().toLowerCase();
  const match = candidates.find(
    (c) =>
      (!!pnr && c.confirmation?.toLowerCase() === pnr) ||
      (c.property_name.trim().toLowerCase() === prop &&
        c.checkin_date === input.checkinDate &&
        c.checkout_date === input.checkoutDate),
  );
  return match ? rowToAccom(match) : null;
}

export async function addAccommodation(
  db: Kysely<DB>,
  input: AddAccommodationInput,
): Promise<Accommodation> {
  // Same check-then-insert race as addTravelLeg (ADR 0165's shape) — lock
  // this trip before checking so two overlapping calls can't both miss the
  // dedup SELECT and both insert.
  const run = async (trx: Kysely<DB>): Promise<Accommodation> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${input.tripId}), hashtext('accommodation'))`.execute(trx);

    // Idempotent: a re-upload of the same hotel returns the existing row.
    const existing = await findExistingAccommodation(trx, input);
    if (existing) return existing;

    const id = newId('ac');
    const row: AccommodationsTable = {
      id,
      trip_id: input.tripId,
      property_name: input.propertyName,
      address: input.address ?? null,
      checkin_date: input.checkinDate,
      checkout_date: input.checkoutDate,
      room_count: input.roomCount ?? null,
      confirmation: input.confirmation ?? null,
      notes: input.notes ?? null,
      source_doc_id: input.sourceDocId ?? null,
      created_at: new Date().toISOString(),
      source_raw_context: input.sourceRawContext ?? null,
      cancelled_at: null,
    };
    await trx.insertInto('accommodations').values(row).execute();
    return rowToAccom(row);
  };
  return transactionThen(db, run);
}

/**
 * ADR 0168 — locate the accommodation a cancellation email refers to. Looser
 * than `findExistingAccommodation` (a cancellation notice may carry fewer
 * fields than a confirmation does): property name + both dates when all
 * three are given, else confirmation alone. **Property+dates is checked
 * FIRST** — deliberately not a fallback tried second — because a hotel loyalty
 * program can fold several stays under one shared folio/confirmation number,
 * and confirmation-alone matching would then pick whichever row happens to
 * come back first from the query, not necessarily the one the email names.
 * Cancelled rows are excluded so a re-run can't "match" an already-cancelled
 * stay.
 */
export async function findAccommodationToCancel(
  db: Kysely<DB>,
  input: {
    tripId: string;
    propertyName?: string;
    checkinDate?: string;
    checkoutDate?: string;
    confirmation?: string;
  },
): Promise<Accommodation | null> {
  const candidates = await db
    .selectFrom('accommodations')
    .selectAll()
    .where('trip_id', '=', input.tripId)
    .where('cancelled_at', 'is', null)
    .execute();
  const prop = input.propertyName?.trim().toLowerCase();
  const propMatch = candidates.find(
    (c) =>
      !!(
        prop &&
        input.checkinDate &&
        input.checkoutDate &&
        c.property_name.trim().toLowerCase() === prop &&
        c.checkin_date === input.checkinDate &&
        c.checkout_date === input.checkoutDate
      ),
  );
  if (propMatch) return rowToAccom(propMatch);
  const pnr = input.confirmation?.toLowerCase();
  const pnrMatch = pnr ? candidates.find((c) => c.confirmation?.toLowerCase() === pnr) : undefined;
  return pnrMatch ? rowToAccom(pnrMatch) : null;
}

/**
 * ADR 0168 — locate the leg a cancellation email refers to. Looser than
 * `findExistingLeg`: route + departure DATE (not exact timestamp) when all
 * three are given, else confirmation alone. **Route+date is checked FIRST**
 * — an outbound and return leg routinely SHARE one PNR, so matching on
 * confirmation alone when the cancellation also names a specific route/date
 * would risk cancelling whichever leg the query happens to return first,
 * not the one named. Cancelled rows are excluded for the same reason as
 * `findAccommodationToCancel`.
 */
export async function findLegToCancel(
  db: Kysely<DB>,
  input: { tripId: string; origin?: string; destination?: string; departAt?: string; confirmation?: string },
): Promise<TravelLeg | null> {
  const candidates = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('trip_id', '=', input.tripId)
    .where('cancelled_at', 'is', null)
    .execute();
  const departDate = input.departAt?.slice(0, 10);
  const routeMatch = candidates.find(
    (c) =>
      !!(
        input.origin &&
        input.destination &&
        departDate &&
        c.origin === input.origin &&
        c.destination === input.destination &&
        c.depart_at.slice(0, 10) === departDate
      ),
  );
  if (routeMatch) return rowToLeg(routeMatch);
  const pnr = input.confirmation?.toLowerCase();
  const pnrMatch = pnr ? candidates.find((c) => c.confirmation?.toLowerCase() === pnr) : undefined;
  return pnrMatch ? rowToLeg(pnrMatch) : null;
}

/**
 * The legs a cancellation email refers to, found across EVERY trip the user
 * can reach — not inside a trip chosen by date first. A booking reference
 * identifies a booking wherever its legs ended up; a route on a day is the
 * fallback when the notice carries no reference. Never guesses between
 * travelers: with no reference, a flight two different people are on is
 * ambiguous and matches nothing (a missed cancellation costs nothing extra; a
 * wrong one cancels somebody else's flight).
 */
export async function findLegsToCancelForUser(
  db: Kysely<DB>,
  input: {
    userId: string;
    confirmation?: string;
    legs: { origin?: string; destination?: string; departAt?: string }[];
  },
): Promise<TravelLeg[]> {
  const bid = bookingId(input.confirmation);
  const rows = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', input.userId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .where('travel_legs.cancelled_at', 'is', null)
    .selectAll('travel_legs')
    .execute();

  // Another booking's leg is never this one's, whatever its route says.
  const eligible = rows.filter((r) => {
    const rid = bookingId(r.confirmation);
    return !bid || !rid || rid === bid;
  });

  const picked = new Map<string, TravelLegsTable>();
  const listed = input.legs.filter((l) => l.origin && l.destination && l.departAt);
  if (listed.length === 0) {
    // The whole booking, by its reference — and only by a real one.
    if (bid) for (const r of eligible) if (bookingId(r.confirmation) === bid) picked.set(r.id, r);
  } else {
    for (const l of listed) {
      const day = l.departAt!.slice(0, 10);
      const hits = eligible.filter(
        (r) =>
          placesMatch(r.origin, l.origin!) &&
          placesMatch(r.destination, l.destination!) &&
          r.depart_at.slice(0, 10) === day,
      );
      // With the booking reference the hits are one booking's passengers on
      // one flight and all of them are cancelled; without it, two different
      // travelers make it ambiguous.
      const people = new Set(hits.map((r) => r.persona_id ?? tokenSetKey(nameTokens(r.passenger_name))));
      if (!bid && people.size > 1) continue;
      for (const r of hits) picked.set(r.id, r);
    }
  }
  return [...picked.values()].map(rowToLeg);
}

/** The stay a cancellation refers to, across every reachable trip — the same
 *  rules as `findAccommodationToCancel` (property + both dates first, the
 *  confirmation second) without choosing a trip by date beforehand. */
export async function findAccommodationsToCancelForUser(
  db: Kysely<DB>,
  input: {
    userId: string;
    propertyName?: string;
    checkinDate?: string;
    checkoutDate?: string;
    confirmation?: string;
  },
): Promise<Accommodation[]> {
  const rows = await db
    .selectFrom('accommodations')
    .innerJoin('trips', 'trips.id', 'accommodations.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', input.userId)
    .where('trips.cancelled_at', 'is', null)
    .where('trips.deleted_at', 'is', null)
    .where('accommodations.cancelled_at', 'is', null)
    .selectAll('accommodations')
    .execute();
  const prop = input.propertyName?.trim().toLowerCase();
  if (prop && input.checkinDate && input.checkoutDate) {
    const hits = rows.filter(
      (c) =>
        c.property_name.trim().toLowerCase() === prop &&
        c.checkin_date === input.checkinDate &&
        c.checkout_date === input.checkoutDate,
    );
    if (hits.length > 0) return hits.map(rowToAccom);
  }
  const bid = bookingId(input.confirmation);
  return bid ? rows.filter((c) => bookingId(c.confirmation) === bid).map(rowToAccom) : [];
}

export async function cancelAccommodation(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .updateTable('accommodations')
    .set({ cancelled_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('cancelled_at', 'is', null)
    .execute();
}

export async function cancelTravelLeg(db: Kysely<DB>, id: string): Promise<void> {
  await db
    .updateTable('travel_legs')
    .set({ cancelled_at: new Date().toISOString() })
    .where('id', '=', id)
    .where('cancelled_at', 'is', null)
    .execute();
}

/**
 * ADR 0168 — a trip is cancelled when nothing about it is still happening,
 * derived rather than asked. Called after cancelling a leg/accommodation;
 * marks the trip cancelled only when it has at least one leg or
 * accommodation and every one of them is now cancelled (a trip with no legs
 * or stays at all — e.g. reservation-only — never auto-cancels this way).
 * Returns whether the trip was newly marked cancelled.
 */
export async function maybeCancelTrip(db: Kysely<DB>, tripId: string): Promise<boolean> {
  const [liveLegs, liveAccoms, anyLeg, anyAccom] = await Promise.all([
    db.selectFrom('travel_legs').select('id').where('trip_id', '=', tripId).where('cancelled_at', 'is', null).execute(),
    db.selectFrom('accommodations').select('id').where('trip_id', '=', tripId).where('cancelled_at', 'is', null).execute(),
    db.selectFrom('travel_legs').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
    db.selectFrom('accommodations').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
  ]);
  if (liveLegs.length > 0 || liveAccoms.length > 0) return false;
  if (!anyLeg && !anyAccom) return false;
  const [result] = await db
    .updateTable('trips')
    .set({ cancelled_at: new Date().toISOString() })
    .where('id', '=', tripId)
    .where('cancelled_at', 'is', null)
    .execute();
  return result !== undefined && result.numUpdatedRows > 0n;
}

/** Fetch a leg together with its trip's groupId, for auth checks on the
 *  leg-scoped delete route (which has no groupId of its own in its path). */
export async function getTravelLegWithGroup(
  db: Kysely<DB>,
  legId: string,
): Promise<{ leg: TravelLeg; groupId: string } | null> {
  const row = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .selectAll('travel_legs')
    .select('trips.group_id as groupId')
    .where('travel_legs.id', '=', legId)
    .executeTakeFirst();
  if (!row) return null;
  const { groupId, ...legRow } = row;
  return { leg: rowToLeg(legRow as TravelLegsTable), groupId };
}

/** Same as `getTravelLegWithGroup`, for an accommodation. */
export async function getAccommodationWithGroup(
  db: Kysely<DB>,
  accomId: string,
): Promise<{ accommodation: Accommodation; groupId: string } | null> {
  const row = await db
    .selectFrom('accommodations')
    .innerJoin('trips', 'trips.id', 'accommodations.trip_id')
    .selectAll('accommodations')
    .select('trips.group_id as groupId')
    .where('accommodations.id', '=', accomId)
    .executeTakeFirst();
  if (!row) return null;
  const { groupId, ...accomRow } = row;
  return { accommodation: rowToAccom(accomRow as AccommodationsTable), groupId };
}

/**
 * Removing a leg/accommodation is a real (hard) delete — unlike the trip
 * itself, there's no "Deleted" section for a single line item to come back
 * from. Meant for a cancelled leg/stay the user wants gone rather than just
 * struck through; nothing stops removing a live one too.
 */
export async function removeTravelLeg(db: Kysely<DB>, legId: string): Promise<boolean> {
  const row = await db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .selectAll('travel_legs')
    .select('trips.group_id as groupId')
    .where('travel_legs.id', '=', legId)
    .executeTakeFirst();
  const [result] = await db.deleteFrom('travel_legs').where('id', '=', legId).execute();
  const removed = result !== undefined && result.numDeletedRows > 0n;
  if (removed && row) {
    const { groupId, ...leg } = row;
    await releaseLegFlightEvent(db, groupId, leg as TravelLegsTable).catch((err) => {
      logger.warn('travel-leg calendar event release failed', {
        err: err instanceof Error ? err.message : String(err),
        legId,
      });
    });
  }
  return removed;
}

/**
 * A leg is gone (removed, or its mailbox disconnected): its flight's calendar
 * event goes with it, unless someone else is still on that flight, in which
 * case only this passenger comes off the event, and an event keyed to this leg
 * is handed to one of them. Before this, Remove deleted the leg alone and left
 * its event on the calendar for a flight nobody was booked on. Call after the
 * leg row is deleted, with the row as it was.
 */
export async function releaseLegFlightEvent(
  db: Kysely<DB>,
  groupId: string,
  leg: TravelLegsTable,
): Promise<void> {
  if (leg.mode !== 'flight' && leg.mode !== 'train') return;
  const ownUid = `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${leg.id}`;
  const event =
    (await db
      .selectFrom('events')
      .select(['id', 'description', 'external_uid'])
      .where('group_id', '=', groupId)
      .where('deleted_at', 'is', null)
      .where('external_uid', '=', ownUid)
      .executeTakeFirst()) ?? (await findFlightEvent(db, groupId, leg));
  if (!event) return;
  const staying = (await legsOnFlight(db, groupId, leg)).filter((l) => l.id !== leg.id);
  if (staying.length === 0) {
    await deleteEvent(db, event.id);
    return;
  }
  const description = removePassenger(event.description, await passengerNameOf(db, leg));
  if (description !== event.description) await updateEvent(db, event.id, { description });
  if (event.external_uid === ownUid) {
    await db
      .updateTable('events')
      .set({ external_uid: `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${staying[0]!.id}` })
      .where('id', '=', event.id)
      .execute();
  }
}

export async function removeAccommodation(db: Kysely<DB>, accomId: string): Promise<boolean> {
  const [result] = await db.deleteFrom('accommodations').where('id', '=', accomId).execute();
  return result !== undefined && result.numDeletedRows > 0n;
}

export interface MoveTravelLegResult {
  leg: TravelLeg;
  sourceTripId: string;
  /** True when the leg was the source trip's last leg/accommodation/
   *  reservation, so it was folded away via maybeDeleteEmptyTrip. */
  sourceTripDeleted: boolean;
}

/**
 * Re-parent ONE leg onto a different trip — the Trips tab's per-row drag
 * ("split this flight out of the merge" / "this leg got filed on the wrong
 * trip"), and the `move_leg` bot tool. Unlike `mergeTrips` this moves a
 * single row, not everything on a trip, so there's no participant/date
 * union beyond widening the TARGET's date range the same way a freshly
 * `addTravelLeg`'d leg would — the source trip's dates are left alone (it
 * may still cover other legs/stays that justify its current window).
 * Folds the source away via `maybeDeleteEmptyTrip` if this was its last
 * item, same recoverable soft-delete every other trip-emptying path uses.
 * Strict group scope on BOTH the leg's own trip and the target.
 */
export async function moveTravelLeg(
  db: Kysely<DB>,
  groupId: string,
  legId: string,
  targetTripId: string,
): Promise<MoveTravelLegResult | null> {
  return db.transaction().execute(async (trx) => {
    const found = await getTravelLegWithGroup(trx, legId);
    if (!found || found.groupId !== groupId) return null;
    const target = await trx.selectFrom('trips').selectAll().where('id', '=', targetTripId).executeTakeFirst();
    if (!target || target.group_id !== groupId) return null;

    const sourceTripId = found.leg.tripId;
    if (sourceTripId === targetTripId) {
      return { leg: found.leg, sourceTripId, sourceTripDeleted: false };
    }

    await trx.updateTable('travel_legs').set({ trip_id: targetTripId }).where('id', '=', legId).execute();

    const departDate = found.leg.departAt.slice(0, 10);
    const arriveDate = found.leg.arriveAt.slice(0, 10);
    const newStart = departDate < target.start_date ? departDate : target.start_date;
    const newEnd = arriveDate > target.end_date ? arriveDate : target.end_date;
    if (newStart !== target.start_date || newEnd !== target.end_date) {
      await trx.updateTable('trips').set({ start_date: newStart, end_date: newEnd }).where('id', '=', targetTripId).execute();
    }

    if (found.leg.personaId) {
      await trx
        .insertInto('trip_participants')
        .values({ trip_id: targetTripId, persona_id: found.leg.personaId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }

    const sourceTripDeleted = await maybeDeleteEmptyTrip(trx, sourceTripId);

    const row = await trx.selectFrom('travel_legs').selectAll().where('id', '=', legId).executeTakeFirstOrThrow();
    return { leg: rowToLeg(row), sourceTripId, sourceTripDeleted };
  });
}

export interface MoveAccommodationResult {
  accommodation: Accommodation;
  sourceTripId: string;
  sourceTripDeleted: boolean;
}

/** Same as `moveTravelLeg`, for an accommodation. */
export async function moveAccommodation(
  db: Kysely<DB>,
  groupId: string,
  accomId: string,
  targetTripId: string,
): Promise<MoveAccommodationResult | null> {
  return db.transaction().execute(async (trx) => {
    const found = await getAccommodationWithGroup(trx, accomId);
    if (!found || found.groupId !== groupId) return null;
    const target = await trx.selectFrom('trips').selectAll().where('id', '=', targetTripId).executeTakeFirst();
    if (!target || target.group_id !== groupId) return null;

    const sourceTripId = found.accommodation.tripId;
    if (sourceTripId === targetTripId) {
      return { accommodation: found.accommodation, sourceTripId, sourceTripDeleted: false };
    }

    await trx.updateTable('accommodations').set({ trip_id: targetTripId }).where('id', '=', accomId).execute();

    const { checkinDate, checkoutDate } = found.accommodation;
    const newStart = checkinDate < target.start_date ? checkinDate : target.start_date;
    const newEnd = checkoutDate > target.end_date ? checkoutDate : target.end_date;
    if (newStart !== target.start_date || newEnd !== target.end_date) {
      await trx.updateTable('trips').set({ start_date: newStart, end_date: newEnd }).where('id', '=', targetTripId).execute();
    }

    const sourceTripDeleted = await maybeDeleteEmptyTrip(trx, sourceTripId);

    const row = await trx.selectFrom('accommodations').selectAll().where('id', '=', accomId).executeTakeFirstOrThrow();
    return { accommodation: rowToAccom(row), sourceTripId, sourceTripDeleted };
  });
}

/**
 * Called after removing a leg/accommodation: if the trip now has nothing on
 * it at all (no legs, no accommodations, no reservations), soft-delete it
 * too rather than leaving an empty shell — recoverable the same way a direct
 * delete is. A trip that still holds a reservation (e.g. a dinner booking)
 * is left alone even with every leg/stay gone.
 */
export async function maybeDeleteEmptyTrip(db: Kysely<DB>, tripId: string): Promise<boolean> {
  const [anyLeg, anyAccom, anyReservation] = await Promise.all([
    db.selectFrom('travel_legs').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
    db.selectFrom('accommodations').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
    db.selectFrom('trip_reservations').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
  ]);
  if (anyLeg || anyAccom || anyReservation) return false;
  const [result] = await db
    .updateTable('trips')
    .set({ deleted_at: new Date().toISOString() })
    .where('id', '=', tripId)
    .where('deleted_at', 'is', null)
    .execute();
  return result !== undefined && result.numUpdatedRows > 0n;
}

function rowToReservation(row: TripReservationsTable): TripReservation {
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind,
    name: row.name,
    dateTime: row.date_time ?? undefined,
    address: row.address ?? undefined,
    confirmation: row.confirmation ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
  };
}

export interface AddReservationInput {
  tripId: string;
  kind: TripReservation['kind'];
  name: string;
  dateTime?: string;
  address?: string;
  confirmation?: string;
  notes?: string;
  sourceRawContext?: string;
}

export async function addReservation(
  db: Kysely<DB>,
  input: AddReservationInput,
): Promise<TripReservation> {
  const id = newId('res');
  const row: TripReservationsTable = {
    id,
    trip_id: input.tripId,
    kind: input.kind,
    name: input.name,
    date_time: input.dateTime ?? null,
    address: input.address ?? null,
    confirmation: input.confirmation ?? null,
    notes: input.notes ?? null,
    created_at: new Date().toISOString(),
    source_raw_context: input.sourceRawContext ?? null,
  };
  await db.insertInto('trip_reservations').values(row).execute();
  return rowToReservation(row);
}

export async function listReservationsForTrip(
  db: Kysely<DB>,
  tripId: string,
): Promise<TripReservation[]> {
  const rows = await db
    .selectFrom('trip_reservations')
    .selectAll()
    .where('trip_id', '=', tripId)
    .orderBy(textInstant('trip_reservations.date_time'), 'asc')
    .execute();
  return rows.map(rowToReservation);
}

export async function listLegsForTrip(
  db: Kysely<DB>,
  tripId: string,
): Promise<TravelLeg[]> {
  const rows = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('trip_id', '=', tripId)
    .orderBy(textInstant('travel_legs.depart_at'), 'asc')
    .execute();
  return rows.map(rowToLeg);
}

/**
 * Find travel legs the user can see (their group's trips), narrowed by any
 * provided descriptors. Used to resolve which leg a conversational request
 * ("the Tokyo flight is Nolan's") refers to. origin/destination are
 * case-insensitive substring matches; date matches the departure day.
 */
export async function findMatchingLegs(
  db: Kysely<DB>,
  opts: {
    groupId: string;
    userId: string;
    tripId?: string;
    origin?: string;
    destination?: string;
    flightNo?: string;
    date?: string;
  },
): Promise<TravelLeg[]> {
  let q = db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('trips.group_id', '=', opts.groupId)
    .where('group_members.user_id', '=', opts.userId)
    .selectAll('travel_legs');
  if (opts.tripId) q = q.where('travel_legs.trip_id', '=', opts.tripId);
  if (opts.flightNo) q = q.where('travel_legs.flight_no', '=', opts.flightNo);
  // ILIKE — origin/destination come from user prose ("Tokyo" vs "tokyo");
  // PG LIKE is case-sensitive.
  if (opts.origin) q = q.where('travel_legs.origin', 'ilike', likeContains(opts.origin));
  if (opts.destination) q = q.where('travel_legs.destination', 'ilike', likeContains(opts.destination));
  const rows = await q.orderBy(textInstant('travel_legs.depart_at'), 'asc').execute();
  const legs = rows.map(rowToLeg);
  return opts.date ? legs.filter((l) => l.departAt.slice(0, 10) === opts.date) : legs;
}

/**
 * Same as `findMatchingLegs`, for accommodations — narrowed by descriptors
 * to resolve which stay a conversational request ("move the Savoy stay to
 * the London trip") refers to. propertyName is a case-insensitive substring
 * match; checkinDate matches exactly.
 */
export async function findMatchingAccommodations(
  db: Kysely<DB>,
  opts: {
    groupId: string;
    userId: string;
    tripId?: string;
    propertyName?: string;
    checkinDate?: string;
  },
): Promise<Accommodation[]> {
  let q = db
    .selectFrom('accommodations')
    .innerJoin('trips', 'trips.id', 'accommodations.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('trips.group_id', '=', opts.groupId)
    .where('group_members.user_id', '=', opts.userId)
    .selectAll('accommodations');
  if (opts.tripId) q = q.where('accommodations.trip_id', '=', opts.tripId);
  if (opts.propertyName) q = q.where('accommodations.property_name', 'ilike', likeContains(opts.propertyName));
  if (opts.checkinDate) q = q.where('accommodations.checkin_date', '=', opts.checkinDate);
  const rows = await q.orderBy('accommodations.checkin_date', 'asc').execute();
  return rows.map(rowToAccom);
}

/**
 * Flights the user is about to take, for the bot's context block (ADR 0138).
 *
 * Scope follows ADR 0096: a shared group sees that group's legs, the personal
 * 1:1 sees every group the user belongs to. Membership-bounded either way, and
 * the caller renders names only — never a group id (ADR 0032's scrubber).
 */
const departInstant = textInstant('travel_legs.depart_at');

export async function findUpcomingFlights(
  db: Kysely<DB>,
  opts: { userId: string; groupId?: string; sinceMs: number; untilMs: number; limit: number },
): Promise<TravelLeg[]> {
  return findUpcomingLegs(db, { ...opts, flightsOnly: true });
}

/**
 * Legs departing in the window across the trips the user can see (one group,
 * or all of theirs when `groupId` is omitted), soonest first, each with its
 * trip's name. `flightsOnly` narrows to flights that carry a number.
 */
export async function findUpcomingLegs(
  db: Kysely<DB>,
  opts: {
    userId: string;
    groupId?: string;
    sinceMs: number;
    untilMs: number;
    limit: number;
    flightsOnly?: boolean;
  },
): Promise<Array<TravelLeg & { tripName: string }>> {
  let q = db
    .selectFrom('travel_legs')
    .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
    .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
    .where('group_members.user_id', '=', opts.userId)
    // ADR 0168 — the bot must not casually mention a cancelled leg as upcoming.
    .where('travel_legs.cancelled_at', 'is', null)
    .where('trips.cancelled_at', 'is', null)
    // ADR 0171 — a deleted trip is in the bin, not on the way.
    .where('trips.deleted_at', 'is', null)
    // depart_at is text in the leg's own offset ("…T15:25:00-04:00"), so a
    // text comparison against a UTC "…Z" bound is off by the offset - a flight
    // that left three hours ago in New York sorted before a six-hour-back
    // window and vanished from the bot's view. Compare as instants. The regex
    // guard keeps one malformed row from failing the cast for every row.
    .where(departInstant, '>=', new Date(opts.sinceMs).toISOString())
    .where(departInstant, '<=', new Date(opts.untilMs).toISOString())
    .leftJoin('users as traveler', 'traveler.id', 'travel_legs.persona_id')
    .selectAll('travel_legs')
    .select([
      'trips.name as trip_name',
      'traveler.display_name as traveler_display_name',
      'traveler.username as traveler_username',
    ]);
  if (opts.flightsOnly) {
    q = q.where('travel_legs.mode', '=', 'flight').where('travel_legs.flight_no', 'is not', null);
  }
  if (opts.groupId) q = q.where('trips.group_id', '=', opts.groupId);
  const rows = await q.orderBy(departInstant, 'asc').limit(opts.limit).execute();
  // A family member on the leg is named too, or "Alice's flight" finds nothing.
  return rows.map((r) => ({
    ...rowToLeg(r),
    passengerName:
      r.passenger_name ?? ((r.traveler_display_name || r.traveler_username) || undefined),
    tripName: r.trip_name,
  }));
}

/** Set (or change) the passenger on an existing leg. Resolving to a group
 *  member stores `personaId`; otherwise the raw name is kept. */
export async function setLegPassenger(
  db: Kysely<DB>,
  legId: string,
  input: { personaId?: string | null; passengerName?: string | null },
): Promise<TravelLeg | null> {
  const prev = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('id', '=', legId)
    .executeTakeFirst();
  if (!prev) return null;
  await db
    .updateTable('travel_legs')
    .set({
      persona_id: input.personaId ?? null,
      passenger_name: input.personaId ? null : input.passengerName ?? null,
    })
    .where('id', '=', legId)
    .execute();
  const row = await db
    .selectFrom('travel_legs')
    .selectAll()
    .where('id', '=', legId)
    .executeTakeFirst();
  if (!row) return null;
  if (input.personaId) {
    await db
      .insertInto('trip_participants')
      .values({ trip_id: row.trip_id, persona_id: input.personaId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  // The flight's calendar event names every passenger, so it follows the change.
  const changed = (await passengerNameOf(db, prev)) !== (await passengerNameOf(db, row));
  if (changed && !row.cancelled_at && (row.mode === 'flight' || row.mode === 'train')) {
    await syncFlightLegEvent(db, row.trip_id, row, { replacing: prev }).catch((err) => {
      logger.warn('travel-leg calendar passenger sync failed', {
        err: err instanceof Error ? err.message : String(err),
        legId,
      });
    });
  }
  return rowToLeg(row);
}

/**
 * Assign a set of passengers to every flight/leg of a trip. Multiple people on
 * one flight are modelled as one leg per person (the display layer collapses
 * them), so for each distinct flight we reuse a passenger-less placeholder leg
 * for the first new passenger and clone the leg for the rest. People already on
 * a flight are skipped, so it's idempotent.
 */
export async function assignPassengersToTrip(
  db: Kysely<DB>,
  tripId: string,
  passengers: { personaId: string | null; name: string }[],
): Promise<{ flights: number; legsAdded: number }> {
  const legs = await listLegsForTrip(db, tripId);
  const groups = new Map<string, TravelLeg[]>();
  for (const leg of legs) {
    const key = [leg.mode, leg.origin, leg.destination, leg.departAt, leg.arriveAt, leg.carrier ?? '', leg.flightNo ?? ''].join('|');
    const arr = groups.get(key);
    if (arr) arr.push(leg);
    else groups.set(key, [leg]);
  }
  let legsAdded = 0;
  for (const flightLegs of groups.values()) {
    const rep = flightLegs[0]!;
    const presentPersona = new Set(flightLegs.map((l) => l.personaId).filter(Boolean) as string[]);
    const presentNames = new Set(
      flightLegs.map((l) => l.passengerName?.trim().toLowerCase()).filter(Boolean) as string[],
    );
    const placeholders = flightLegs.filter((l) => !l.personaId && !l.passengerName);
    let phIdx = 0;
    for (const p of passengers) {
      const already = p.personaId
        ? presentPersona.has(p.personaId)
        : presentNames.has(p.name.trim().toLowerCase());
      if (already) continue;
      if (phIdx < placeholders.length) {
        await setLegPassenger(db, placeholders[phIdx]!.id, {
          personaId: p.personaId ?? undefined,
          passengerName: p.personaId ? undefined : p.name,
        });
        phIdx++;
      } else {
        await addTravelLeg(db, {
          tripId,
          personaId: p.personaId ?? undefined,
          passengerName: p.personaId ? undefined : p.name,
          mode: rep.mode,
          origin: rep.origin,
          destination: rep.destination,
          departAt: rep.departAt,
          arriveAt: rep.arriveAt,
          carrier: rep.carrier,
          flightNo: rep.flightNo,
          confirmation: rep.confirmation,
          sourceDocId: rep.sourceDocId,
          addingPassenger: true,
        });
        legsAdded++;
      }
      if (p.personaId) presentPersona.add(p.personaId);
      else presentNames.add(p.name.trim().toLowerCase());
    }
  }
  return { flights: groups.size, legsAdded };
}

export async function listAccommodationsForTrip(
  db: Kysely<DB>,
  tripId: string,
): Promise<Accommodation[]> {
  const rows = await db
    .selectFrom('accommodations')
    .selectAll()
    .where('trip_id', '=', tripId)
    .orderBy('checkin_date', 'asc')
    .execute();
  return rows.map(rowToAccom);
}

/**
 * Night-spans within [startDate, endDate) not covered by any accommodation.
 * Each entry is a half-open [start, end) IsoDate interval.
 */
function computeGaps(
  startDate: string,
  endDate: string,
  accommodations: Accommodation[],
): { start: string; end: string }[] {
  if (startDate >= endDate) return [];

  const intervals = accommodations
    .map((a) => [a.checkinDate, a.checkoutDate] as [string, string])
    .filter(([s, e]) => s <= endDate && e >= startDate)
    .sort((a, b) => a[0].localeCompare(b[0]));

  const gaps: { start: string; end: string }[] = [];
  let cursor = startDate;

  for (const [acStart, acEnd] of intervals) {
    const covStart = acStart < startDate ? startDate : acStart;
    const covEnd = acEnd > endDate ? endDate : acEnd;
    if (covStart > cursor) gaps.push({ start: cursor, end: covStart });
    if (covEnd > cursor) cursor = covEnd;
  }

  if (cursor < endDate) gaps.push({ start: cursor, end: endDate });

  return gaps;
}

/**
 * Breaks in each passenger's leg sequence — leg N's arrival and leg N+1's
 * departure not belonging to the same metro (ADR pending, airport-metro.ts).
 *
 * Grouped per passenger (personaId, else the raw passengerName, else one
 * shared "unassigned" bucket for a trip nobody split by name — the common
 * single-family-itinerary case) so one person's flights are never checked
 * against a different person's. Only consecutive legs for the SAME group are
 * compared, in departure order.
 *
 * `sameMetro` returns null when either side is unrecognized, which this
 * treats as "nothing to report" rather than a break — a missed connection
 * check costs nothing, a false "gap" on a trip that's actually fine costs
 * trust (ADR 0133's asymmetry, applied here).
 */
function computeLegGaps(legs: TravelLeg[]): TripStatus['legGaps'] {
  const groups = new Map<string, TravelLeg[]>();
  for (const leg of legs) {
    const key = leg.personaId ?? leg.passengerName ?? '__unassigned__';
    const group = groups.get(key);
    if (group) group.push(leg);
    else groups.set(key, [leg]);
  }

  const legGaps: TripStatus['legGaps'] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(byInstant((l) => l.departAt));
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i]!;
      const next = sorted[i + 1]!;
      if (sameMetro(cur.destination, next.origin) === false) {
        legGaps.push({
          afterLegId: cur.id,
          passengerName: cur.passengerName,
          arrivedAt: cur.destination,
          departingFrom: next.origin,
        });
      }
    }
  }
  return legGaps;
}

export async function getTripStatus(db: Kysely<DB>, tripId: string): Promise<TripStatus | null> {
  const trip = await getTrip(db, tripId);
  if (!trip) return null;
  const [status] = await buildTripStatuses(db, [trip]);
  return status ?? null;
}

function groupByTrip<T>(rows: T[], tripIdOf: (row: T) => string): Map<string, T[]> {
  const byTrip = new Map<string, T[]>();
  for (const row of rows) {
    const list = byTrip.get(tripIdOf(row));
    if (list) list.push(row);
    else byTrip.set(tripIdOf(row), [row]);
  }
  return byTrip;
}

/**
 * Statuses for trips already loaded, in the same order. Every lookup is one
 * query for all the trips (legs, stays, reservations, borrowed stays, names),
 * so the Trips tab costs the same handful of queries however many trips the
 * user has ever had.
 */
async function buildTripStatuses(db: Kysely<DB>, trips: Trip[]): Promise<TripStatus[]> {
  if (trips.length === 0) return [];
  const tripIds = trips.map((t) => t.id);
  const groupIds = [...new Set(trips.map((t) => t.groupId))];
  const minStart = trips.reduce((m, t) => (t.startDate < m ? t.startDate : m), trips[0]!.startDate);
  const maxEnd = trips.reduce((m, t) => (t.endDate > m ? t.endDate : m), trips[0]!.endDate);

  const [legRows, accomRows, reservationRows, borrowableRows] = await Promise.all([
    db.selectFrom('travel_legs').selectAll()
      .where('trip_id', 'in', tripIds)
      .orderBy(textInstant('travel_legs.depart_at'), 'asc')
      .execute(),
    db.selectFrom('accommodations').selectAll()
      .where('trip_id', 'in', tripIds)
      .orderBy('checkin_date', 'asc')
      .execute(),
    db.selectFrom('trip_reservations').selectAll()
      .where('trip_id', 'in', tripIds)
      .orderBy(textInstant('trip_reservations.date_time'), 'asc')
      .execute(),
    // Stays on OTHER trips in the same group that overlap a trip's nights: a
    // hotel itinerary uploaded separately that auto-created its own trip shell
    // instead of linking to this one. Only stays still being kept — never one
    // on a deleted (ADR 0171) or cancelled trip, nor a cancelled stay (ADR 0168).
    db.selectFrom('accommodations')
      .innerJoin('trips', 'trips.id', 'accommodations.trip_id')
      .where('trips.group_id', 'in', groupIds)
      .where('trips.deleted_at', 'is', null)
      .where('trips.cancelled_at', 'is', null)
      .where('accommodations.cancelled_at', 'is', null)
      .where('accommodations.checkin_date', '<=', maxEnd)
      .where('accommodations.checkout_date', '>=', minStart)
      .selectAll('accommodations')
      .select('trips.group_id as trip_group_id')
      .execute(),
  ]);

  const legsByTrip = groupByTrip(legRows.map(rowToLeg), (l) => l.tripId);
  const accomsByTrip = groupByTrip(accomRows.map(rowToAccom), (a) => a.tripId);
  const reservationsByTrip = groupByTrip(reservationRows.map(rowToReservation), (r) => r.tripId);

  // Union trip.participants with unique persona IDs from legs to cover older
  // trips that pre-date the trip_participants upsert in addTravelLeg.
  const peopleByTrip = new Map<string, string[]>();
  for (const trip of trips) {
    const legPersonaIds = (legsByTrip.get(trip.id) ?? []).map((l) => l.personaId).filter(Boolean) as string[];
    peopleByTrip.set(trip.id, [...new Set([...trip.participants, ...legPersonaIds])]);
  }
  const everyone = [...new Set([...peopleByTrip.values()].flat())];
  const personaRows = everyone.length > 0
    ? await db.selectFrom('users').where('id', 'in', everyone)
        .select(['id', 'username', 'display_name as displayName']).execute()
    : [];
  const nameById = new Map(personaRows.map((u) => [u.id, u.displayName || u.username]));

  return trips.map((trip) => {
    const legs = legsByTrip.get(trip.id) ?? [];
    const borrowed = borrowableRows
      .filter((r) =>
        r.trip_group_id === trip.groupId &&
        r.trip_id !== trip.id &&
        r.checkin_date <= trip.endDate &&
        r.checkout_date >= trip.startDate)
      .map(rowToAccom);
    const accommodations = [...(accomsByTrip.get(trip.id) ?? []), ...borrowed];
    accommodations.sort((a, b) => a.checkinDate.localeCompare(b.checkinDate));
    return assembleTripStatus(
      trip, legs, accommodations, reservationsByTrip.get(trip.id) ?? [],
      peopleByTrip.get(trip.id) ?? [], nameById,
    );
  });
}

function assembleTripStatus(
  trip: Trip,
  legs: TravelLeg[],
  accommodations: Accommodation[],
  reservations: TripReservation[],
  allPeople: string[],
  nameById: Map<string, string>,
): TripStatus {
  const participantNames = allPeople.map((pid) => nameById.get(pid) ?? pid);

  // A cancelled stay is still listed (with its badge) but sleeps nobody.
  const gaps = computeGaps(trip.startDate, trip.endDate, accommodations.filter((a) => !a.cancelledAt));
  // Computed from the raw per-passenger legs, before groupLegsByFlight below
  // collapses several passengers onto one shared-flight row.
  const legGaps = computeLegGaps(legs);

  // Collapse legs that are the same flight for different passengers into one
  // entry carrying the resolved passenger names, so the calendar and the bot
  // show "AC823 · Alice, Bob" instead of one identical row per person.
  const groupedLegs = groupLegsByFlight(legs, nameById);

  // Keep trip.participants aligned with participantNames (same order).
  const tripWithAllParticipants = { ...trip, participants: allPeople };
  const narrative = `${trip.name} · ${trip.destination} · ${trip.startDate}→${trip.endDate}`;
  return {
    trip: tripWithAllParticipants,
    legs: groupedLegs,
    accommodations,
    reservations,
    participantNames,
    narrative,
    gaps,
    legGaps,
  };
}

/** A passenger name is the resolved member display name, else the raw name. */
function legPassengerName(leg: TravelLeg, nameById: Map<string, string>): string | null {
  if (leg.personaId) return nameById.get(leg.personaId) ?? leg.personaId;
  return leg.passengerName ?? null;
}

/** Group legs that share a flight (mode + route + times + carrier/flight#) into
 *  one representative leg with a `passengers` list of all their names. */
function groupLegsByFlight(legs: TravelLeg[], nameById: Map<string, string>): TravelLeg[] {
  const groups = new Map<string, { rep: TravelLeg; names: string[] }>();
  for (const leg of legs) {
    const key = [leg.mode, leg.origin, leg.destination, leg.departAt, leg.arriveAt, leg.carrier ?? '', leg.flightNo ?? ''].join('|');
    const name = legPassengerName(leg, nameById);
    const existing = groups.get(key);
    if (existing) {
      if (name && !existing.names.includes(name)) existing.names.push(name);
    } else {
      groups.set(key, { rep: leg, names: name ? [name] : [] });
    }
  }
  return [...groups.values()]
    .map(({ rep, names }) => (names.length > 0 ? { ...rep, passengers: names } : rep))
    .sort(byInstant((l) => l.departAt));
}

export type ShareTripResult =
  | { ok: true; trip: Trip; previousGroupId: string; movedEvents: number }
  | { ok: false; reason: 'not_found' | 'not_personal' | 'not_member' | 'not_shared_group' };

/**
 * ADR 0233 — put a personal trip in a shared group, so the people in it can see
 * who is travelling when.
 *
 * A trip belongs to one group (`trips.group_id`); legs, stays and reservations
 * follow it by `trip_id`, so the move itself is one column. Three things hang
 * off the group id and have to move with it, or the trip half-works:
 *   - the calendar events its flight legs created: the leg sync finds them by
 *     `(group_id, external_uid)`, so an event left behind would be duplicated the
 *     next time a leg is added;
 *   - the people-who-can-see-it fan-out (`catchup_assignments`), run for the
 *     new group;
 *   - participants (user ids, despite the column's name), who are people the
 *     trip said are going: anyone not in the new group is dropped, since the
 *     group could not see who they are.
 *
 * Only the owner's own PERSONAL trip moves, and only into a shared group they
 * are in: "share" widens who sees something private, so it is never available
 * for a trip already in a group (that is a different question — who may move
 * what between groups — and ADR 0032 draws the line at the group).
 *
 * The leg events keep their one owner-copy. This puts the TRIP in front of the
 * group; it does not put the flight on everyone's calendar.
 */
export async function shareTripWithGroup(
  db: Kysely<DB>,
  input: { tripId: string; actorUserId: string; targetGroupId: string },
): Promise<ShareTripResult> {
  const row = await db.selectFrom('trips').selectAll().where('id', '=', input.tripId).executeTakeFirst();
  if (!row || row.deleted_at) return { ok: false, reason: 'not_found' };
  const origin = await db.selectFrom('groups').select(['id', 'kind']).where('id', '=', row.group_id).executeTakeFirst();
  if (origin?.kind !== 'personal' || row.created_by !== input.actorUserId) {
    return { ok: false, reason: 'not_personal' };
  }
  const target = await db
    .selectFrom('groups')
    .select(['id', 'kind'])
    .where('id', '=', input.targetGroupId)
    .executeTakeFirst();
  if (!target || target.kind !== 'group') return { ok: false, reason: 'not_shared_group' };
  const member = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', input.targetGroupId)
    .where('user_id', '=', input.actorUserId)
    .executeTakeFirst();
  if (!member) return { ok: false, reason: 'not_member' };

  let movedEvents = 0;
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('trips').set({ group_id: input.targetGroupId }).where('id', '=', input.tripId).execute();
    const legs = await trx.selectFrom('travel_legs').select('id').where('trip_id', '=', input.tripId).execute();
    if (legs.length > 0) {
      const uids = legs.map((l) => `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}${l.id}`);
      const moved = await trx
        .updateTable('events')
        .set({ group_id: input.targetGroupId, group_ids: sql`jsonb_build_array(${input.targetGroupId}::text)` })
        .where('group_id', '=', origin.id)
        .where('external_uid', 'in', uids)
        .executeTakeFirst();
      movedEvents = Number(moved.numUpdatedRows ?? 0);
    }
    const members = await trx
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', input.targetGroupId)
      .execute();
    const memberIds = members.map((m) => m.user_id);
    let drop = trx.deleteFrom('trip_participants').where('trip_id', '=', input.tripId);
    if (memberIds.length > 0) drop = drop.where('persona_id', 'not in', memberIds);
    await drop.execute();
    // A persona belongs to one group's roster; the person is still going,
    // so their name stays and only the link to the old roster goes.
    await trx
      .updateTable('trip_named_travelers')
      .set({ persona_id: null })
      .where('trip_id', '=', input.tripId)
      .where('persona_id', 'not in', trx.selectFrom('personas').select('id').where('group_id', '=', input.targetGroupId))
      .execute();
  });

  await fanoutAssignment(db, input.targetGroupId, 'trip', input.tripId, {
    type: 'trip',
    primary: row.name,
    secondary: row.destination,
  }).catch((err) => logger.warn('catchup fanout (shared trip) failed', { err }));

  const trip = await getTrip(db, input.tripId);
  return { ok: true, trip: trip!, previousGroupId: origin.id, movedEvents };
}
