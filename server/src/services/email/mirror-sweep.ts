/**
 * Keep the mailbox mirror fresh — and the pipeline running — without the user
 * opening anything (ADR 0144, deepened by ADR 0159).
 *
 * Mail synced in exactly two places: the Email tab forcing a sync on focus,
 * and once a day inside the morning briefing. Nothing else. So read state,
 * deletes and new arrivals only converged on the one screen that force-syncs
 * — every other surface (tiles, unread counts, the decisions queue, To Do's)
 * rendered whatever was true the last time that screen was open.
 *
 * It also meant ADR 0117's new-mail notification could effectively only fire
 * while the user was already looking at their mail, which is the one moment it
 * has nothing to tell them.
 *
 * ADR 0144 ran this at `mirror` depth — refresh the copy, skip the AI layer —
 * reasoning that a background sweep would "multiply LLM spend by however
 * often it runs." That undercounted: every AI pass here (classification,
 * magics, person extraction, attachment import) is gated on NEW or unmarked
 * rows — `selectBatch`/the extraction-mark `NOT EXISTS` queries return empty
 * and make zero LLM calls on a tick with nothing new. Sweep frequency was
 * never the multiplier; per-thread one-time marks already are. What actually
 * changes at `full` depth is WHEN each thread's one-time pass runs — within
 * this tick's cadence instead of at the next app-open or the 7am briefing
 * (ADR 0159) — so a trip/task/person proposal is waiting whether or not
 * anyone looked. Still stops at the ADR 0079 entitlement gate.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { syncAllUserMail } from '../email-accounts/accounts.service.js';

interface SweepCandidate {
  userId: string;
  syncedAt: string | null;
}

type MailSyncEnqueuer = (userId: string) => Promise<void>;

/**
 * Registered by the worker role when the mail-sync BullMQ queue is running
 * (`REDIS_URL` set — `mail-sync.queue.ts`). Injected rather than imported so
 * this module doesn't need to know the queue exists at all when it's not
 * running — mirrors ADR 0118's `setMailboxSyncRunner` indirection.
 */
let mailSyncEnqueuer: MailSyncEnqueuer | null = null;

export function setMailSyncEnqueuer(fn: MailSyncEnqueuer | null): void {
  mailSyncEnqueuer = fn;
}

/**
 * Users whose mirror is stalest, bounded per tick.
 *
 * Ordered oldest-first so the sweep round-robins rather than favouring
 * whoever sorts first: with more users than the batch allows, everyone still
 * comes up, just less often.
 *
 * A `shadow` row is excluded for ADR 0098's reason — it never opens a client,
 * so there is nobody for a refreshed mirror to be fresh FOR.
 *
 * Ordered by `mail_swept_at`, stamped when the sweep takes a user whatever
 * the outcome. `gmail_synced_at` moves only on a successful primary-Gmail
 * sync, so a calendar-only, Outlook/IMAP-only or failing user stayed first
 * for ever, and MAIL_SWEEP_BATCH of them starved everyone else.
 */
async function dueForSweep(db: Kysely<DB>, limit: number): Promise<SweepCandidate[]> {
  const now = new Date(Date.now());
  const cutoff = new Date(now.getTime() - env.MAIL_SWEEP_MINUTES * 60_000).toISOString();
  const rows = await sql<{ user_id: string; synced_at: string | null }>`
    update users set mail_swept_at = ${now.toISOString()}
    where id in (
      select u.id
      from users u
      where coalesce(u.shadow, 0) = 0
        and (
          u.refresh_token_ciphertext is not null
          or exists (select 1 from email_accounts a where a.user_id = u.id)
        )
        and (u.mail_swept_at is null or u.mail_swept_at < ${cutoff})
        and (u.gmail_synced_at is null or u.gmail_synced_at < ${cutoff})
      order by u.mail_swept_at asc nulls first
      limit ${limit}
      for update skip locked
    )
    returning id as user_id, gmail_synced_at as synced_at
  `.execute(db);
  return rows.rows.map((r) => ({ userId: r.user_id, syncedAt: r.synced_at }));
}

/**
 * One sweep pass. Never throws: this runs inside the proactive tick, and a
 * mailbox that is throttling or disconnected must not stop the tick's other
 * work (ADR 0080's Yahoo throttle reaches here as an ordinary rejection).
 *
 * Returns how many users were swept (or, with the queue registered, handed
 * off for syncing), for the caller's log.
 */
export async function sweepMailboxes(db: Kysely<DB>): Promise<number> {
  if (!env.MAIL_SWEEP_ENABLED || !env.GMAIL_ENABLED) return 0;
  let swept = 0;
  let candidates: SweepCandidate[];
  try {
    candidates = await dueForSweep(db, env.MAIL_SWEEP_BATCH);
  } catch (err) {
    logger.warn('mail sweep candidate query failed', { err: (err as Error).message });
    return 0;
  }
  for (const c of candidates) {
    try {
      // `maybeSync*` self-throttle on their own stored timestamps, so a user
      // swept moments ago by any other path costs a row read and nothing
      // more, whichever branch below handles them.
      if (mailSyncEnqueuer) {
        // Queued: MAIL_SYNC_QUEUE_CONCURRENCY governs how many of these run
        // in parallel, decoupled from MAIL_SWEEP_BATCH above.
        await mailSyncEnqueuer(c.userId);
      } else {
        // Sequential fallback, one round per user, unchanged from before
        // the mail-sync queue existed.
        await syncAllUserMail(db, c.userId);
      }
      swept += 1;
    } catch (err) {
      // Both callees already swallow their own provider errors; this catch is
      // for anything that escapes them, so one bad mailbox cannot end the
      // sweep for everyone behind it in the batch.
      logger.warn('mail sweep failed for user', {
        userId: c.userId,
        err: (err as Error).message,
      });
    }
  }
  return swept;
}
