/**
 * ADR 0244 addendum — two emails about one booking, read at the same moment,
 * stage one trip.
 *
 * `stageEmailTripProposal` checked for a pending bundle (ADR 0173) and for the
 * same flight already staged with no lock, so the confirmation and the
 * "your trip is coming up" mail, classified at once by two passes, each found
 * "no trip yet" and each staged a `create_trip`.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { stageEmailTripProposal, type TravelClassifier } from '@/services/email/trip-extraction.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb, urlForDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

const isoDay = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const FLY_OUT = isoDay(60);
const FLY_BACK = isoDay(64);

const BODY =
  'Your booking is confirmed. United UA123 JFK to DEN departing 8:00 AM, returning UA456 DEN to JFK at 5:00 PM. Confirmation ABC123.';

let db: Kysely<DB>;
let other: Kysely<DB>;
let userId: string;
let personalGroupId: string;

beforeEach(async () => {
  db = await openTestDb();
  // A second connection: the test pool has one, which would serialize the two
  // passes and hide the race.
  const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
  const pool = new Pool({ connectionString: urlForDb(name), max: 2 });
  pool.on('error', () => {});
  other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  userId = await createUser(db, 'trip-race');
  personalGroupId = (await ensurePersonalGroup(db, userId)).id;
});
afterEach(async () => {
  await other.destroy();
  await closeTestDb(db);
});

/** Whether a session on this database is waiting for an advisory lock. */
async function waitingOnLock(conn: Kysely<DB>): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(conn);
  return r.rows[0]!.n > 0;
}

/** Both classifications return together, as two processes would. */
function barrierClassifier(n: number, passengerName?: string): TravelClassifier {
  let arrived = 0;
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await all;
    return {
      kind: 'flight',
      confirmation: 'ABC123',
      ...(passengerName ? { passengerName } : {}),
      legs: [
        {
          origin: 'JFK',
          destination: 'DEN',
          departAt: `${FLY_OUT}T08:00:00`,
          arriveAt: `${FLY_OUT}T10:30:00`,
          departZone: 'America/New_York',
          arriveZone: 'America/Denver',
          carrier: 'United',
          flightNo: 'UA123',
        },
        {
          origin: 'DEN',
          destination: 'JFK',
          departAt: `${FLY_BACK}T17:00:00`,
          arriveAt: `${FLY_BACK}T23:00:00`,
          departZone: 'America/Denver',
          arriveZone: 'America/New_York',
          carrier: 'United',
          flightNo: 'UA456',
        },
      ],
    };
  };
}

describe('two emails, one trip (ADR 0244 addendum)', () => {
  const pending = async (tool: string) =>
    (
      await db
        .selectFrom('proposals')
        .select('id')
        .where('proposed_by_user_id', '=', userId)
        .where('tool_name', '=', tool)
        .where('status', '=', 'pending')
        .execute()
    ).length;
  const stageWith = (conn: Kysely<DB>, gid: string, classify: TravelClassifier) =>
    stageEmailTripProposal(
      conn,
      { userId, personalGroupId, gmailThreadId: gid, subject: 'Your flight', bodyText: BODY, userLastTz: 'America/New_York' },
      classify,
    );

  it('read one after the other, the reminder adds no second copy of the legs', async () => {
    // Joining the first email's pending bundle (ADR 0173) staged every leg
    // again, with no check that the bundle already held that flight.
    await stageWith(db, 't_first', barrierClassifier(1));
    await stageWith(db, 't_second', barrierClassifier(1));
    expect(await pending('create_trip')).toBe(1);
    expect(await pending('add_travel_leg')).toBe(2);
  });

  it('a companion on the same flights still joins the trip with their own legs', async () => {
    await stageWith(db, 't_me', barrierClassifier(1, 'John Doe'));
    await stageWith(db, 't_her', barrierClassifier(1, 'Alice Stone'));
    expect(await pending('create_trip')).toBe(1);
    expect(await pending('add_travel_leg')).toBe(4);
  });

  it('the confirmation and the reminder for one booking, read at the same moment, stage ONE trip', async () => {
    // The first pass holds its transaction open (bundle written, not yet
    // committed) until the second has either finished or is seen waiting on
    // a lock: the moment two processes overlap in prod.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let wrote = false;
    const first = db.transaction().execute(async (trx) => {
      await stageWith(trx, 't_booking', barrierClassifier(1));
      wrote = true;
      await held;
    });
    await waitFor(() => wrote);
    let secondDone = false;
    const second = stageWith(other, 't_reminder', barrierClassifier(1)).finally(() => (secondDone = true));
    await waitFor(async () => secondDone || (await waitingOnLock(other)));
    release();
    await Promise.all([first, second]);

    expect(await pending('create_trip')).toBe(1);
    expect(await pending('add_travel_leg')).toBe(2);
  });
});
