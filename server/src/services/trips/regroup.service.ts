/**
 * ADR 0190 — one-time regroup of trips that were filed under the old
 * date-overlap rule, using the SAME rules the live matcher now uses
 * (`trips/chain.ts`): a trip is one traveler's chain of connected legs, plus
 * anyone on the same physical flight, plus every leg sharing a booking
 * reference.
 *
 * Deliberately conservative — it only ever moves legs it can attribute:
 *  - a leg with no passenger (and not the same flight as anyone's) is
 *    PINNED: it stays on its current trip, and is reported;
 *  - cancelled legs are never clustered (they did not happen);
 *  - nothing is deleted — an emptied trip is soft-deleted (recoverable) and
 *    every move is written to an undo record;
 *  - duplicates are reported, not removed (a leg's calendar event would be
 *    orphaned by a delete — that is its own clean-up).
 * Everything is scoped to ONE group at a time; a leg never crosses groups.
 */
import type { Kysely, Transaction } from 'kysely';

import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { copyTripNamedTravelers } from './travelers.js';
import { createTrip } from '../trips.service.js';
import {
  bookingId,
  chainSeams,
  departAtMs,
  isNameSubset,
  nameTokens,
  sameFlight,
  tokenSetKey,
} from './chain.js';

export interface RegroupLeg {
  id: string;
  tripId: string;
  personaId: string | null;
  passengerName: string | null;
  origin: string;
  destination: string;
  departAt: string;
  arriveAt: string;
  /** The booking reference — a unique join across every leg of one booking. */
  confirmation: string | null;
  createdAt: string;
  cancelled: boolean;
}

export interface RegroupTrip {
  id: string;
  groupId: string;
  name: string;
  createdAt: string;
  createdBy: string | null;
  legs: RegroupLeg[];
  /** Accommodations + reservations — they follow a trip when it is folded. */
  otherItems: number;
}

export type RegroupOp =
  | {
      kind: 'new_trip';
      tripId: string;
      name: string;
      destination: string;
      startDate: string;
      endDate: string;
      createdBy: string | null;
    }
  | { kind: 'move_leg'; legId: string; fromTripId: string; toTripId: string }
  | { kind: 'fold_trip'; fromTripId: string; intoTripId: string };

export interface RegroupPlan {
  groupId: string;
  ops: RegroupOp[];
  /** Legs left exactly where they are because nobody can be named for them. */
  pinnedLegIds: string[];
  /** Same flight recorded more than once for the same (or no) traveler. */
  duplicates: string[][];
}

const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** One identity per traveler: a persona id, or a passenger name — with a bare
 *  name folded into the fuller one it restates ("Ben" → "Ben Doe") only
 *  when exactly one fuller name could be meant. */
function assignIdentities(legs: RegroupLeg[]): Map<string, string | null> {
  const keys = new Map<string, string[]>();
  for (const l of legs) {
    if (l.personaId) continue;
    const tokens = nameTokens(l.passengerName);
    if (tokens.length > 0) keys.set(tokenSetKey(tokens), tokens);
  }
  const canonical = new Map<string, string>();
  for (const [key, tokens] of keys) {
    const supers = [...keys.entries()].filter(([other, t]) => other !== key && isNameSubset(tokens, t) && t.length > tokens.length);
    canonical.set(key, supers.length === 1 ? supers[0]![0] : key);
  }
  const out = new Map<string, string | null>();
  for (const l of legs) {
    if (l.personaId) out.set(l.id, `p:${l.personaId}`);
    else {
      const tokens = nameTokens(l.passengerName);
      out.set(l.id, tokens.length > 0 ? `n:${canonical.get(tokenSetKey(tokens))!}` : null);
    }
  }
  return out;
}

