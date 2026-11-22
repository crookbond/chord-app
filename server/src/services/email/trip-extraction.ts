/**
 * ADR 0158 — route an email body through the (existing) trip classifier and
 * stage a proposal BUNDLE, rather than teaching the email magics extractor a
 * second trip vocabulary or auto-committing the way the attachment path does.
 *
 * A `flight` result → `create_trip` (unless an existing trip covers the dates)
 * + one `add_travel_leg` per leg. A `hotel` result → `create_trip` (or the
 * matched trip) + `add_accommodation`. All siblings share one `bundle_id` and
 * `provenance = gmail:<threadId>`, so ADR 0009's bundle-confirm creates the
 * trip and its children atomically on one tap.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { dayOf, isBeforeDay, tzToOffsetMinutes } from '../../utils/tz.js';
import {
  bookingNotes,
  classifyTravelDocument,
  hotelTripCity,
  icsYearCorrection,
  legMode,
  shiftYear,
  legDatetime,
  type TravelClassification,
} from '../bot/trip_classifier.js';
import { getLlmForUser } from '../llm/factory.js';
import { isAiRefusal } from '../llm/refusal.js';
import { toolSchemas } from '../bot/tools.js';
import { createProposal } from '../proposals.service.js';
import {
  retractGeneralProposalsForThread,
  withEmailStagingLocks,
} from '../event-convergence.service.js';
import { enqueueTripCancellationNudge } from '../proactive.service.js';
import { stagePersonProposal } from './person-proposal.js';
import {
  cancelAccommodation,
  cancelTravelLeg,
  findAccommodationsToCancelForUser,
  findExistingAccommodation,
  findExistingLeg,
  findLegsToCancelForUser,
  findTripForStay,
  findTripForTraveler,
  getTrip,
  listAccommodationsForTrip,
  listLegsForTrip,
  maybeCancelTrip,
  reconcileBookedLegs,
  rescheduleSameFlight,
} from '../trips.service.js';
import {
  bookingId,
  chainConnects,
  departAtMs,
  placesMatch,
  sameFlight,
  sameTravelerLoose,
  sameTravelerStrict,
  type ChainLeg,
} from '../trips/chain.js';

/** Injectable classifier for tests — defaults to the real LLM classifier.
 *  `today` (YYYY-MM-DD, in the owner's zone) anchors year-less ticket dates —
 *  see `classifyTravelDocument`'s own doc comment for why it's required. */
export type TravelClassifier = (
  filename: string,
  text: string,
  today: string,
) => Promise<TravelClassification | null>;

export interface StageEmailTripOpts {
  userId: string;
  /** The user's personal group — where email-derived entities live (ADR 0084). */
  personalGroupId: string;
  /** `email_threads.gmail_thread_id` — the provenance key. */
  gmailThreadId: string;
  subject: string | null;
  bodyText: string;
  /** `users.last_tz` — anchors bare ticket times to the traveller's zone. */
  userLastTz: string | null;
  /**
   * ADR 0177 — the DTSTART of a non-invite (PUBLISH/no-METHOD) `.ics`
   * attached to this same message, when there is one. A ticket/confirmation
   * body routinely omits the year ("Thu, Feb 11"); the `.ics` almost always
   * carries the real one. Used only to CORRECT the classifier's own
   * year-resolution when the month/day already agree — never trusted over
   * the body for anything else (property/confirmation/address/etc. are
   * usually richer in the body than in a thin calendar file).
   */
  icsDateHint?: string;
}

export type StageEmailTripResult = 'flight' | 'hotel' | 'cancellation' | 'none';

const MIN_BODY_CHARS = 80; // the classifier itself needs this much to try

