/**
 * Rows that are kept for a while and then removed (ADR 0226).
 *
 * Four kinds of row were written and never deleted. None is large, and none
 * is on the server's own disk, so this is not about space: it is that a table
 * nobody prunes has no stated answer to "how long do we keep this".
 *
 *   - a proactive message that has FIRED. Nothing reads a fired row for long
 *     after it fires.
 *   - a REJECTED proposal. It was offered and declined; nothing reads it.
 *   - an EXPIRED proposal. Read by the Email tab's "still owed" count, which
 *     has no age limit of its own, so the window here is also how long an
 *     unanswered suggestion keeps counting as owed.
 *   - token usage. Billing sums the current period only (ADR 0196); the rest
 *     is cost history.
 *   - an expired session: past SESSION_IDLE_DAYS / SESSION_MAX_DAYS. loadSession
 *     already refuses it; this removes the ones nobody presents again.
 *   - a kept receipt (ADR 0249), by the date of its email. Three years by
 *     default: a yearly charge needs three payments before it counts as
 *     repeating, so a shorter window hides yearly subscriptions.
 *   - a DELETED phone-mirror event (ADR 0057), by when it was deleted. The
 *     phone sync marks a row deleted when the phone no longer has it and only
 *     ever reads live rows; a bug once left 71,525 of them for one user.
 *     Past events themselves are kept: they are the family's history.
 *   - a phone calendar the phone has not sent for 30 days, with the events
 *     mirrored from it (ADR 0057 addendum).
 *
 * Kept on purpose: CONFIRMED proposals (the record of what the user approved)
 * and `email_unsubscribes` (what lets the reader show a sender as already
 * unsubscribed; deleting a row would offer the unsubscribe again).
 */
import type { Kysely } from 'kysely';

import { env } from '../config/env.js';
import { pruneOauthRows } from './ai-apps/oauth.service.js';
import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { textInstant } from '../db/text-instant.js';
import { sessionExpiryCutoffs } from '../utils/session-expiry.js';
import { pruneExpiredPendingState } from './bot/pending-state.js';
import { forgetDeviceCalendar } from './device-calendar.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneResult {
  proactiveMessages: number;
  rejectedProposals: number;
  expiredProposals: number;
  tokenUsage: number;
  receipts: number;
  sessions: number;
  pendingState: number;
  deletedDeviceEvents: number;
  staleDeviceCalendars: number;
  staleDeviceCalendarEvents: number;
  clientRequests: number;
}

const CLIENT_REQUEST_DAYS = 7;

const cutoff = (now: Date, days: number): string =>
  new Date(now.getTime() - days * DAY_MS).toISOString();

const count = (res: { numDeletedRows: bigint }): number => Number(res.numDeletedRows);