class UnionFind {
  private parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    let c = x;
    while (this.parent.get(c) !== r) {
      const n = this.parent.get(c)!;
      this.parent.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const flightKey = (l: RegroupLeg) =>
  `${l.origin.trim().toLowerCase()}|${l.destination.trim().toLowerCase()}|${departAtMs(l.departAt)}`;

/** Decide, for ONE group's live trips, which legs belong together. Pure. */
export function planGroupRegroup(groupId: string, trips: RegroupTrip[]): RegroupPlan {
  const tripById = new Map(trips.map((t) => [t.id, t]));
  const allLegs = trips.flatMap((t) => t.legs);
  const live = allLegs.filter((l) => !l.cancelled);
  const identity = assignIdentities(live);

  const uf = new UnionFind();
  for (const l of live) uf.add(l.id);

  // Companions: the very same physical flight, whoever is on it.
  const byFlight = new Map<string, RegroupLeg[]>();
  for (const l of live) {
    if (departAtMs(l.departAt) <= 0) continue;
    const k = flightKey(l);
    byFlight.set(k, [...(byFlight.get(k) ?? []), l]);
  }
  for (const group of byFlight.values()) for (const l of group) uf.union(group[0]!.id, l.id);

  // The same booking reference is the same booking: a unique id to join on,
  // whatever the dates, the routes or who is named on each leg. This is also
  // what lets a leg that names nobody be placed at all — it rides with the
  // rest of its booking instead of being pinned.
  const byBooking = new Map<string, RegroupLeg[]>();
  for (const l of live) {
    const bid = bookingId(l.confirmation);
    if (bid) byBooking.set(bid, [...(byBooking.get(bid) ?? []), l]);
  }
  for (const group of byBooking.values()) for (const l of group) uf.union(group[0]!.id, l.id);

  // Each traveler's own chain of connected legs.
  const byIdentity = new Map<string, RegroupLeg[]>();
  for (const l of live) {
    const id = identity.get(l.id);
    if (id) byIdentity.set(id, [...(byIdentity.get(id) ?? []), l]);
  }
  for (const legs of byIdentity.values()) {
    const sorted = [...legs].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt) || byCreated(a, b));
    // A twin of a leg already in the walk (a restated copy) would read as an
    // artificial seam; the flight union above already ties it to its twin.
    const walk = sorted.filter((l, i) => !sorted.slice(0, i).some((p) => sameFlight(p, l)));
    const seams = chainSeams(walk);
    seams.forEach((continues, i) => {
      if (continues) uf.union(walk[i]!.id, walk[i + 1]!.id);
    });
  }

  const members = new Map<string, RegroupLeg[]>();
  for (const l of live) members.set(uf.find(l.id), [...(members.get(uf.find(l.id)) ?? []), l]);

  // A leg nobody can be named for, on no shared flight, is pinned in place.
  const pinnedLegIds: string[] = [];
  const clusters = new Map<string, RegroupLeg[]>();
  for (const [root, legs] of members) {
    if (legs.length === 1 && !identity.get(legs[0]!.id)) pinnedLegIds.push(legs[0]!.id);
    else clusters.set(root, legs);
  }
  for (const l of allLegs) if (l.cancelled) pinnedLegIds.push(l.id);
  const clusterOf = new Map<string, string>();
  for (const [root, legs] of clusters) for (const l of legs) clusterOf.set(l.id, root);

  // A trip belongs to the cluster of the leg it was created for.
  const ownerOfTrip = new Map<string, string>();
  for (const t of trips) {
    const first = [...t.legs].filter((l) => clusterOf.has(l.id)).sort(byCreated)[0];
    if (first) ownerOfTrip.set(t.id, clusterOf.get(first.id)!);
  }

  const ops: RegroupOp[] = [];
  const survivor = new Map<string, string>(); // cluster root -> trip id
  const orderedClusters = [...clusters.entries()].sort(
    (a, b) => byCreated([...a[1]].sort(byCreated)[0]!, [...b[1]].sort(byCreated)[0]!),
  );
  for (const [root, legs] of orderedClusters) {
    const owned = trips.filter((t) => ownerOfTrip.get(t.id) === root).sort(byCreated);
    if (owned.length > 0) {
      survivor.set(root, owned[0]!.id);
      continue;
    }
    const sorted = [...legs].sort((a, b) => departAtMs(a.departAt) - departAtMs(b.departAt));
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const dates = sorted.flatMap((l) => [l.departAt.slice(0, 10), l.arriveAt.slice(0, 10)]).sort();
    const tripId = newId('tr');
    survivor.set(root, tripId);
    ops.push({
      kind: 'new_trip',
      tripId,
      name: `Trip to ${first.destination}`,
      destination: last.destination,
      startDate: dates[0]!,
      endDate: dates[dates.length - 1]!,
      createdBy: tripById.get(first.tripId)?.createdBy ?? null,
    });
  }
  const survivorTrips = new Set(survivor.values());