export async function stageEmailTripProposal(
  db: Kysely<DB>,
  opts: StageEmailTripOpts,
  classifyOverride?: TravelClassifier,
): Promise<StageEmailTripResult> {
  // The model that reads the mail is the owner's own key when they have one (ADR 0257).
  const classify: TravelClassifier =
    classifyOverride ??
    (async (filename, text, today) =>
      classifyTravelDocument(filename, text, today, undefined, await getLlmForUser(db, opts.userId, 'trip_classify')));
  const text = (opts.bodyText ?? '').trim();
  if (text.length < MIN_BODY_CHARS) return 'none';

  const today = dayOf(new Date().toISOString(), opts.userLastTz);
  let result: TravelClassification | null;
  try {
    result = await classify(opts.subject?.trim() || 'email', text, today);
  } catch (err) {
    // Refused before anything was sent: the caller decides (no mark, it waits).
    if (isAiRefusal(err)) throw err;
    logger.warn('email trip classify failed', {
      err: (err as Error).message,
      gid: opts.gmailThreadId,
    });
    return 'none';
  }
  if (
    !result ||
    (result.kind !== 'flight' && result.kind !== 'hotel' && result.kind !== 'cancellation')
  ) {
    return 'none';
  }

  // ADR 0168 — a cancellation is applied directly (the notice IS the
  // confirmation), not staged as a proposal, so it skips the "already
  // pending" dedup below entirely.
  if (result.kind === 'cancellation') return applyCancellation(db, result, opts);

  const provenance = `gmail:${opts.gmailThreadId}`;
  const booking = result;
  // Everything after the model call runs under the thread's and the user's
  // staging lock (ADR 0244 addendum): the pending-bundle and pending-leg checks
  // compare against OTHER emails' cards, so two bookings read at once must not
  // both find "no trip yet" and each stage a `create_trip`.
  return withEmailStagingLocks(db, opts.userId, provenance, async (trx) => {
    // ADR 0244 - "trip wins". Once this thread is known to be a booking, a card
    // the general extractor staged from the same email before that was known
    // ("Flight UA 1234 from Newark to Denver") is the booking in a worse shape.
    const claimed = async (kind: StageEmailTripResult): Promise<StageEmailTripResult> => {
      if (kind !== 'none') await retractGeneralProposalsForThread(trx, opts.userId, provenance);
      return kind;
    };
    // ADR 0137 — one outcome per thread. A second run must not stage a rival
    // bundle for the same email.
    const already = await trx
      .selectFrom('proposals')
      .select('id')
      .where('proposed_by_user_id', '=', opts.userId)
      .where('provenance', '=', provenance)
      .where('tool_name', 'in', ['create_trip', 'add_travel_leg', 'add_accommodation'])
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (already) return claimed(booking.kind);

    const tzMin = opts.userLastTz ? tzToOffsetMinutes(opts.userLastTz) : null;
    const stageParams = {
      groupId: opts.personalGroupId,
      proposedByUserId: opts.userId,
      proposedByMessageId: null as string | null,
      provenance,
    };

    if (booking.kind === 'flight') {
      const out = await stageFlight(trx, booking, opts, stageParams, tzMin);
      // ADR 0158 — a ticket booked for someone who is not the account owner names
      // a real person the family travels with (Alice, Simon). Propose adding
      // them, through the same consent path as ADR 0076's email-learned people;
      // `stagePersonProposal` no-ops if they're already known or pending.
      if (out === 'flight' && booking.passengerName) {
        await maybeProposePassenger(trx, opts, booking.passengerName, provenance);
      }
      return claimed(out);
    }
    return claimed(await stageHotel(trx, booking, opts, stageParams, tzMin));
  });
}

/**
 * ADR 0168 — locate the trip + child row a cancellation notice refers to and
 * mark it cancelled. Never proposes anything (nothing to confirm about a
 * cancellation that already happened) and never invents a trip to attach
 * to — a cancellation with no matching trip/booking is a safe no-op, on the
 * same asymmetry ADR 0133 applies to tracking numbers: a missed
 * cancellation costs nothing extra, a wrong match would cancel a real trip.
 */
/** "Residence Inn by Marriott Vail (2027-02-11–2027-02-15)" */
function describeAccommodation(a: {
  propertyName: string;
  checkinDate: string;
  checkoutDate: string;
}): string {
  return `${a.propertyName} (${a.checkinDate}–${a.checkoutDate})`;
}

