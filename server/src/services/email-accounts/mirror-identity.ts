/**
 * One message, one mirror row (docs/notes/0199 addendum).
 *
 * Outlook and IMAP give a message a new provider id when it changes folder
 * (Graph re-issues the id, IMAP assigns a new UID), and a reply Chord sends is
 * stored under a placeholder until the Sent folder sync mirrors the real copy.
 * Keyed on the provider id alone, each of those arrived as a second row. Before
 * an attached-mailbox message is upserted, this finds the row it already has
 * and re-keys that row, so the upsert updates it instead of inserting a twin.
 *
 * A predecessor must be the same KIND of copy (sent vs. received): a message
 * sent to yourself is one RFC 822 message with two real provider copies, one in
 * each folder, and both belong in the mirror.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { instantMs } from '../../db/text-instant.js';
import type { NormalizedMessage } from '../google/gmail-sync.js';

/** A Chord-sent placeholder and the real Sent copy are minutes apart at most. */
const PLACEHOLDER_WINDOW_MS = 15 * 60_000;

export interface ClaimedRow {
  /** Row id that now carries `nm`'s key, when an existing row was re-keyed. */
  adoptedRowId: string | null;
  /** Thread the row left, when it moved; the caller recomputes it. */
  leftThread: string | null;
}

const isSent = (labels: unknown): boolean => Array.isArray(labels) && labels.includes('SENT');

export async function claimMirrorRow(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  threadRowId: string,
  nm: NormalizedMessage,
): Promise<ClaimedRow> {
  const exact = await db
    .selectFrom('email_messages')
    .select(['id', 'thread_id', 'gmail_thread_id'])
    .where('user_id', '=', userId)
    .where('gmail_message_id', '=', nm.gmailMessageId)
    .executeTakeFirst();
  if (exact) {
    // The upsert keeps a row's thread, so a row written into the wrong thread
    // (the old IMAP key collision) is moved where this message belongs.
    if (exact.thread_id === threadRowId) return { adoptedRowId: null, leftThread: null };
    await db
      .updateTable('email_messages')
      .set({ thread_id: threadRowId, gmail_thread_id: nm.gmailThreadId })
      .where('id', '=', exact.id)
      .execute();
    return { adoptedRowId: null, leftThread: exact.gmail_thread_id };
  }

  const predecessor = await findPredecessor(db, userId, accountId, threadRowId, nm);
  if (!predecessor) return { adoptedRowId: null, leftThread: null };
  await db
    .updateTable('email_messages')
    .set({
      gmail_message_id: nm.gmailMessageId,
      thread_id: threadRowId,
      gmail_thread_id: nm.gmailThreadId,
    })
    .where('id', '=', predecessor.id)
    .execute();
  return {
    adoptedRowId: predecessor.id,
    leftThread: predecessor.gmail_thread_id !== nm.gmailThreadId ? predecessor.gmail_thread_id : null,
  };
}

async function findPredecessor(
  db: Kysely<DB>,
  userId: string,
  accountId: string,
  threadRowId: string,
  nm: NormalizedMessage,
): Promise<{ id: string; gmail_thread_id: string } | null> {
  const sent = isSent(nm.labelIds);
  if (nm.rfc822MessageId) {
    const same = await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_thread_id', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .where('account_id', '=', accountId)
      .where('rfc822_message_id', '=', nm.rfc822MessageId)
      .orderBy('created_at', 'desc')
      .execute();
    const hit = same.find((r) => isSent(r.gmail_label_ids) === sent);
    if (hit) return hit;
  }
  if (!sent) return null;

  // A Graph `reply` answers 202 with no id and no Message-ID, so Outlook's
  // placeholder can only be matched by thread and time. The nearest one wins,
  // so two replies sent a minute apart each find their own.
  const placeholders = await db
    .selectFrom('email_messages')
    .select(['id', 'gmail_thread_id', 'internal_date'])
    .where('user_id', '=', userId)
    .where('thread_id', '=', threadRowId)
    .where('gmail_message_id', 'like', `${accountId}:sent-%`)
    .where('rfc822_message_id', 'is', null)
    .execute();
  const at = instantMs(nm.internalDate);
  let best: { id: string; gmail_thread_id: string } | null = null;
  let bestGap = Infinity;
  for (const p of placeholders) {
    const gap = Math.abs(instantMs(p.internal_date) - at);
    if (gap <= PLACEHOLDER_WINDOW_MS && gap < bestGap) {
      best = p;
      bestGap = gap;
    }
  }
  return best;
}
