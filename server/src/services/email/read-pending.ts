/**
 * A read/unread change the provider has not accepted yet (docs/notes/0199).
 *
 * The user's intent is not thrown away because Gmail, Outlook or IMAP said no
 * once: the mirror keeps showing what they chose, this row remembers that the
 * provider still owes it, and the sweep retries (`read-writes.ts`). While the
 * row exists, `recomputeThread` re-applies it — otherwise the very next sync
 * reads the provider's stale state and flips the thread back, which is what
 * made mail look like it "un-read itself".
 *
 * DB-only on purpose: `gmail.service` reads it from `recomputeThread`, and the
 * provider modules write it, so it must import none of them.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

export const READ_RETRY_FIRST_MS = 60_000;

export async function queueReadWrite(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  unread: boolean,
  err: unknown,
  now: Date = new Date(),
): Promise<void> {
  const iso = now.toISOString();
  const lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  // The latest intent wins and starts a fresh backoff: marking unread after a
  // failed mark-read is a new request, not the old one retried.
  await db
    .insertInto('email_read_writes')
    .values({
      thread_id: threadRowId,
      user_id: userId,
      desired_unread: unread ? 1 : 0,
      attempts: 0,
      next_attempt_at: new Date(now.getTime() + READ_RETRY_FIRST_MS).toISOString(),
      last_error: lastError,
      created_at: iso,
      updated_at: iso,
    })
    .onConflict((oc) =>
      oc.column('thread_id').doUpdateSet({
        desired_unread: unread ? 1 : 0,
        attempts: 0,
        next_attempt_at: new Date(now.getTime() + READ_RETRY_FIRST_MS).toISOString(),
        last_error: lastError,
        updated_at: iso,
      }),
    )
    .execute();
}

/** A write that reached the provider supersedes anything still queued. */
export async function clearReadWrite(db: Kysely<DB>, threadRowId: string): Promise<void> {
  await db.deleteFrom('email_read_writes').where('thread_id', '=', threadRowId).execute();
}

/** The unread state the user asked for and the provider has not confirmed,
 *  or null when nothing is owed. Keyed the way `recomputeThread` is. */
export async function pendingUnread(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
): Promise<boolean | null> {
  const row = await db
    .selectFrom('email_read_writes')
    .innerJoin('email_threads', 'email_threads.id', 'email_read_writes.thread_id')
    .select('email_read_writes.desired_unread')
    .where('email_threads.user_id', '=', userId)
    .where('email_threads.gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirst();
  return row ? row.desired_unread === 1 : null;
}
