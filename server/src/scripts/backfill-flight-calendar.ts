/**
 * One-off: create the missing calendar-event mirror for existing flight legs
 * and push them to each owner's "Family" Google calendar.
 *
 * Flight legs added before the `syncFlightLegEvent` mirror existed have no row
 * in `events`, so they show only in the Chord trip view and never reached
 * Google. This walks every flight leg, creates the mirror event (keyed by
 * `chord:travel_leg:<legId>`, routed to the owner's Family calendar) for any
 * leg that lacks one, and drains them via the normal two-way push.
 *
 * Idempotent: legs that already have a mirror event are skipped, so re-running
 * is safe. Owners without calendar write scope are skipped (and reported).
 *
 * Usage:
 *   npm run backfill:flights --workspace=server -- --dry-run
 *   npm run backfill:flights --workspace=server
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import { createEvent, findEventByExternalUid } from '../services/events.service.js';
import { ensureChordCalendar, hasCalendarWriteScope } from '../services/google/calendar-write.service.js';
import { getAccessToken } from '../services/google/oauth.service.js';
import { pushDirtyEvents } from '../services/google/two-way-sync.service.js';

const TRAVEL_LEG_PREFIX = 'chord:travel_leg:';

interface FlightLeg {
  id: string;
  group_id: string;
  created_by: string | null;
  origin: string;
  destination: string;
  depart_at: string;
  arrive_at: string;
  carrier: string | null;
  flight_no: string | null;
  source_raw_context: string | null;
}

function flightTitle(leg: FlightLeg): string {
  const flight = [leg.carrier, leg.flight_no].filter(Boolean).join(' ').trim();
  const route = `${leg.origin}→${leg.destination}`;
  return flight ? `${flight} ${route}` : `Flight ${route}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  ensureDataDirs();
  const db = openDb();

  try {
    const legs: FlightLeg[] = await db
      .selectFrom('travel_legs')
      .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
      .where('travel_legs.mode', '=', 'flight')
      .select([
        'travel_legs.id as id',
        'trips.group_id as group_id',
        'trips.created_by as created_by',
        'travel_legs.origin as origin',
        'travel_legs.destination as destination',
        'travel_legs.depart_at as depart_at',
        'travel_legs.arrive_at as arrive_at',
        'travel_legs.carrier as carrier',
        'travel_legs.flight_no as flight_no',
        'travel_legs.source_raw_context as source_raw_context',
      ])
      .execute();

    // Only legs whose mirror event doesn't already exist, grouped by owner.
    const byOwner = new Map<string, FlightLeg[]>();
    let unowned = 0;
    let alreadyMirrored = 0;
    for (const leg of legs) {
      if (!leg.created_by) {
        unowned++;
        continue;
      }
      const exists = await findEventByExternalUid(db, leg.group_id, `${TRAVEL_LEG_PREFIX}${leg.id}`);
      if (exists) {
        alreadyMirrored++;
        continue;
      }
      const list = byOwner.get(leg.created_by) ?? [];
      list.push(leg);
      byOwner.set(leg.created_by, list);
    }

    console.log(
      `${legs.length} flight leg(s): ${alreadyMirrored} already mirrored, ` +
        `${unowned} skipped (no owner), ` +
        `${[...byOwner.values()].reduce((n, l) => n + l.length, 0)} to create across ${byOwner.size} owner(s)`,
    );

    for (const [owner, ownerLegs] of byOwner) {
      if (!(await hasCalendarWriteScope(db, owner))) {
        console.log(`  owner=${owner}: ${ownerLegs.length} leg(s) — SKIP (no calendar write scope)`);
        continue;
      }

      let familyCalId: string;
      try {
        const accessToken = await getAccessToken(db, owner);
        familyCalId = await ensureChordCalendar(db, owner, accessToken);
      } catch (err) {
        console.log(`  owner=${owner}: SKIP — could not resolve Family calendar: ${(err as Error).message}`);
        continue;
      }

      if (dryRun) {
        console.log(`  owner=${owner}: would create ${ownerLegs.length} flight event(s) on "${familyCalId}"`);
        continue;
      }

      for (const leg of ownerLegs) {
        await createEvent(db, {
          groupId: leg.group_id,
          title: flightTitle(leg),
          location: `${leg.origin} → ${leg.destination}`,
          startsAt: leg.depart_at,
          endsAt: leg.arrive_at,
          createdBy: owner,
          externalUid: `${TRAVEL_LEG_PREFIX}${leg.id}`,
          googleCalendarId: familyCalId,
          sourceRawContext: leg.source_raw_context,
        });
      }
      // createEvent fires a background push per event; await an explicit drain so
      // the script doesn't exit (and close the pool) mid-flight.
      const res = await pushDirtyEvents(db, owner);
      console.log(
        `  owner=${owner}: created ${ownerLegs.length} on "${familyCalId}" → ` +
          `pushed created=${res.created} updated=${res.updated} errored=${res.errored}`,
      );
    }

    if (!dryRun) {
      // Let any straggling background pushes settle before closing the pool.
      await new Promise((r) => setTimeout(r, 3000));
      const synced = await db
        .selectFrom('events')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('external_uid', 'like', `${TRAVEL_LEG_PREFIX}%`)
        .where('gcal_event_id', 'is not', null)
        .executeTakeFirst();
      console.log(`done — ${synced?.n ?? 0} flight event(s) now have a Google id`);
    } else {
      console.log('dry-run complete (no changes written)');
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