  for (const t of [...trips].sort(byCreated)) {
    const attributed = t.legs.filter((l) => clusterOf.has(l.id));
    const outgoing = attributed.filter((l) => survivor.get(clusterOf.get(l.id)!) !== t.id);
    if (outgoing.length === 0) continue;
    const destinations = new Set(outgoing.map((l) => survivor.get(clusterOf.get(l.id)!)!));
    if (!survivorTrips.has(t.id) && destinations.size === 1) {
      ops.push({ kind: 'fold_trip', fromTripId: t.id, intoTripId: [...destinations][0]! });
    } else {
      for (const l of outgoing) {
        ops.push({ kind: 'move_leg', legId: l.id, fromTripId: t.id, toTripId: survivor.get(clusterOf.get(l.id)!)! });
      }
    }
  }

  const duplicates: string[][] = [];
  for (const group of byFlight.values()) {
    const ids = new Map<string | null, RegroupLeg[]>();
    for (const l of group) ids.set(identity.get(l.id) ?? null, [...(ids.get(identity.get(l.id) ?? null) ?? []), l]);
    const unnamed = ids.get(null) ?? [];
    for (const [who, legs] of ids) {
      const same = who === null ? legs : [...legs, ...unnamed];
      if (same.length > 1) duplicates.push([...new Set(same.map((l) => l.id))]);
    }
  }

  return { groupId, ops, pinnedLegIds, duplicates: dedupeGroups(duplicates) };
}