/** "UA123 JFK→DEN (2027-02-11)", or "JFK→DEN flight (2027-02-11)" with no carrier/number. */
function describeLeg(l: {
  carrier?: string | null;
  flightNo?: string | null;
  origin: string;
  destination: string;
  departAt: string;
}): string {
  const flight = [l.carrier, l.flightNo].filter(Boolean).join(' ').trim();
  const route = `${l.origin}→${l.destination}`;
  const when = l.departAt.slice(0, 10);
  return flight ? `${flight} ${route} (${when})` : `${route} flight (${when})`;
}

async function applyCancellation(
  db: Kysely<DB>,
  cancellation: Extract<TravelClassification, { kind: 'cancellation' }>,
  opts: StageEmailTripOpts,
): Promise<StageEmailTripResult> {
  const confirmation = cancellation.confirmation ?? cancellation.itineraryNumber;

  // The cancelled item is found across EVERY trip the user can reach, by its
  // booking reference (or, without one, by route + day / property + dates) —
  // never inside a trip picked by date first, which could be the wrong trip
  // (or several overlapping ones) and miss it.
  const cancelledByTrip = new Map<string, string[]>();
  const note = (tripId: string, description: string) => {
    const list = cancelledByTrip.get(tripId);
    if (list) list.push(description);
    else cancelledByTrip.set(tripId, [description]);
  };

  if (cancellation.cancelsKind === 'hotel') {
    const accoms = await findAccommodationsToCancelForUser(db, {
      userId: opts.userId,
      propertyName: cancellation.propertyName,
      checkinDate: cancellation.checkinDate,
      checkoutDate: cancellation.checkoutDate,
      confirmation,
    });
    for (const accom of accoms) {
      await cancelAccommodation(db, accom.id);
      note(accom.tripId, describeAccommodation(accom));
    }
  } else {
    const legs = await findLegsToCancelForUser(db, {
      userId: opts.userId,
      confirmation,
      legs: cancellation.legs ?? [],
    });
    for (const leg of legs) {
      await cancelTravelLeg(db, leg.id);
      note(leg.tripId, describeLeg(leg));
    }
  }

  if (cancelledByTrip.size === 0) return 'none';

  for (const [tripId, cancelledDescriptions] of cancelledByTrip) {
    const trip = await getTrip(db, tripId);
    if (!trip) continue;
    await maybeCancelTrip(db, tripId);

    // ADR 0169 — a cancellation closes out ONE booking on a trip that may have
    // others. Tell the family what's still live (or that nothing is), so a
    // cancelled hotel with the flights still booked — or the reverse — doesn't
    // sit unnoticed until someone happens to open the Trips tab.
    const [currentLegs, currentAccoms] = await Promise.all([
      listLegsForTrip(db, tripId),
      listAccommodationsForTrip(db, tripId),
    ]);
    const remainingItems = [
      ...currentLegs.filter((l) => !l.cancelledAt).map(describeLeg),
      ...currentAccoms.filter((a) => !a.cancelledAt).map(describeAccommodation),
    ];
    await enqueueTripCancellationNudge(db, {
      actorUserId: opts.userId,
      groupId: trip.groupId,
      payload: {
        tripId,
        tripName: trip.name,
        destination: trip.destination,
        cancelledItems: cancelledDescriptions,
        remainingItems,
      },
    }).catch((err) => {
      logger.warn('trip cancellation nudge enqueue failed', {
        err: (err as Error).message,
        tripId,
      });
    });
  }

  return 'cancellation';
}

/** Normalised full-name equality (case, punctuation, whitespace). */
function sameName(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const na = n(a);
  return na.length > 0 && na === n(b);
}

async function maybeProposePassenger(
  db: Kysely<DB>,
  opts: StageEmailTripOpts,
  passengerName: string,
  provenance: string,
): Promise<void> {
  const pax = passengerName.trim();
  if (!pax) return;
  const owner = await db
    .selectFrom('users')
    .select(['display_name', 'username', 'first_name', 'last_name', 'preferred_name'])
    .where('id', '=', opts.userId)
    .executeTakeFirst();
  const ownerForms = [
    owner?.display_name,
    [owner?.first_name, owner?.last_name].filter(Boolean).join(' '),
    owner?.preferred_name,
    owner?.username,
  ].filter((s): s is string => !!s && s.trim().length > 0);
  if (ownerForms.some((f) => sameName(f, pax))) return; // the traveller is the account owner
  try {
    await stagePersonProposal(db, {
      userId: opts.userId,
      groupId: opts.personalGroupId,
      name: pax,
      relationship: 'travel companion',
      provenance,
    });
  } catch (err) {
    logger.warn('email trip: passenger person-proposal failed', {
      err: (err as Error).message,
      gid: opts.gmailThreadId,
    });
  }
}

