/**
 * ADR 0312 — disconnecting a mailbox removes what its mail produced: trips
 * (legs, stays, reservations and the legs' calendar events), people, facts
 * about people and the user, and receipts. Pending suggestions and confirmed
 * to-dos are left alone (owner decision).
 *
 * Must run BEFORE the mailbox's threads are deleted: a trip filed from an
 * email attachment is traced through `attachments.origin_email_thread_id`,
 * which the thread delete sets to NULL.
 *
 * A row belongs to a mailbox by its `gmail:<threadId>` provenance. An
 * attached mailbox's thread ids carry its account id as a prefix
 * (`scopedId`), so its rows are `gmail:<accountId>:…`, which only this
 * user's account can produce. The primary Gmail's have no prefix at all, so
 * EVERY member's primary mail looks the same: a family member's leg on a
 * shared trip, or a fact in a shared group, carries a bare `gmail:` too. A
 * primary row is therefore this mailbox's only when its thread is in this
 * user's own primary mirror; a row whose source mail already left the mirror
 * is kept (nothing proves whose it was). Rows written before a source was recorded (people
 * and facts made before this ADR) carry none and are kept: nothing says
 * which mailbox they came from.
 */
import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { maybeDeleteEmptyTrip, releaseLegFlightEvent } from '../trips.service.js';

export type PurgeMailbox = { kind: 'primary' } | { kind: 'account'; accountId: string };

export interface MailboxPurgeResult {
  legs: number;
  accommodations: number;
  reservations: number;
  trips: number;
  people: number;
  memories: number;
  receipts: number;
}

/** Does this provenance column name mail from this mailbox? */
/**
 * `shared` = a row others can write too (a leg on a shared trip, a fact in a
 * shared group), where a bare primary `gmail:` may be another member's. Rows
 * only this user owns (their people, trips they created) need no such proof.
 */
function fromMailbox(
  column: string,
  mailbox: PurgeMailbox,
  userId: string,
  shared: boolean,
): Expression<SqlBool> {
  const col = sql.ref(column);
  if (mailbox.kind === 'account') {
    const prefix = `gmail:${mailbox.accountId}:`;
    // `left(...) =` rather than LIKE: account ids contain `_`, a LIKE wildcard.
    return sql<SqlBool>`left(${col}, ${prefix.length}) = ${prefix}`;
  }
  // The primary's thread ids are bare provider ids with no `:`.
  const bare = sql<SqlBool>`(left(${col}, 6) = 'gmail:' AND strpos(substr(${col}, 7), ':') = 0)`;
  if (!shared) return bare;
  // ...and on a shared row, only a thread in THIS user's primary mirror is
  // theirs (see the header).
  return sql<SqlBool>`(${bare} AND substr(${col}, 7) IN (
      SELECT et.gmail_thread_id FROM email_threads et
      WHERE et.user_id = ${userId} AND et.account_id IS NULL
    ))`;
}

