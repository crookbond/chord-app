/**
 * Retry read/unread changes a provider refused (docs/notes/0199).
 *
 * Runs on the mail sweep tick. Each retry goes through the provider's own
 * modify path with `fromRetry`, so it is the SAME write a tap makes (including
 * Outlook's stale-id re-resolution) and a success clears the row there. A
 * failure backs off exponentially; after `READ_RETRY_MAX_ATTEMPTS` (about a
 * day) the row is dropped, logged at error, and the mirror is set back to what
 * the provider actually holds — an intent nobody can deliver must not leave
 * Chord and the mailbox disagreeing forever.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { applyAccountThreadModify } from '../email-accounts/accounts.service.js';
import {
  applyLocalThreadLabels,
  applyThreadModify,
  isGoneError,
} from '../google/gmail.service.js';

export const READ_RETRY_MAX_ATTEMPTS = 12;
const READ_RETRY_CAP_MS = 6 * 60 * 60_000;

/** 2, 4, 8 … minutes, capped at 6h: ~26h across the 12 attempts. */
export function readRetryDelayMs(attempts: number): number {
  return Math.min(2 ** attempts * 60_000, READ_RETRY_CAP_MS);
}

export async function flushReadWrites(
  db: Kysely<DB>,
  opts: { now?: Date; limit?: number } = {},
): Promise<{ written: number; retrying: number; abandoned: number }> {
  const now = opts.now ?? new Date();
  const due = await db
    .selectFrom('email_read_writes')
    .innerJoin('email_threads', 'email_threads.id', 'email_read_writes.thread_id')
    .select([
      'email_read_writes.thread_id',
      'email_read_writes.user_id',
      'email_read_writes.desired_unread',
      'email_read_writes.attempts',
      'email_threads.account_id',
      'email_threads.gmail_thread_id',
    ])
    .where('email_read_writes.next_attempt_at', '<=', now.toISOString())
    .orderBy('email_read_writes.next_attempt_at', 'asc')
    .limit(opts.limit ?? 50)
    .execute();

  const out = { written: 0, retrying: 0, abandoned: 0 };
  for (const row of due) {
    const patch = { markRead: row.desired_unread === 0 };
    try {
      if (row.account_id) {
        await applyAccountThreadModify(db, row.user_id, row.account_id, row.thread_id, patch, {
          fromRetry: true,
        });
      } else {
        await applyThreadModify(db, row.user_id, row.thread_id, patch, { fromRetry: true });
      }
      out.written += 1;
      continue;
    } catch (err) {
      const attempts = row.attempts + 1;
      if (isGoneError(err) || attempts >= READ_RETRY_MAX_ATTEMPTS) {
        await db.deleteFrom('email_read_writes').where('thread_id', '=', row.thread_id).execute();
        if (!isGoneError(err)) {
          // The write never landed, so the provider still has the old state —
          // and a delta-based sync will never re-send an unchanged message.
          // Put the mirror back to what the mailbox actually holds.
          const unread = row.desired_unread === 1;
          await applyLocalThreadLabels(
            db,
            row.user_id,
            row.thread_id,
            row.gmail_thread_id,
            unread ? [] : ['UNREAD'],
            unread ? ['UNREAD'] : [],
          );
          logger.error('read-state write abandoned after retries', {
            userId: row.user_id,
            threadRowId: row.thread_id,
            attempts,
            err,
          });
          out.abandoned += 1;
        }
        continue;
      }
      await db
        .updateTable('email_read_writes')
        .set({
          attempts,
          next_attempt_at: new Date(now.getTime() + readRetryDelayMs(attempts)).toISOString(),
          last_error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          updated_at: now.toISOString(),
        })
        .where('thread_id', '=', row.thread_id)
        .execute();
      out.retrying += 1;
    }
  }
  return out;
}
