/**
 * Keep the calendar mirror fresh without the user opening anything (ADR
 * 0181, mirroring ADR 0144's mail sweep).
 *
 * Two-way calendar sync (ADR 0040 — `syncTwoWay`/`maybeSyncCalendar`) only
 * ever ran opportunistically: a bot `create_event`/`update_event` call, a
 * foreground refresh, or the manual `/me/calendar/sync` route. Prod: a user
 * edited an event directly in Google Calendar (moved it to a different
 * calendar they own) between chat turns, and Chord had no independent
 * trigger to reconcile that — the stale copy on the old calendar sat
 * un-cancelled until the user manually deleted it themselves. Mail hit the
 * identical shape and was fixed by a periodic sweep (ADR 0144); calendar
 * never got the same treatment.
 *
 * `syncTwoWay` is push-then-pull and idempotent, so running it more often
 * than anything actually changed is just a no-op HTTP round trip — there is
 * no AI-pass-multiplication risk here the way ADR 0144 had to reason through
 * for mail.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { calendarsOn } from '../outlook-calendar/enabled.js';
import { gmailCalendarsOn } from '../gmail-calendar/enabled.js';
import { syncTwoWay } from './two-way-sync.service.js';

interface SweepCandidate {
  userId: string;
  syncedAt: string | null;
}

// Same test as `hasCalendarScope` (calendar-write.service.ts), written so
// Postgres can run it too (its regex syntax accepts this source). Two copies
// of one predicate is how ADR 0085's promise breaks, so if this drifts from
// `hasCalendarScope` a candidate-selection test will catch it (both are
// exercised against the same scope strings).
const CALENDAR_SCOPE_RE =
  /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.readonly|\.events|$|\s)/;

/**
 * Users whose calendar mirror is stalest, bounded per tick.
 *
 * Ordered oldest-first so the sweep round-robins rather than favouring
 * whoever sorts first: with more users than the batch allows, everyone still
 * comes up, just less often.
 *
 * A `shadow` row is excluded for ADR 0098's reason — it never opens a
 * client, so there is nobody for a refreshed mirror to be fresh FOR. The
 * calendar-scope test runs in the SQL (Postgres reads `CALENDAR_SCOPE_RE`'s
 * own source, so there is one copy of it), and exactly the users returned are
 * stamped: stamping an over-fetch and syncing only some of it marked the rest
 * swept without syncing them, so they waited a whole cadence for nothing.
 */
async function dueForSweep(db: Kysely<DB>, limit: number): Promise<SweepCandidate[]> {
  const now = new Date(Date.now());
  const cutoff = new Date(now.getTime() - env.CALENDAR_SWEEP_MINUTES * 60_000).toISOString();
  // ADR 0228 — a user with no Google calendar but an Outlook one is swept
  // too. ADR 0313 — and one whose only calendar is an attached Gmail's.
  const outlookOn = calendarsOn();
  const gmailOn = gmailCalendarsOn();
  const rows = await sql<{ user_id: string; synced_at: string | null }>`
    update users u set calendar_swept_at = ${now.toISOString()}
    where u.id in (
      select c.id from users c
      where coalesce(c.shadow, 0) = 0
        and (
          (c.refresh_token_ciphertext is not null
            and coalesce(c.refresh_token_scopes, '') ~ ${CALENDAR_SCOPE_RE.source})
          or (${outlookOn}::boolean and exists (
            select 1 from email_accounts a
            where a.user_id = c.id and a.provider = 'outlook' and a.status = 'ok' and a.calendar_enabled = 1
          ))
          or (${gmailOn}::boolean and exists (
            select 1 from email_accounts a
            where a.user_id = c.id and a.provider = 'gmail' and a.status = 'ok' and a.calendar_enabled = 1
          ))
        )
        and (c.calendar_swept_at is null or c.calendar_swept_at < ${cutoff})
        and (c.google_calendar_synced_at is null or c.google_calendar_synced_at < ${cutoff})
      -- Stamped below whatever the outcome: a dead token never moves
      -- google_calendar_synced_at, and ordered by that it would come first
      -- on every tick and crowd everyone else out.
      order by c.calendar_swept_at asc nulls first
      limit ${limit}
      for update skip locked
    )
    returning u.id as user_id, u.google_calendar_synced_at as synced_at
  `.execute(db);
  return rows.rows.map((r) => ({ userId: r.user_id, syncedAt: r.synced_at }));
}

/**
 * One sweep pass. Never throws: this runs inside the proactive tick, and one
 * user's dead token or a Google-side error must not stop the tick's other
 * work (mirrors ADR 0144's sweepMailboxes).
 *
 * Returns how many users were swept, for the caller's log.
 */
export async function sweepCalendars(db: Kysely<DB>): Promise<number> {
  if (!env.CALENDAR_SWEEP_ENABLED) return 0;
  let swept = 0;
  let candidates: SweepCandidate[];
  try {
    candidates = await dueForSweep(db, env.CALENDAR_SWEEP_BATCH);
  } catch (err) {
    logger.warn('calendar sweep candidate query failed', { err: (err as Error).message });
    return 0;
  }
  for (const c of candidates) {
    try {
      // syncTwoWay itself does not throttle — dueForSweep's own cutoff is
      // what keeps a user recently synced by any other path from being
      // re-swept for no reason.
      await syncTwoWay(db, c.userId);
      swept += 1;
    } catch (err) {
      // syncTwoWay's own pull loop already swallows per-calendar failures;
      // this catch is for anything that escapes it (e.g. a dead token), so
      // one bad user cannot end the sweep for everyone behind them.
      logger.warn('calendar sweep failed for user', {
        userId: c.userId,
        err: (err as Error).message,
      });
    }
  }
  return swept;
}