type StageParams = {
  groupId: string;
  proposedByUserId: string;
  proposedByMessageId: string | null;
  provenance: string;
};

/**
 * ADR 0173 — a flight and a hotel for the same trip routinely arrive as two
 * separate emails, mined independently. `findTripByDateRange` only sees
 * CONFIRMED trips, so without this, whichever thread mines second sees no
 * existing trip yet (the first's `create_trip` is still a pending proposal,
 * not a real row) and mints its own — two trips for one vacation. Checked
 * only after `findTripByDateRange` finds nothing real; reuses the pending
 * bundle's id so the second thread's children ride into the same
 * `create_trip` on confirm — no other wiring needed, since bundle-confirm
 * (ADR 0009) already resolves every proposal sharing a `bundle_id` fresh at
 * confirm time, whenever each was added.
 */
interface PendingBundle {
  bundleId: string;
  tripName: string;
  destination: string;
  startDate: string;
  endDate: string;
  legs: (ChainLeg & { personaName?: string; confirmation?: string })[];
}

/** Every unconfirmed trip bundle in the group, with its staged legs. A bundle
 *  with no `create_trip` rides on a real trip and is not a candidate. */
async function loadPendingTripBundles(db: Kysely<DB>, groupId: string): Promise<PendingBundle[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['bundle_id', 'tool_name', 'args_json'])
    .where('group_id', '=', groupId)
    .where('tool_name', 'in', ['create_trip', 'add_travel_leg'])
    .where('status', '=', 'pending')
    .where('bundle_id', 'is not', null)
    .where('expires_at', '>', new Date().toISOString())
    .execute();
  const byBundle = new Map<string, PendingBundle>();
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  for (const row of rows) {
    if (!row.bundle_id) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(row.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.tool_name === 'create_trip') {
      const startDate = str(args.startDate);
      const endDate = str(args.endDate);
      if (!startDate || !endDate) continue;
      const prior = byBundle.get(row.bundle_id);
      byBundle.set(row.bundle_id, {
        bundleId: row.bundle_id,
        tripName: str(args.name) ?? '',
        destination: str(args.destination) ?? '',
        startDate,
        endDate,
        legs: prior?.legs ?? [],
      });
    }
  }
  for (const row of rows) {
    if (row.tool_name !== 'add_travel_leg' || !row.bundle_id) continue;
    const bundle = byBundle.get(row.bundle_id);
    if (!bundle) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(row.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const origin = str(args.origin);
    const destination = str(args.destination);
    const departAt = str(args.departAt);
    if (!origin || !destination || !departAt) continue;
    bundle.legs.push({
      origin,
      destination,
      departAt,
      arriveAt: str(args.arriveAt),
      personaName: str(args.personaName),
      confirmation: str(args.confirmation),
    });
  }
  return [...byBundle.values()];
}

/**
 * ADR 0173 — a flight and a hotel for the same trip routinely arrive as two
 * separate emails, mined independently, so the second must find the FIRST's
 * still-unconfirmed bundle. Under ADR 0190 that match can never be dates
 * alone: a flight joins a pending bundle only as the same physical flight
 * (a companion), the same booking reference, or the next leg of that same
 * traveler's own chain; a bundle with no legs yet (a hotel-only trip) is
 * joined only by a leg into its own place, within its dates.
 */
