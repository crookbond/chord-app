/**
 * Undo send (ADR 0115).
 *
 * A queued message is a DRAFT with a time on it. That is the whole design: the
 * content, the recipients and the attachment ids are already the draft's
 * columns (ADR 0113 / 0111), undo is clearing one timestamp, and a send that
 * fails clears the same timestamp and leaves an error — so a message that
 * cannot go lands back where the user was writing it rather than vanishing.
 *
 * The hold is server-side rather than a timer in the composer. A client-side
 * delay means an app killed during the window never sends at all, and the
 * sender has no way to know: they tapped Send and were not told otherwise.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import {
  providerFor,
  sendAccountNew,
  sendAccountReply,
  threadAccountId,
} from '../email-accounts/accounts.service.js';
import { sendNewMessage, sendReply } from '../google/gmail.service.js';
import { deleteDraft } from './drafts.service.js';
import { forwardThread } from './forward.service.js';
import { loadOutgoingAttachments } from './outgoing-attachments.js';

/** How many due messages one tick will send. Bounded so a backlog drains
 *  steadily instead of blocking the tick on a hundred providers at once. */
const PER_TICK = 20;

export interface QueuedSend {
  draftId: string;
  sendAfter: string;
}

/** Stamp a draft as outgoing. The row already holds everything the send needs. */
export async function queueSend(
  db: Kysely<DB>,
  userId: string,
  draftId: string,
  opts: { includeAttachments?: boolean; holdSeconds?: number } = {},
): Promise<QueuedSend | null> {
  const hold = opts.holdSeconds ?? env.EMAIL_UNDO_SECONDS;
  const sendAfter = new Date(Date.now() + Math.max(0, hold) * 1000).toISOString();
  const row = await db
    .updateTable('email_drafts')
    .set({
      send_after: sendAfter,
      include_attachments: opts.includeAttachments === false ? 0 : 1,
      last_error: null,
    })
    .where('id', '=', draftId)
    .where('user_id', '=', userId)
    .returning(['id', 'send_after'])
    .executeTakeFirst();
  return row ? { draftId: row.id, sendAfter: row.send_after as string } : null;
}

/**
 * Undo. Returns false when the message has already gone — which is the honest
 * answer to a tap that lost the race, and the client says so rather than
 * claiming it stopped something it did not.
 */
export async function cancelQueuedSend(
  db: Kysely<DB>,
  userId: string,
  draftId: string,
): Promise<boolean> {
  const row = await db
    .updateTable('email_drafts')
    .set({ send_after: null })
    .where('id', '=', draftId)
    .where('user_id', '=', userId)
    .where('send_after', 'is not', null)
    .returning('id')
    .executeTakeFirst();
  return !!row;
}

async function sendOne(db: Kysely<DB>, row: {
  id: string;
  user_id: string;
  kind: string;
  thread_id: string | null;
  account_id: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  body: string;
  attachment_ids: string[];
  include_attachments: number;
  forward_message_id?: string | null;
  body_format?: string | null;
  body_html?: string | null;
}): Promise<void> {
  // ADR 0339: how it was written; absent on a draft from before the switch.
  const format: 'plain' | 'rich' | undefined =
    row.body_format === 'plain' || row.body_format === 'rich' ? row.body_format : undefined;
  const composed = { format, bodyHtml: format === 'rich' ? row.body_html : null };
  if (row.kind === 'forward' && row.thread_id) {
    await forwardThread(db, row.user_id, row.thread_id, {
      to: row.to_emails,
      cc: row.cc_emails,
      bcc: row.bcc_emails,
      body: row.body,
      ...composed,
      includeAttachments: row.include_attachments === 1,
      attachmentIds: row.attachment_ids,
      ...(row.forward_message_id ? { messageId: row.forward_message_id } : {}),
    });
    return;
  }

  // Attachments are resolved HERE rather than at queue time. A file deleted
  // during the undo window should fail loudly at the moment of sending, not
  // send bytes we captured from a file the user has since removed.
  const provider = await providerFor(db, row.user_id, row.account_id);
  const attachments = await loadOutgoingAttachments(
    db,
    row.user_id,
    row.attachment_ids,
    provider,
  );

  if (row.kind === 'reply' && row.thread_id) {
    const accountId = await threadAccountId(db, row.user_id, row.thread_id);
    const input = {
      threadRowId: row.thread_id,
      body: row.body,
      ...composed,
      to: row.to_emails,
      cc: row.cc_emails,
      bcc: row.bcc_emails,
      attachments,
    };
    const detail = accountId
      ? await sendAccountReply(db, row.user_id, accountId, input)
      : await sendReply(db, row.user_id, input);
    if (!detail) throw new Error('thread no longer exists');
    return;
  }

  const message = {
    to: row.to_emails,
    cc: row.cc_emails,
    bcc: row.bcc_emails,
    subject: row.subject,
    body: row.body,
    ...composed,
    attachments,
  };
  if (row.account_id) await sendAccountNew(db, row.user_id, row.account_id, message);
  else await sendNewMessage(db, row.user_id, message);
}