function dedupeGroups(groups: string[][]): string[][] {
  const seen = new Set<string>();
  return groups.filter((g) => {
    const key = [...g].sort().join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Loading ───────────────────────────────────────────────────────────────

/** Every group that has at least one live trip with a leg, or just `groupId`. */
export async function loadRegroupInput(
  db: Kysely<DB>,
  opts: { groupId?: string } = {},
): Promise<Map<string, RegroupTrip[]>> {
  let q = db
    .selectFrom('trips')
    .selectAll()
    .where('deleted_at', 'is', null)
    .where('cancelled_at', 'is', null);
  if (opts.groupId) q = q.where('group_id', '=', opts.groupId);
  const trips = await q.execute();
  if (trips.length === 0) return new Map();
  const ids = trips.map((t) => t.id);

  const [legs, accoms, reservations] = await Promise.all([
    db.selectFrom('travel_legs').selectAll().where('trip_id', 'in', ids).execute(),
    db.selectFrom('accommodations').select('trip_id').where('trip_id', 'in', ids).execute(),
    db.selectFrom('trip_reservations').select('trip_id').where('trip_id', 'in', ids).execute(),
  ]);
  const others = new Map<string, number>();
  for (const r of [...accoms, ...reservations]) others.set(r.trip_id, (others.get(r.trip_id) ?? 0) + 1);

  const out = new Map<string, RegroupTrip[]>();
  for (const t of trips) {
    const rt: RegroupTrip = {
      id: t.id,
      groupId: t.group_id,
      name: t.name,
      createdAt: t.created_at,
      createdBy: t.created_by,
      otherItems: others.get(t.id) ?? 0,
      legs: legs
        .filter((l) => l.trip_id === t.id)
        .map((l) => ({
          id: l.id,
          tripId: l.trip_id,
          personaId: l.persona_id,
          passengerName: l.passenger_name,
          origin: l.origin,
          destination: l.destination,
          departAt: l.depart_at,
          arriveAt: l.arrive_at,
          confirmation: l.confirmation,
          createdAt: l.created_at,
          cancelled: l.cancelled_at !== null,
        })),
    };
    out.set(t.group_id, [...(out.get(t.group_id) ?? []), rt]);
  }
  return out;
}

// ── Applying ──────────────────────────────────────────────────────────────

export interface RegroupUndo {
  groupId: string;
  createdTrips: string[];
  /** Rows to put back, in the order they were moved. */
  moves: { table: 'travel_legs' | 'accommodations' | 'trip_reservations'; id: string; fromTripId: string }[];
  /** A trip's dates and soft-delete state before anything touched it. */
  snapshots: { tripId: string; startDate: string; endDate: string; deletedAt: string | null }[];
}

/** Apply one group's plan in ONE transaction and return what it takes to undo it. */
export async function applyRegroupPlan(db: Kysely<DB>, plan: RegroupPlan): Promise<RegroupUndo> {
  const undo: RegroupUndo = { groupId: plan.groupId, createdTrips: [], moves: [], snapshots: [] };
  if (plan.ops.length === 0) return undo;

  await db.transaction().execute(async (trx) => {
    const snapshotted = new Set<string>();
    const snapshot = async (tripId: string) => {
      if (snapshotted.has(tripId)) return;
      snapshotted.add(tripId);
      const t = await trx.selectFrom('trips').select(['start_date', 'end_date', 'deleted_at']).where('id', '=', tripId).executeTakeFirstOrThrow();
      undo.snapshots.push({ tripId, startDate: t.start_date, endDate: t.end_date, deletedAt: t.deleted_at });
    };
    const lostLegs = new Set<string>();

    for (const op of plan.ops) {
      if (op.kind === 'new_trip') {
        await createTrip(trx, {
          id: op.tripId,
          groupId: plan.groupId,
          createdBy: op.createdBy,
          name: op.name,
          destination: op.destination,
          startDate: op.startDate,
          endDate: op.endDate,
          participantIds: [],
        });
        undo.createdTrips.push(op.tripId);
      } else if (op.kind === 'move_leg') {
        await snapshot(op.fromTripId);
        await snapshot(op.toTripId);
        await moveLeg(trx, op.legId, op.fromTripId, op.toTripId, undo);
        lostLegs.add(op.fromTripId);
      } else {
        await snapshot(op.fromTripId);
        await snapshot(op.intoTripId);
        await foldTrip(trx, op.fromTripId, op.intoTripId, undo);
      }
    }

    // A trip that lost legs and is still alive gets its window back from
    // what it actually holds (a widened range came from the legs that left).
    for (const tripId of lostLegs) await shrinkToContents(trx, tripId);
  });
  return undo;
}

async function moveLeg(trx: Transaction<DB>, legId: string, fromTripId: string, toTripId: string, undo: RegroupUndo) {
  const leg = await trx.selectFrom('travel_legs').selectAll().where('id', '=', legId).executeTakeFirstOrThrow();
  await trx.updateTable('travel_legs').set({ trip_id: toTripId }).where('id', '=', legId).execute();
  undo.moves.push({ table: 'travel_legs', id: legId, fromTripId });
  await widen(trx, toTripId, leg.depart_at.slice(0, 10), leg.arrive_at.slice(0, 10));
  if (leg.persona_id) {
    await trx
      .insertInto('trip_participants')
      .values({ trip_id: toTripId, persona_id: leg.persona_id })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  await softDeleteIfEmpty(trx, fromTripId);
}

async function foldTrip(trx: Transaction<DB>, fromTripId: string, intoTripId: string, undo: RegroupUndo) {
  const [legs, accoms, reservations, participants, from] = await Promise.all([
    trx.selectFrom('travel_legs').select('id').where('trip_id', '=', fromTripId).execute(),
    trx.selectFrom('accommodations').select('id').where('trip_id', '=', fromTripId).execute(),
    trx.selectFrom('trip_reservations').select('id').where('trip_id', '=', fromTripId).execute(),
    trx.selectFrom('trip_participants').select('persona_id').where('trip_id', '=', fromTripId).execute(),
    trx.selectFrom('trips').select(['start_date', 'end_date']).where('id', '=', fromTripId).executeTakeFirstOrThrow(),
  ]);
  await trx.updateTable('travel_legs').set({ trip_id: intoTripId }).where('trip_id', '=', fromTripId).execute();
  await trx.updateTable('accommodations').set({ trip_id: intoTripId }).where('trip_id', '=', fromTripId).execute();
  await trx.updateTable('trip_reservations').set({ trip_id: intoTripId }).where('trip_id', '=', fromTripId).execute();
  for (const r of legs) undo.moves.push({ table: 'travel_legs', id: r.id, fromTripId });
  for (const r of accoms) undo.moves.push({ table: 'accommodations', id: r.id, fromTripId });
  for (const r of reservations) undo.moves.push({ table: 'trip_reservations', id: r.id, fromTripId });
  if (participants.length > 0) {
    await trx
      .insertInto('trip_participants')
      .values(participants.map((p) => ({ trip_id: intoTripId, persona_id: p.persona_id })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  await copyTripNamedTravelers(trx, fromTripId, intoTripId);
  await widen(trx, intoTripId, from.start_date, from.end_date);
  await trx.updateTable('trips').set({ deleted_at: new Date().toISOString() }).where('id', '=', fromTripId).execute();
}

async function widen(trx: Transaction<DB>, tripId: string, start: string, end: string) {
  const t = await trx.selectFrom('trips').select(['start_date', 'end_date']).where('id', '=', tripId).executeTakeFirstOrThrow();
  const newStart = start < t.start_date ? start : t.start_date;
  const newEnd = end > t.end_date ? end : t.end_date;
  if (newStart !== t.start_date || newEnd !== t.end_date) {
    await trx.updateTable('trips').set({ start_date: newStart, end_date: newEnd }).where('id', '=', tripId).execute();
  }
}

async function softDeleteIfEmpty(trx: Transaction<DB>, tripId: string) {
  const [leg, accom, res] = await Promise.all([
    trx.selectFrom('travel_legs').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
    trx.selectFrom('accommodations').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
    trx.selectFrom('trip_reservations').select('id').where('trip_id', '=', tripId).executeTakeFirst(),
  ]);
  if (leg || accom || res) return;
  await trx.updateTable('trips').set({ deleted_at: new Date().toISOString() }).where('id', '=', tripId).where('deleted_at', 'is', null).execute();
}

async function shrinkToContents(trx: Transaction<DB>, tripId: string) {
  const trip = await trx.selectFrom('trips').select('deleted_at').where('id', '=', tripId).executeTakeFirstOrThrow();
  if (trip.deleted_at) return;
  const [legs, accoms] = await Promise.all([
    // A cancelled row did not happen, so it must not hold the window open.
    trx.selectFrom('travel_legs').select(['depart_at', 'arrive_at']).where('trip_id', '=', tripId).where('cancelled_at', 'is', null).execute(),
    trx.selectFrom('accommodations').select(['checkin_date', 'checkout_date']).where('trip_id', '=', tripId).where('cancelled_at', 'is', null).execute(),
  ]);
  const dates = [
    ...legs.flatMap((l) => [l.depart_at.slice(0, 10), l.arrive_at.slice(0, 10)]),
    ...accoms.flatMap((a) => [a.checkin_date, a.checkout_date]),
  ].sort();
  if (dates.length === 0) return;
  await trx.updateTable('trips').set({ start_date: dates[0]!, end_date: dates[dates.length - 1]! }).where('id', '=', tripId).execute();
}

/** Put everything `applyRegroupPlan` did back. */
export async function undoRegroup(db: Kysely<DB>, undo: RegroupUndo): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const m of [...undo.moves].reverse()) {
      await trx.updateTable(m.table).set({ trip_id: m.fromTripId }).where('id', '=', m.id).execute();
    }
    for (const s of undo.snapshots) {
      await trx
        .updateTable('trips')
        .set({ start_date: s.startDate, end_date: s.endDate, deleted_at: s.deletedAt })
        .where('id', '=', s.tripId)
        .execute();
    }
    for (const tripId of undo.createdTrips) {
      await trx.updateTable('trips').set({ deleted_at: new Date().toISOString() }).where('id', '=', tripId).execute();
    }
  });
}