async function findPendingTripBundleForFlight(
  db: Kysely<DB>,
  groupId: string,
  legs: (ChainLeg & { personaName?: string; confirmation?: string })[],
  windowStart: string,
  windowEnd: string,
): Promise<PendingBundle | null> {
  const who = { name: legs[0]?.personaName };
  const bid = bookingId(legs[0]?.confirmation);
  for (const b of await loadPendingTripBundles(db, groupId)) {
    if (b.legs.length === 0) {
      const inPlace = legs.some((l) => placesMatch(b.destination, l.destination) || placesMatch(b.destination, l.origin));
      if (inPlace && b.startDate <= windowEnd && b.endDate >= windowStart) return b;
      continue;
    }
    if (b.legs.some((bl) => legs.some((l) => sameFlight(bl, l)))) return b;
    if (
      bid &&
      b.legs.some((bl) => bookingId(bl.confirmation) === bid && sameTravelerLoose({ name: bl.personaName }, who))
    ) {
      return b;
    }
    if (who.name) {
      const mine = b.legs
        .filter((bl) => sameTravelerStrict({ name: bl.personaName }, who))
        .sort((x, y) => departAtMs(x.departAt) - departAtMs(y.departAt));
      if (mine.length > 0 && chainConnects(mine, legs)) return b;
    }
  }
  return null;
}

/** A stay joins a pending bundle by place AND dates — the same rule as a real
 *  trip (`findTripForStay`), since a stay names no traveler. */
async function findPendingTripBundleForStay(
  db: Kysely<DB>,
  groupId: string,
  city: string,
  checkinDate: string,
  checkoutDate: string,
): Promise<string | null> {
  for (const b of await loadPendingTripBundles(db, groupId)) {
    const placeOk =
      placesMatch(b.destination, city) ||
      b.legs.some((l) => placesMatch(l.origin, city) || placesMatch(l.destination, city));
    if (placeOk && b.startDate <= checkoutDate && b.endDate >= checkinDate) return b.bundleId;
  }
  return null;
}