/** Send everything whose hold has expired. Returns how many actually went. */
export async function flushDueSends(db: Kysely<DB>): Promise<number> {
  const now = new Date().toISOString();
  const due = await db
    .selectFrom('email_drafts')
    .selectAll()
    .where('send_after', 'is not', null)
    .where(sql<boolean>`send_after <= ${now}`)
    .orderBy('send_after', 'asc')
    .limit(PER_TICK)
    .execute();

  // `due` is already capped at PER_TICK, and each row's claim is its own
  // atomic UPDATE ... RETURNING, so the rows are safe to send concurrently.
  // `allSettled`, not `all` — one row rejecting (an unexpected error from the
  // claim step itself, not a send failure, which is already caught below)
  // must not hide whether the other 19 went out.
  const results = await Promise.allSettled(
    due.map(async (row): Promise<boolean> => {
      // Claim it first. Two ticks overlapping (a slow provider on the last pass)
      // would otherwise send the same message twice, and a duplicate email is
      // not something an apology fixes.
      const claimed = await db
        .updateTable('email_drafts')
        .set({ send_after: null })
        .where('id', '=', row.id)
        .where('send_after', 'is not', null)
        .returning('id')
        .executeTakeFirst();
      if (!claimed) return false;

      try {
        await sendOne(db, row as Parameters<typeof sendOne>[1]);
        // Through deleteDraft, so the copy in the mailbox's Drafts folder goes
        // too (ADR 0303) - a sent message must not also sit there as a draft.
        await deleteDraft(db, row.user_id, row.id);
        return true;
      } catch (err) {
        const message = (err as Error).message;
        // Back to being a draft, with the reason attached. The alternative is a
        // retry loop that mails the same thing five times the moment a transient
        // error clears (ADR 0103's re-push bug, in a place with no undo).
        logger.error('outbox send failed', { userId: row.user_id, draft: row.id, err: message });
        await db
          .updateTable('email_drafts')
          .set({ last_error: message.slice(0, 500) })
          .where('id', '=', row.id)
          .execute();
        return false;
      }
    }),
  );

  let sent = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      if (r.value) sent += 1;
    } else {
      // The claim query itself failed, not the send (that's caught above and
      // never rejects here) — worth its own log line rather than disappearing.
      logger.error('outbox: claim failed', { err: (r.reason as Error)?.message });
    }
  }
  return sent;
}

export interface OutboxHandle {
  stop: () => void;
}

export function startOutboxScheduler(db: Kysely<DB>): OutboxHandle {
  // Off only when NOTHING can be held: chat sends queue on their own window
  // (ADR 0214), so an app window of 0 must not strand them.
  if (env.EMAIL_UNDO_SECONDS <= 0 && env.EMAIL_CHAT_UNDO_SECONDS <= 0) {
    logger.info('outbox scheduler off (EMAIL_UNDO_SECONDS=0, EMAIL_CHAT_UNDO_SECONDS=0)');
    return { stop: () => {} };
  }
  logger.info(
    `outbox scheduler tick=${env.EMAIL_OUTBOX_TICK_MS}ms undo_window=${env.EMAIL_UNDO_SECONDS}s chat_window=${env.EMAIL_CHAT_UNDO_SECONDS}s`,
  );
  let inFlight = false;
  const interval = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await flushDueSends(db);
    } catch (err) {
      logger.error('outbox flush failed', { err });
    } finally {
      inFlight = false;
    }
  }, env.EMAIL_OUTBOX_TICK_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}