export async function purgeMailboxData(
  db: Kysely<DB>,
  userId: string,
  mailbox: PurgeMailbox,
): Promise<MailboxPurgeResult> {
  const result: MailboxPurgeResult = {
    legs: 0,
    accommodations: 0,
    reservations: 0,
    trips: 0,
    people: 0,
    memories: 0,
    receipts: 0,
  };

  // Files imported from this mailbox's mail (ADR 0071): trips filed from them
  // name the attachment rather than the email.
  let threadsQ = db.selectFrom('email_threads').select('id').where('user_id', '=', userId);
  threadsQ =
    mailbox.kind === 'account'
      ? threadsQ.where('account_id', '=', mailbox.accountId)
      : threadsQ.where('account_id', 'is', null);
  const attachmentIds = (
    await db
      .selectFrom('attachments')
      .select('id')
      .where('origin_email_thread_id', 'in', threadsQ)
      .execute()
  ).map((r) => r.id);

  const userTrips = db.selectFrom('trips').select('id').where('created_by', '=', userId);
  const legs = await db
    .selectFrom('travel_legs')
    .select(['id', 'trip_id'])
    .where('trip_id', 'in', userTrips)
    .where((eb) =>
      eb.or([
        fromMailbox('source_raw_context', mailbox, userId, true),
        ...(attachmentIds.length ? [eb('source_doc_id', 'in', attachmentIds)] : []),
      ]),
    )
    .execute();
  const accommodations = await db
    .selectFrom('accommodations')
    .select(['id', 'trip_id'])
    .where('trip_id', 'in', userTrips)
    .where((eb) =>
      eb.or([
        fromMailbox('source_raw_context', mailbox, userId, true),
        ...(attachmentIds.length ? [eb('source_doc_id', 'in', attachmentIds)] : []),
      ]),
    )
    .execute();
  const reservations = await db
    .selectFrom('trip_reservations')
    .select(['id', 'trip_id'])
    .where('trip_id', 'in', userTrips)
    .where((eb) =>
      eb.or([
        fromMailbox('source_raw_context', mailbox, userId, true),
        ...(attachmentIds.length ? [eb('source_raw_context', 'in', attachmentIds)] : []),
      ]),
    )
    .execute();

  // A leg's flight event goes with it (deleteEvent also removes it from the
  // provider calendar it was pushed to), unless someone booked from another
  // mailbox is still on that flight: then only these passengers come off it.
  const legRows = legs.length
    ? await db
        .selectFrom('travel_legs')
        .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
        .selectAll('travel_legs')
        .select('trips.group_id as groupId')
        .where('travel_legs.id', 'in', legs.map((l) => l.id))
        .execute()
    : [];
  if (legs.length) {
    await db.deleteFrom('travel_legs').where('id', 'in', legs.map((l) => l.id)).execute();
  }
  for (const { groupId, ...leg } of legRows) {
    try {
      await releaseLegFlightEvent(db, groupId, leg);
    } catch (err) {
      logger.warn('mailbox purge: leg event delete failed', { legId: leg.id, err: (err as Error).message });
    }
  }
  if (accommodations.length) {
    await db.deleteFrom('accommodations').where('id', 'in', accommodations.map((a) => a.id)).execute();
  }
  if (reservations.length) {
    await db.deleteFrom('trip_reservations').where('id', 'in', reservations.map((r) => r.id)).execute();
  }
  result.legs = legs.length;
  result.accommodations = accommodations.length;
  result.reservations = reservations.length;

  // A trip the mail made, or one this emptied, goes once nothing is left on
  // it. A trip still holding something typed or from another mailbox stays.
  const madeHere = await db
    .selectFrom('trips')
    .select('id')
    .where('created_by', '=', userId)
    .where('deleted_at', 'is', null)
    .where(fromMailbox('source_raw_context', mailbox, userId, false))
    .execute();
  const touched = new Set([
    ...madeHere.map((t) => t.id),
    ...legs.map((l) => l.trip_id),
    ...accommodations.map((a) => a.trip_id),
    ...reservations.map((r) => r.trip_id),
  ]);
  for (const tripId of touched) {
    if (await maybeDeleteEmptyTrip(db, tripId)) result.trips += 1;
  }

  // People the mail introduced; their dates go with them (FK cascade).
  const people = await db
    .deleteFrom('people')
    .where('owner_user_id', '=', userId)
    .where(fromMailbox('provenance', mailbox, userId, false))
    .returning('id')
    .execute();
  result.people = people.length;
  await db
    .deleteFrom('person_relationships')
    .where('owner_user_id', '=', userId)
    .where(fromMailbox('provenance', mailbox, userId, false))
    .execute();

  // Facts the mail produced, in groups the user belongs to. A fact one of
  // them replaced comes back, or removing the newer one would lose both.
  const myGroups = db.selectFrom('group_members').select('group_id').where('user_id', '=', userId);
  const memories = await db
    .selectFrom('memories')
    .select('id')
    .where('group_id', 'in', myGroups)
    .where(fromMailbox('provenance', mailbox, userId, true))
    .execute();
  if (memories.length) {
    const ids = memories.map((m) => m.id);
    await db.updateTable('memories').set({ superseded_by: null }).where('superseded_by', 'in', ids).execute();
    await db.deleteFrom('memories').where('id', 'in', ids).execute();
  }
  result.memories = memories.length;

  let receiptsQ = db.deleteFrom('email_receipts').where('user_id', '=', userId);
  receiptsQ =
    mailbox.kind === 'account'
      ? receiptsQ.where('account_id', '=', mailbox.accountId)
      : receiptsQ.where('account_id', 'is', null);
  result.receipts = (await receiptsQ.returning('id').execute()).length;

  logger.info('mailbox purge', { userId, mailbox: mailbox.kind === 'account' ? mailbox.accountId : 'primary', ...result });
  return result;
}