async function stageFlight(
  db: Kysely<DB>,
  flight: Extract<TravelClassification, { kind: 'flight' }>,
  opts: StageEmailTripOpts,
  stage: StageParams,
  tzMin: number | null,
): Promise<StageEmailTripResult> {
  const today = dayOf(new Date().toISOString(), opts.userLastTz);
  const notes = bookingNotes(flight);
  // ADR 0158 — never surface a proposal for a leg that has already flown. A
  // "flight change" email for a trip that is entirely over stages nothing; a
  // mid-trip one keeps only the segments still ahead (ADR 0137's posture — the
  // date is simply past, there is no one to ask).
  const rawLegArgs = flight.legs
    .map((fl) => ({
      mode: legMode(fl.mode),
      origin: fl.origin,
      destination: fl.destination,
      departAt: legDatetime(fl.departAt, fl.origin, fl.departZone, tzMin ?? undefined, opts.userLastTz),
      arriveAt: legDatetime(fl.arriveAt, fl.destination, fl.arriveZone, tzMin ?? undefined, opts.userLastTz),
      carrier: fl.carrier,
      flightNo: fl.flightNo,
      confirmation: flight.confirmation,
      ...(notes ? { notes } : {}),
      personaName: flight.passengerName,
    }))
    .filter((a) => toolSchemas.add_travel_leg.safeParse(a).success);

  // ADR 0177 — correct a wrong-year guess BEFORE the past-date filter below,
  // or a leg the classifier mis-dated into "the past" would be silently
  // dropped before ever reaching the fix. One delta, taken from the first
  // leg, applied uniformly — every leg of one itinerary shares one guess.
  const yearDelta = rawLegArgs[0] ? icsYearCorrection(opts.icsDateHint, rawLegArgs[0].departAt) : 0;
  const aheadArgs = (yearDelta === 0
    ? rawLegArgs
    : rawLegArgs.map((a) => ({
        ...a,
        departAt: shiftYear(a.departAt, yearDelta),
        arriveAt: shiftYear(a.arriveAt, yearDelta),
      }))
  ).filter((a) => !isBeforeDay(a.departAt, today, opts.userLastTz));
  if (aheadArgs.length === 0) return 'none';

  // The same flight already on a trip from a booking with no reference (made
  // in chat): this notice updates it rather than adding a second leg.
  const legArgs: typeof aheadArgs = [];
  for (const a of aheadArgs) {
    const same = await rescheduleSameFlight(db, opts.userId, {
      mode: a.mode,
      origin: a.origin,
      destination: a.destination,
      departAt: a.departAt,
      arriveAt: a.arriveAt,
      carrier: a.carrier,
      flightNo: a.flightNo,
      confirmation: a.confirmation,
      notes: a.notes ?? null,
      passengerName: a.personaName,
    });
    if (same.status === 'none') {
      legArgs.push(a);
      continue;
    }
    logger.info('email trip: same flight already on a trip', {
      legId: same.leg.id,
      status: same.status,
      gid: opts.gmailThreadId,
    });
  }
  if (legArgs.length === 0) return 'flight';

  const dates = legArgs.flatMap((a) => [
    dayOf(a.departAt, opts.userLastTz),
    dayOf(a.arriveAt, opts.userLastTz),
  ]);
  const windowStart = dates.reduce((a, b) => (a < b ? a : b));
  const windowEnd = dates.reduce((a, b) => (a > b ? a : b));

  // ADR 0190 — the same physical flight as one already on a trip, or the
  // next leg of this passenger's own chain, chained by city; never date
  // overlap alone. No passenger name on the document means only the shared
  // flight (and an empty trip shell) can match — it stages its own trip
  // rather than guessing whose chain it continues.
  const existing = await findTripForTraveler(db, {
    userId: opts.userId,
    personaId: null,
    passengerName: legArgs[0]?.personaName,
    legs: legArgs.map((a) => ({
      origin: a.origin,
      destination: a.destination,
      departAt: a.departAt,
      arriveAt: a.arriveAt,
    })),
    confirmation: flight.confirmation,
    preferGroupId: opts.personalGroupId,
  });
  const bundleId = newId('bundle');

  if (existing) {
    // The booking reference pairs this notice's legs with the ones already on
    // the trip: unchanged legs stay, a moved or re-routed flight is updated in
    // place (the notice is the evidence, like a cancellation), and only what
    // has no counterpart is staged as something to add.
    const rec = await reconcileBookedLegs(db, {
      tripId: existing.id,
      confirmation: flight.confirmation,
      passengerName: legArgs[0]?.personaName,
      legs: legArgs,
      allowRouteChange: true,
    });
    if (rec.unresolved.length > 0) {
      logger.warn('email trip: booking has legs the notice no longer accounts for; left in place', {
        tripId: existing.id,
        legIds: rec.unresolved.map((l) => l.id),
        gid: opts.gmailThreadId,
      });
    }
    for (const a of rec.remaining) {
      const dup = await findExistingLeg(db, {
        tripId: existing.id,
        mode: a.mode,
        origin: a.origin,
        destination: a.destination,
        departAt: a.departAt,
        arriveAt: a.arriveAt,
        flightNo: a.flightNo,
        confirmation: a.confirmation,
        passengerName: a.personaName,
      });
      if (dup) continue;
      await createProposal(db, {
        ...stage,
        toolName: 'add_travel_leg',
        args: { ...a, tripId: existing.id },
        bundleId,
      });
    }
    // ADR 0185 — every leg matched an existing one on `existing`: this
    // thread's flight is already on the books (typically the attachment
    // path's auto-commit, which sets no source_raw_context for the general
    // extractor to key off). Returning 'none' here reads to the caller as
    // "not a flight", which falls through to the general magics extractor —
    // the exact duplicate-calendar-event bug this branch exists to prevent.
    // Report the classification kind, same as the "already pending" dedup
    // above, so the thread is marked handled either way.
    return 'flight';
  }

  const pendingBundle = await findPendingTripBundleForFlight(
    db,
    stage.groupId,
    legArgs.map((a) => ({
      origin: a.origin,
      destination: a.destination,
      departAt: a.departAt,
      arriveAt: a.arriveAt,
      personaName: a.personaName,
      confirmation: a.confirmation,
    })),
    windowStart,
    windowEnd,
  );
  if (pendingBundle) {
    // A leg the bundle already holds for the same traveler (the confirmation
    // and its reminder restate the same flights) is not staged twice; a
    // companion on the same flight is a different traveler and still is.
    for (const a of legArgs) {
      const staged = pendingBundle.legs.some(
        (bl) => sameFlight(bl, a) && sameTravelerStrict({ name: bl.personaName }, { name: a.personaName }),
      );
      if (staged) continue;
      await createProposal(db, { ...stage, toolName: 'add_travel_leg', args: a, bundleId: pendingBundle.bundleId });
    }
    return 'flight';
  }

  const tripArgs = {
    name: `Trip to ${legArgs[0]!.destination}`,
    destination: legArgs[legArgs.length - 1]!.destination,
    startDate: windowStart,
    endDate: windowEnd,
  };
  if (!toolSchemas.create_trip.safeParse(tripArgs).success) return 'none';
  await createProposal(db, { ...stage, toolName: 'create_trip', args: tripArgs, bundleId });
  for (const a of legArgs) {
    await createProposal(db, { ...stage, toolName: 'add_travel_leg', args: a, bundleId });
  }
  return 'flight';
}

