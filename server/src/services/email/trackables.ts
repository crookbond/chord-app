/**
 * The flight or parcel a thread is about, resolved for the reader (ADR 0138).
 *
 * The tile board builds these facts for a whole category; opening one thread
 * wants the same answer for one row, and both rebuild the URL from the stored
 * identity rather than reading a URL out of the database — a template that
 * changes must not leave old rows pointing at a dead page (ADR 0135).
 */
import type { Kysely } from 'kysely';
import type { EmailFlightRef, EmailTrackingRef } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { flightRef } from './tile-facts.js';
import { trackingUrl } from './tracking.js';

export interface ThreadTrackables {
  flight: EmailFlightRef | null;
  tracking: EmailTrackingRef | null;
}

export async function threadTrackables(
  db: Kysely<DB>,
  userId: string,
  threadId: string,
): Promise<ThreadTrackables> {
  const row = await db
    .selectFrom('email_threads')
    .select(['flight_json', 'delivery_json'])
    .where('id', '=', threadId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  const f = row?.flight_json ?? null;
  const d = row?.delivery_json ?? null;
  const carrier = d?.carrier ?? null;
  const number = d?.trackingNumber ?? null;
  const url = carrier && number ? trackingUrl(carrier, number) : null;

  return {
    flight: flightRef(f),
    tracking: carrier && number && url ? { carrier, number, url } : null,
  };
}
