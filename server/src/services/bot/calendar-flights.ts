/**
 * Calendar events that are flights but not travel legs - an airline's own
 * invite, "Flight to Denver" typed into Google, an event the email pass made.
 * A family keeps a flight in the calendar as often as in Trips, and a question
 * about "Ben's flight" is usually asked with the calendar in mind, so the
 * bot must see these too. Legs' own calendar copies are skipped: the leg
 * already says everything they do.
 */
import { findFlight, type FlightRef } from '@chord/kernel';
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { eventStartInstant } from '../events.service.js';
import { TRAVEL_LEG_EXTERNAL_UID_PREFIX } from '../trips.service.js';

export interface CalendarFlight {
  id: string;
  title: string;
  startsAt: string;
  location: string | null;
  description: string | null;
  /** The designator when the event names one we can read. */
  flight: FlightRef | null;
}

const FLIGHT_WORD = /\b(flight|flying|fly|airlines?|airways|depart(s|ure)?|boarding)\b|✈/i;

export async function findCalendarFlights(
  db: Kysely<DB>,
  opts: {
    userId: string;
    /** Omit for every group the user belongs to (the personal 1:1). */
    groupId?: string;
    sinceMs: number;
    untilMs: number;
    tz?: string | null;
    limit: number;
  },
): Promise<CalendarFlight[]> {
  const startsAt = eventStartInstant(opts.tz);
  let q = db
    .selectFrom('events')
    .innerJoin('group_members', 'group_members.group_id', 'events.group_id')
    .where('group_members.user_id', '=', opts.userId)
    // Fan-out gives every member a copy (ADR 0040 §7); read only the user's.
    .where('events.owner_user_id', '=', opts.userId)
    .where('events.deleted_at', 'is', null)
    .where('events.status', '!=', 'cancelled')
    .where((eb) =>
      eb.or([
        eb('events.external_uid', 'is', null),
        eb('events.external_uid', 'not like', `${TRAVEL_LEG_EXTERNAL_UID_PREFIX}%`),
      ]),
    )
    .where(sql<boolean>`${startsAt} >= ${new Date(opts.sinceMs).toISOString()}::timestamptz`)
    .where(sql<boolean>`${startsAt} <= ${new Date(opts.untilMs).toISOString()}::timestamptz`)
    // Cheap prefilter; the JS pass below decides.
    .where(
      sql<boolean>`((events.title || ' ' || coalesce(events.description, '')) ~* '(flight|fly|flying|airline|airways|depart|boarding|✈)'
        OR (events.title || ' ' || coalesce(events.description, '')) ~ '[A-Z][A-Z0-9] ?[0-9]{1,4}')`,
    )
    .select([
      'events.id',
      'events.title',
      'events.starts_at',
      'events.location',
      'events.description',
    ])
    .orderBy(startsAt, 'asc')
    .limit(opts.limit * 3);
  if (opts.groupId) q = q.where('events.group_id', '=', opts.groupId);
  const rows = await q.execute();

  const out: CalendarFlight[] = [];
  for (const r of rows) {
    const text = `${r.title}\n${r.description ?? ''}`;
    const flight = findFlight(text);
    if (!flight && !FLIGHT_WORD.test(text)) continue;
    out.push({
      id: r.id,
      title: r.title,
      startsAt: r.starts_at,
      location: r.location,
      description: r.description,
      flight,
    });
    if (out.length >= opts.limit) break;
  }
  return out;
}