async function stageHotel(
  db: Kysely<DB>,
  hotel: Extract<TravelClassification, { kind: 'hotel' }>,
  opts: StageEmailTripOpts,
  stage: StageParams,
  tzMin: number | null,
): Promise<StageEmailTripResult> {
  void tzMin; // hotel dates are date-only; no time anchoring needed
  // ADR 0177 — correct a wrong-year guess BEFORE the past-stay check right
  // below, or a stay the classifier mis-dated into "the past" would be
  // silently dropped before ever reaching the fix.
  const yearDelta = icsYearCorrection(opts.icsDateHint, hotel.checkinDate);
  const checkinDate = shiftYear(hotel.checkinDate, yearDelta);
  const checkoutDate = shiftYear(hotel.checkoutDate, yearDelta);
  // ADR 0158 — a stay that has already ended is history; don't propose it.
  if (isBeforeDay(checkoutDate, dayOf(new Date().toISOString(), opts.userLastTz), opts.userLastTz)) return 'none';
  const accomArgs = {
    propertyName: hotel.propertyName,
    address: hotel.address,
    checkinDate,
    checkoutDate,
    roomCount: hotel.roomCount,
    confirmation: hotel.confirmation,
  };
  if (!toolSchemas.add_accommodation.safeParse(accomArgs).success) return 'none';

  // ADR 0190 — a stay has no traveler to chain against; matched by place
  // AND dates together against this group's trips.
  const existing = await findTripForStay(db, {
    userId: opts.userId,
    groupId: opts.personalGroupId,
    city: hotelTripCity(hotel) ?? hotel.address ?? hotel.propertyName,
    checkinDate,
    checkoutDate,
  });
  const bundleId = newId('bundle');

  if (existing) {
    const dup = await findExistingAccommodation(db, { ...accomArgs, tripId: existing.id });
    // ADR 0185 — same reasoning as stageFlight's matched-leg branch: this stay
    // is already on the trip, so report 'hotel' (handled) rather than 'none'
    // (not recognized), or the general extractor stages a duplicate
    // create_event/add_list_item for a room already booked.
    if (dup) return 'hotel';
    await createProposal(db, {
      ...stage,
      toolName: 'add_accommodation',
      args: { ...accomArgs, tripId: existing.id },
      bundleId,
    });
    return 'hotel';
  }

  const pendingBundleId = await findPendingTripBundleForStay(
    db,
    stage.groupId,
    hotelTripCity(hotel) ?? hotel.address ?? hotel.propertyName,
    checkinDate,
    checkoutDate,
  );
  if (pendingBundleId) {
    await createProposal(db, {
      ...stage,
      toolName: 'add_accommodation',
      args: accomArgs,
      bundleId: pendingBundleId,
    });
    return 'hotel';
  }

  const city = hotelTripCity(hotel);
  const tripArgs = {
    name: city ? `Trip to ${city}` : hotel.propertyName,
    destination: city ?? hotel.address ?? hotel.propertyName,
    startDate: checkinDate,
    endDate: checkoutDate,
  };
  if (!toolSchemas.create_trip.safeParse(tripArgs).success) return 'none';
  await createProposal(db, { ...stage, toolName: 'create_trip', args: tripArgs, bundleId });
  await createProposal(db, { ...stage, toolName: 'add_accommodation', args: accomArgs, bundleId });
  return 'hotel';
}