/** Delete everything past its window. A window of 0 or less keeps that kind forever. */
export async function pruneOldRows(db: Kysely<DB>, now: Date = new Date()): Promise<PruneResult> {
  const out: PruneResult = {
    proactiveMessages: 0,
    rejectedProposals: 0,
    expiredProposals: 0,
    tokenUsage: 0,
    receipts: 0,
    sessions: 0,
    pendingState: 0,
    deletedDeviceEvents: 0,
    staleDeviceCalendars: 0,
    staleDeviceCalendarEvents: 0,
    clientRequests: 0,
  };

  if (env.RETENTION_PROACTIVE_DAYS > 0) {
    out.proactiveMessages = count(
      await db
        .deleteFrom('proactive_messages')
        // Never a pending row, however old: an unfired message is still owed.
        .where('fired_at', 'is not', null)
        .where('fired_at', '<', cutoff(now, env.RETENTION_PROACTIVE_DAYS))
        .executeTakeFirst(),
    );
  }

  const pruneProposals = async (status: 'rejected' | 'expired', days: number): Promise<number> => {
    if (days <= 0) return 0;
    return count(
      await db
        .deleteFrom('proposals')
        .where('status', '=', status)
        .where((eb) => eb(eb.fn.coalesce('resolved_at', 'created_at'), '<', cutoff(now, days)))
        .executeTakeFirst(),
    );
  };
  out.rejectedProposals = await pruneProposals('rejected', env.RETENTION_REJECTED_PROPOSAL_DAYS);
  out.expiredProposals = await pruneProposals('expired', env.RETENTION_EXPIRED_PROPOSAL_DAYS);

  if (env.RETENTION_TOKEN_USAGE_DAYS > 0) {
    out.tokenUsage = count(
      await db
        .deleteFrom('token_usage')
        .where('created_at', '<', cutoff(now, env.RETENTION_TOKEN_USAGE_DAYS))
        .executeTakeFirst(),
    );
  }

  // Refused by loadSession already; this clears the ones never presented again.
  const { idleBefore, createdBefore } = sessionExpiryCutoffs(now);
  if (idleBefore || createdBefore) {
    out.sessions = count(
      await db
        .deleteFrom('sessions')
        .where((eb) =>
          eb.or([
            ...(idleBefore ? [eb('last_seen_at', '<', idleBefore)] : []),
            ...(createdBefore ? [eb('created_at', '<', createdBefore)] : []),
          ]),
        )
        .executeTakeFirst(),
    );
  }

  if (env.RETENTION_RECEIPT_DAYS > 0) {
    out.receipts = count(
      await db
        .deleteFrom('email_receipts')
        .where(textInstant('email_receipts.email_at', null), '<', cutoff(now, env.RETENTION_RECEIPT_DAYS))
        .executeTakeFirst(),
    );
  }

  if (env.RETENTION_DELETED_DEVICE_EVENT_DAYS > 0) {
    out.deletedDeviceEvents = count(
      await db
        .deleteFrom('events')
        .where('external_uid', 'like', 'device:%')
        .where('deleted_at', 'is not', null)
        .where(textInstant('events.deleted_at', null), '<', cutoff(now, env.RETENTION_DELETED_DEVICE_EVENT_DAYS))
        .executeTakeFirst(),
    );
  }

  if (env.RETENTION_DEVICE_CALENDAR_DAYS > 0) {
    const forgotten = await pruneStaleDeviceCalendars(
      db,
      cutoff(now, env.RETENTION_DEVICE_CALENDAR_DAYS),
    );
    out.staleDeviceCalendars = forgotten.calendars;
    out.staleDeviceCalendarEvents = forgotten.events;
  }

  // ADR 0280 — the bot's pending questions carry their own expiry; reads
  // already ignore a dead row, this removes the ones nobody asked about again.
  out.pendingState = await pruneExpiredPendingState(db);

  // ADR 0311 addendum - a repeat of a queued send comes within minutes of the
  // first attempt reaching the server; a week covers a phone left offline.
  out.clientRequests = count(
    await db
      .deleteFrom('client_requests')
      .where('created_at', '<', cutoff(now, CLIENT_REQUEST_DAYS))
      .executeTakeFirst(),
  );
  return out;
}

/**
 * ADR 0057 addendum — a phone calendar the phone has stopped sending (unticked
 * from Mirror, removed from the phone, the phone gone). The phone sync only
 * touches calendars in its batch, and a second phone sends only its own, so
 * "missing from this batch" cannot tell a dropped calendar from another
 * phone's: time is the only safe signal. What is kept and removed is
 * `forgetDeviceCalendar`'s rule, shared with switching Mirror off.
 */
async function pruneStaleDeviceCalendars(
  db: Kysely<DB>,
  before: string,
): Promise<{ calendars: number; events: number }> {
  const stale = await db
    .selectFrom('calendar_sources')
    .select(['id', 'user_id', 'google_calendar_id'])
    .where('provider', '=', 'device')
    .where(textInstant('calendar_sources.last_seen_at', null), '<', before)
    .execute();
  let events = 0;
  for (const src of stale) {
    events += (await forgetDeviceCalendar(db, src.user_id, src.google_calendar_id)).events;
  }
  return { calendars: stale.length, events };
}

let lastRunAt: number | null = null;

/**
 * Run the prune at most once a day from the proactive tick. Kept in memory:
 * a restart runs it again, which costs four indexed deletes that find nothing.
 */
export async function maybePruneOldRows(
  db: Kysely<DB>,
  now: Date = new Date(),
): Promise<PruneResult | null> {
  if (!env.RETENTION_ENABLED) return null;
  if (lastRunAt !== null && now.getTime() - lastRunAt < DAY_MS) return null;
  lastRunAt = now.getTime();
  const out = await pruneOldRows(db, now);
  // ADR 0335 - spent authorization requests and expired connector tokens.
  await pruneOauthRows(db).catch((err) => logger.warn('oauth prune failed', { err }));
  const total =
    out.proactiveMessages +
    out.rejectedProposals +
    out.expiredProposals +
    out.tokenUsage +
    out.receipts +
    out.sessions +
    out.deletedDeviceEvents +
    out.staleDeviceCalendars +
    out.staleDeviceCalendarEvents +
    out.clientRequests;
  if (total > 0) logger.info('pruned old rows', { ...out });
  return out;
}

export function __resetRetentionForTests(): void {
  lastRunAt = null;
}
