/**
 * Deciding on an email-born suggestion is itself a read receipt: to confirm or
 * reject, the owner read enough of the mail to judge what Chord pulled out of
 * it. Leaving the thread bold afterwards makes the Action Items hub and the
 * mailbox disagree about what's been dealt with. Same rule `sendReply` already
 * applies when a reply implies the thread is read.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { applyAccountThreadModify } from '../email-accounts/accounts.service.js';
import { applyThreadModify } from '../google/gmail.service.js';

const GMAIL_PROVENANCE = 'gmail:';

/**
 * Clear UNREAD on the threads behind `provenanceKeys` (`gmail:<threadId>`,
 * where the id is the account-prefixed provider id of ADR 0080). Best-effort:
 * a dead token, a disconnected mailbox, or a thread the mirror no longer holds
 * must never fail the action that triggered this. Threads already read are
 * skipped without touching the provider.
 */
export async function markSourceThreadsRead(
  db: Kysely<DB>,
  userId: string,
  provenanceKeys: Array<string | null>,
): Promise<void> {
  const threadIds = [
    ...new Set(
      provenanceKeys
        .filter((p): p is string => p?.startsWith(GMAIL_PROVENANCE) === true)
        .map((p) => p.slice(GMAIL_PROVENANCE.length)),
    ),
  ];
  if (threadIds.length === 0) return;

  const rows = await db
    .selectFrom('email_threads')
    .select(['id', 'account_id'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', 'in', threadIds)
    .where('is_unread', '=', 1)
    .execute();

  for (const row of rows) {
    try {
      if (row.account_id) {
        await applyAccountThreadModify(db, userId, row.account_id, row.id, { markRead: true });
      } else {
        await applyThreadModify(db, userId, row.id, { markRead: true });
      }
    } catch (err) {
      logger.warn('marking proposal source thread read failed', { err, threadRowId: row.id });
    }
  }
}
