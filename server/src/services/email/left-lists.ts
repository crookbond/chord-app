/**
 * Mail from a list the user already left (ADR 0246 addendum 2026-11-05).
 *
 * Once the user asked a sender to stop, its earlier mail says nothing about
 * what to do next: ranking it by that mail hands the same list back as the
 * next thing to unsubscribe from, and keeps it at the top of "who emails me
 * most". So a left sender is counted only by what it sent after the request
 * plus a grace period. Gmail and Yahoo require bulk senders to honour an
 * unsubscribe within two days, so mail inside that window is the request
 * still landing, not the list ignoring it. A list that stopped counts zero and
 * drops out (the next sender moves up); one that kept mailing stays, with an
 * honest count of what came since.
 */
import { sql } from 'kysely';

import { textInstant } from '@/db/text-instant.js';

export const UNSUBSCRIBE_GRACE_DAYS = 2;

/**
 * Join condition for `email_unsubscribes as u` against `email_messages as m`.
 * Senders are compared lowercased on both sides.
 */
export const leftSenderJoin = sql<boolean>`u.user_id = m.user_id and lower(u.sender_email) = lower(m.from_email)`;

/** True for a message that counts: from a sender never left, or sent after the grace. */
export const countsAfterLeaving = sql<boolean>`(u.requested_at is null or ${textInstant('m.internal_date')} >= ${textInstant('u.requested_at')} + make_interval(days => ${UNSUBSCRIBE_GRACE_DAYS}))`;

/** Leave out senders whose future mail already goes to Trash (ADR 0308). */
export function notAutoTrashed(senders: string[]) {
  return senders.length
    ? sql<boolean>`lower(m.from_email) not in (${sql.join(senders)})`
    : sql<boolean>`true`;
}
