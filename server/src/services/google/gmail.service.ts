/**
 * Gmail reader service (ADR 0060). Mirrors calendar.service.ts: a bounded paged
 * backfill, History-API incremental sync, lazy body fetch on thread open, reply,
 * and label/read/archive write-back. All Gmail I/O goes through the `gmail-api.ts`
 * seam (real fetch or mock fixtures); pure diff/aggregation/MIME logic lives in
 * `gmail-sync.ts`. Sync is opportunistic and never throws into `maybeSyncGmail`.
 */
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type {
  EmailAction,
  EmailAttachmentRef,
  EmailFolder,
  EmailMessage,
  EmailModifyRequest,
  EmailSyncResult,
  EmailThreadDetail,
  EmailThreadFile,
  EmailThreadSummary,
} from '@chord/kernel';
import { SSE, hasInlineImageRefs, replyAddressOf } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB, EmailMessagesTable, EmailThreadsTable } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { forEachConcurrent, mapConcurrent } from '../../utils/concurrency.js';
import { newId } from '../../utils/ids.js';
import { fillAttachmentFlags } from '../email/attachment-flags.js';
import { keepAttachmentIds } from '../email/attachment-ids.js';
import { importEmailAttachments } from '../email/attachment-import.js';
import { backfillBodyExcerpts } from '../email/body-backfill.js';
import { isBulkThread } from '../email/bulk.js';
import { sealMessageContent, sealThreadContent } from '../email/content-seal.js';
import { annotateSenderChecks, forgetSentFacts } from '../email/sender-check/annotate.js';
import { cachedGmailLabels, forgetGmailLabels } from '../email/gmail-label-cache.js';
import { chordGmailLabel, mailboxKeyOf, noteFolderRemoved } from '../email/mailbox-folder-memory.js';
import { startImagePreload } from '../email/image-preload.js';
import { notifyNewMail } from '../email/new-mail-notify.js';
import { clearReadWrite, pendingUnread, queueReadWrite } from '../email/read-pending.js';
import { runVacationReplies } from '../email/vacation.service.js';
import { offerUnsubscribes } from '../email/unsubscribe-offers.js';
import { applyAutoTrash } from '../email/auto-trash.service.js';
import { applyFilingRules } from '../email/filing.service.js';
import {
  backoffRemainingMs,
  gmailKey,
  isRateLimitError,
  recordSyncFailure,
  recordSyncPause,
  recordSyncSuccess,
} from '../email/sync-backoff.js';
import { folderPredicate, labelPredicate, searchablePredicate } from '../email/folders.js';
import {
  applyChordLabelPatch,
  chordLabelPatchRequested,
} from '../email/chord-labels.js';
import { preprocessReadTimeMagics, runEmailMagics, runOwnReplyScheduling } from '../email/magics.service.js';
import { runPersonExtraction } from '../email/person-extraction.js';
import { runEmbedPass } from '../search/embed-pass.js';
import { runLlmClassifier } from '../email/llm-classifier.js';
import { runMockClassifier } from '../email/mock-classifier.js';
import { getEntitlement } from '../billing.service.js';
import { hasAiConsent } from '../ai-consent.service.js';
import { retractByProvenance } from '../proposals.service.js';
import { retireTasksByProvenance } from '../tasks.service.js';
import { closeAnsweredReplyTodos, newestIsSent, toReplyThreadMessage } from '../email/reply-todos.js';
import { sseHub } from '../sse.hub.js';
import { runInBackground } from '../../utils/background.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { getGmailApi, type GmailApi } from './gmail-api.js';
import { GoogleAuthError } from './oauth.service.js';
import {
  aggregateThread,
  applyLabelDelta,
  buildReplyRaw,
  diffHistory,
  extractBodies,
  listAttachmentParts,
  toAttachmentRef,
  normalizeMessage,
  replySubject,
  withoutBody,
  type NormalizedMessage,
  type ThreadMessageView,
} from './gmail-sync.js';
import { withQuotedOriginal } from '../email/reply-quote.js';
import { composedBodies, mailboxSignatureRow, type ComposedBody } from '../email/signature.js';

const SYNC_THROTTLE_MS = () => env.GMAIL_SYNC_THROTTLE_MINUTES * 60 * 1000;

export function emitEmailSynced(userId: string, result: EmailSyncResult): void {
  sseHub.broadcastToUser(userId, SSE.emailSynced, result);
}

export function emitEmailThreadUpdated(userId: string, summary: EmailThreadSummary): void {
  sseHub.broadcastToUser(userId, SSE.emailThreadUpdated, {
    userId,
    threadId: summary.id,
    isUnread: summary.isUnread,
    isArchived: summary.isArchived,
    labelIds: summary.labelIds,
  });
}

/** Does the user's stored token cover gmail.modify? Mock provider needs none. */
export async function hasGmailScope(db: Kysely<DB>, userId: string): Promise<boolean> {
  if (env.GMAIL_PROVIDER === 'mock') return true;
  const row = await db
    .selectFrom('users')
    .select('refresh_token_scopes')
    .where('id', '=', userId)
    .executeTakeFirst();
  return scopesCoverGmail(row?.refresh_token_scopes);
}

/** `hasGmailScope` for a caller that already read `users.refresh_token_scopes`. */
export function scopesCoverGmail(scopes: string | null | undefined): boolean {
  if (env.GMAIL_PROVIDER === 'mock') return true;
  return /https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/.test(scopes ?? '');
}

// ── row mappers ───────────────────────────────────────────────────────
export function threadRowToSummary(r: {
  id: string;
  subject: string;
  snippet: string;
  from_name: string | null;
  from_email: string | null;
  last_message_at: string;
  message_count: number;
  is_unread: number;
  is_archived: number;
  gmail_label_ids: string[];
  chord_label_ids?: string[];
  category_id: string | null;
  action?: EmailAction | null;
  account_id?: string | null;
  account_email?: string | null;
  has_attachments?: boolean | null;
}): EmailThreadSummary {
  return {
    id: r.id,
    subject: r.subject,
    snippet: r.snippet,
    fromName: r.from_name,
    fromEmail: r.from_email,
    lastMessageAt: r.last_message_at,
    messageCount: r.message_count,
    isUnread: r.is_unread === 1,
    isArchived: r.is_archived === 1,
    labelIds: r.gmail_label_ids,
    chordLabelIds: Array.isArray(r.chord_label_ids) ? r.chord_label_ids : [],
    categoryId: r.category_id,
    action: r.action ?? null,
    accountId: r.account_id ?? null,
    accountEmail: r.account_email ?? null,
    ...(r.has_attachments !== undefined ? { hasAttachments: r.has_attachments === true } : {}),
  };
}

export function messageRowToDto(r: {
  id: string;
  gmail_message_id: string;
  from_name: string | null;
  from_email: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  internal_date: string;
  is_unread: number;
  gmail_label_ids?: string[] | null;
  attachments_json?: { id: string; filename: string; mimeType: string; size: number }[] | null;
  reply_to?: string | null;
}): EmailMessage {
  return {
    id: r.id,
    gmailMessageId: r.gmail_message_id,
    fromName: r.from_name,
    fromEmail: r.from_email,
    toEmails: r.to_emails,
    ccEmails: r.cc_emails,
    subject: r.subject,
    snippet: r.snippet,
    bodyText: r.body_text,
    bodyHtml: r.body_html,
    internalDate: r.internal_date,
    isUnread: r.is_unread === 1,
    sent: Array.isArray(r.gmail_label_ids) && r.gmail_label_ids.includes('SENT'),
    attachments: Array.isArray(r.attachments_json) ? r.attachments_json : [],
    replyTo: r.reply_to ?? null,
  };
}

/**
 * The message a reply answers: the one the sender picked, else the newest that
 * is not the mailbox's own. It decides the threading headers (and, on Outlook,
 * the text that gets quoted), so it must be the message the recipients were
 * read from rather than whatever happens to be newest.
 */
export async function replyAnchor(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  opts: { messageId?: string; ownAddress?: string | null },
) {
  if (opts.messageId) {
    const picked = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('id', '=', opts.messageId)
      .where('thread_id', '=', threadRowId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (picked) return picked;
  }
  const newest = await db
    .selectFrom('email_messages')
    .selectAll()
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', userId)
    .orderBy('internal_date', 'desc')
    .limit(20)
    .execute();
  const own = opts.ownAddress?.toLowerCase() ?? null;
  return newest.find(
    (m) =>
      !(Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('SENT')) &&
      !(own !== null && m.from_email?.toLowerCase() === own),
  );
}

// ── write helpers (shared with the ADR 0080 account providers) ────────
export async function ensureThreadRow(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  now: string,
  accountId: string | null = null,
): Promise<string> {
  const existing = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirst();
  if (existing) return existing.id;
  await db
    .insertInto('email_threads')
    .values({
      id: newId('emt'),
      user_id: userId,
      account_id: accountId,
      gmail_thread_id: gmailThreadId,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(['user_id', 'gmail_thread_id']).doNothing())
    .execute();
  const row = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Upsert a message's metadata WITHOUT clobbering a previously-fetched body. */
export async function upsertMessageMeta(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  nm: NormalizedMessage,
  now: string,
  accountId: string | null = null,
): Promise<void> {
  // A re-fetch of a message already stored keeps the attachment ids it had:
  // Gmail issues new ones on every read, and a reader holding the old ones
  // would get 404s (keepAttachmentIds).
  if (nm.attachmentsJson && nm.attachmentsJson !== '[]') {
    const existing = await db
      .selectFrom('email_messages')
      .select('attachments_json')
      .where('user_id', '=', userId)
      .where('gmail_message_id', '=', nm.gmailMessageId)
      .executeTakeFirst();
    if (Array.isArray(existing?.attachments_json) && existing.attachments_json.length > 0) {
      nm = {
        ...nm,
        attachmentsJson: JSON.stringify(
          keepAttachmentIds(existing.attachments_json, JSON.parse(nm.attachmentsJson) as EmailAttachmentRef[]),
        ),
      };
    }
  }
  // ADR 0201 — sealed when encryption is on, and always blind-indexed. Every
  // provider's message passes through here, so this is the one place mail
  // content is written.
  const ins = await sealMessageContent(
    userId,
    {
      subject: nm.subject,
      snippet: nm.snippet,
      from_name: nm.fromName,
      from_email: nm.fromEmail,
      body_text: nm.bodyText,
      body_html: nm.bodyHtml,
      body_excerpt: nm.bodyExcerpt ?? null,
      ics_text: nm.icsText ?? null,
      attachments_json: nm.attachmentsJson ?? null,
    },
    { index: 'always' },
  );
  const upd = await sealMessageContent(
    userId,
    {
      from_name: nm.fromName,
      from_email: nm.fromEmail,
      subject: nm.subject,
      snippet: nm.snippet,
      ...(nm.bodyExcerpt !== undefined ? { body_excerpt: nm.bodyExcerpt } : {}),
      ...(nm.attachmentsJson !== undefined ? { attachments_json: nm.attachmentsJson } : {}),
      ...(nm.icsText !== undefined ? { ics_text: nm.icsText } : {}),
    },
    { index: nm.bodyExcerpt !== undefined ? 'excerpt-until-full' : 'none' },
  );
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      account_id: accountId,
      thread_id: threadRowId,
      gmail_message_id: nm.gmailMessageId,
      gmail_thread_id: nm.gmailThreadId,
      to_emails: JSON.stringify(nm.toEmails),
      cc_emails: JSON.stringify(nm.ccEmails),
      internal_date: nm.internalDate,
      is_unread: nm.isUnread ? 1 : 0,
      gmail_label_ids: JSON.stringify(nm.labelIds),
      rfc822_message_id: nm.rfc822MessageId,
      headers_json: JSON.stringify(nm.headers),
      list_unsubscribe: nm.listUnsubscribe ?? null,
      list_unsubscribe_post: nm.listUnsubscribePost ?? null,
      list_id: nm.listId ?? null,
      reply_to: nm.replyTo ?? null,
      auth_results: nm.authResults ? JSON.stringify(nm.authResults) : null,
      auto_reply: nm.autoReply ? 1 : 0,
      ...ins,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'gmail_message_id']).doUpdateSet({
        ...upd,
        to_emails: JSON.stringify(nm.toEmails),
        cc_emails: JSON.stringify(nm.ccEmails),
        internal_date: nm.internalDate,
        is_unread: nm.isUnread ? 1 : 0,
        gmail_label_ids: JSON.stringify(nm.labelIds),
        rfc822_message_id: nm.rfc822MessageId,
        headers_json: JSON.stringify(nm.headers),
        // undefined means the provider did not carry headers on this
        // fetch (Graph's delta does not), which is not the same as the
        // sender having no unsubscribe. Only an observed value writes.
        ...(nm.listUnsubscribe !== undefined ? { list_unsubscribe: nm.listUnsubscribe } : {}),
        ...(nm.listUnsubscribePost !== undefined
          ? { list_unsubscribe_post: nm.listUnsubscribePost }
          : {}),
        list_id: nm.listId ?? null,
        // ADR 0294 — same rule: a fetch without the headers says nothing.
        ...(nm.replyTo !== undefined ? { reply_to: nm.replyTo } : {}),
        ...(nm.authResults !== undefined
          ? { auth_results: nm.authResults ? JSON.stringify(nm.authResults) : null }
          : {}),
        // ADR 0314 — set, never cleared: Chord marks its own vacation reply
        // when it sends one, and the provider's copy may lack the header.
        ...(nm.autoReply ? { auto_reply: 1 } : {}),
        // body_text / body_html deliberately preserved. Attachment metadata
        // updates only when the provider actually supplied it (IMAP does at
        // sync); an undefined must never wipe lazily-discovered parts. Both
        // rules are carried by `upd` above, which only holds what was supplied.
      }),
    )
    .execute();
  // Who the user writes to just changed; the sender check's memory of it is stale.
  if (nm.labelIds.includes('SENT')) forgetSentFacts(db, userId);
}

/**
 * The source mail is gone, so what it produced goes with it (ADR 0143).
 *
 * ADR 0073 retracted the thread's *pending* proposals and deliberately left
 * anything an earlier confirm had created — history, on the reasoning that an
 * entity outlives its source. That holds for a saved place or a calendar
 * event; it does not hold for a to-do, which is not a record of something but
 * an outstanding obligation. Deleting the email is how someone says the
 * obligation is over.
 */
async function retireFromDeletedThread(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
  opts: { spam?: boolean } = {},
): Promise<void> {
  const key = `gmail:${gmailThreadId}`;
  // Said out loud, like the retired to-dos below: a suggestion cancelled
  // without telling anyone stays on every open screen until its next refetch,
  // which reads as the delete not having worked.
  const retracted = await retractByProvenance(db, userId, [key]);
  for (const p of retracted) {
    sseHub.broadcast(p.groupId, SSE.proposalResolved, { id: p.id, status: 'expired' });
  }
  if (retracted.length > 0) sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
  for (const task of await retireTasksByProvenance(db, userId, [key], { spam: opts.spam })) {
    sseHub.broadcast(task.groupId, SSE.taskUpdated, task);
  }
}

/**
 * Re-derive a thread's display + state from its stored messages. Deletes the
 * thread row when it has no messages left (all removed on Gmail's side).
 * A gone or trashed thread also retracts its pending magic proposals — the
 * email→proposal flow dies with the email; decided proposals are untouched.
 */
export async function recomputeThread(
  db: Kysely<DB>,
  userId: string,
  gmailThreadId: string,
): Promise<void> {
  const rows = await db
    .selectFrom('email_messages')
    .select([
      'id', 'gmail_message_id', 'internal_date', 'subject', 'snippet', 'from_name', 'from_email',
      'gmail_label_ids', 'is_unread', 'list_unsubscribe', 'list_id', 'auto_reply',
      'reply_to', 'to_emails', 'cc_emails',
    ])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .execute();
  if (rows.length === 0) {
    await db
      .deleteFrom('email_threads')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .execute();
    await retireFromDeletedThread(db, userId, gmailThreadId);
    return;
  }
  // docs/notes/0199 — a read/unread the provider has not accepted yet still
  // wins over what the sync just read back, or the retry would be pointless:
  // the thread would already have flipped back on screen.
  const owed = await pendingUnread(db, userId, gmailThreadId);
  if (owed !== null) {
    const changed: { id: string; labels: string[] }[] = [];
    for (const r of rows) {
      const current = Array.isArray(r.gmail_label_ids) ? r.gmail_label_ids : [];
      if ((r.is_unread === 1) === owed && current.includes('UNREAD') === owed) continue;
      const labels = applyLabelDelta(current, owed ? ['UNREAD'] : [], owed ? [] : ['UNREAD']);
      r.gmail_label_ids = labels;
      r.is_unread = owed ? 1 : 0;
      changed.push({ id: r.id, labels });
    }
    await writeMessageLabels(db, userId, changed);
  }
  const views: ThreadMessageView[] = rows.map((r) => ({
    internalDate: r.internal_date,
    subject: r.subject,
    snippet: r.snippet,
    fromName: r.from_name,
    fromEmail: r.from_email,
    labelIds: r.gmail_label_ids,
    isUnread: r.is_unread === 1,
  }));
  const agg = aggregateThread(views);
  // ADR 0109 — derived here rather than at write time so it survives the
  // classifier's snapshot-replace and costs no LLM call.
  const bulk = isBulkThread(
    rows.map((r) => ({
      listUnsubscribe: r.list_unsubscribe,
      listId: r.list_id,
      labelIds: r.gmail_label_ids,
    })),
  );
  // ADR 0201 — the thread's display fields are sealed and blind-indexed. A
  // recompute that changes none of them (a mark-read, a label change) leaves
  // the sealed columns and the index alone: re-sealing would write fresh
  // ciphertext for nothing, and every write is WAL.
  const current = await db
    .selectFrom('email_threads')
    .select([
      'subject', 'snippet', 'from_name', 'from_email', 'last_message_at', 'message_count',
      sql<boolean>`blind_words is not null`.as('indexed'),
    ])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirst();
  const contentUnchanged =
    current !== undefined &&
    current.indexed &&
    current.subject === agg.subject &&
    current.snippet === agg.snippet &&
    (current.from_name ?? null) === (agg.fromName ?? null) &&
    (current.from_email ?? null) === (agg.fromEmail ?? null);
  // `updated_at` is what puts a thread back in the classifier's queue, so it
  // moves only when what the classifier reads changed: a new message or new
  // display text. A mark-read, archive or label change is not new content,
  // and bumping it on those re-sorted the thread with the model each time.
  const messagesUnchanged =
    current !== undefined &&
    current.last_message_at === agg.lastMessageAt &&
    current.message_count === agg.messageCount;
  const content = contentUnchanged
    ? {}
    : await sealThreadContent(userId, {
        subject: agg.subject,
        snippet: agg.snippet,
        from_name: agg.fromName,
        from_email: agg.fromEmail,
      });
  await db
    .updateTable('email_threads')
    .set({
      ...content,
      last_message_at: agg.lastMessageAt,
      message_count: agg.messageCount,
      is_unread: agg.isUnread ? 1 : 0,
      is_archived: agg.isArchived ? 1 : 0,
      gmail_label_ids: JSON.stringify(agg.labelIds),
      bulk: bulk ? 1 : 0,
      ...(contentUnchanged && messagesUnchanged ? {} : { updated_at: new Date().toISOString() }),
      // ADR 0129 - a new message wakes a snoozed thread. Keyed on the message
      // being NEWER than the snooze rather than on this function running at all:
      // it also runs for an ordinary mark-read, which is not new mail. Folded
      // into this update as a CASE (it was a second UPDATE, run for every
      // thread and matching almost none), so the wake still happens exactly
      // when the old WHERE clause held.
      snoozed_until: sql<string | null>`case when snoozed_until is not null and snoozed_at < ${agg.lastMessageAt} then null else snoozed_until end`,
      snoozed_at: sql<string | null>`case when snoozed_until is not null and snoozed_at < ${agg.lastMessageAt} then null else snoozed_at end`,
    })
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .execute();
  // Trash is a delete in the user's eyes; Gmail purges it for real later.
  // Whole-thread only — one trashed reply in a live thread retracts nothing.
  // Spam is the provider saying the mail was never real: its suggestions go,
  // and so do its to-dos whatever their date.
  const spam = views.some((v) => v.labelIds.includes('SPAM'));
  if (views.every((v) => v.labelIds.includes('TRASH') || v.labelIds.includes('SPAM'))) {
    await retireFromDeletedThread(db, userId, gmailThreadId, { spam });
    return;
  }
  // ADR 0314 — the user's reply finishes the "reply to …" to-do, and the
  // thread stops reading as waiting on them.
  const replyView = rows.map(toReplyThreadMessage);
  await closeAnsweredReplyTodos(db, userId, gmailThreadId, replyView);
  if (newestIsSent(replyView)) {
    await db
      .updateTable('email_threads')
      .set({ action: 'other' })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .where('action', '=', 'reply_needed')
      .execute();
  }
}

/** A row this young may still be between its thread insert and its message
 *  insert; older than this with no message, the message is never coming. */
const EMPTY_THREAD_GRACE_MS = 5 * 60_000;

/** Threads reaped or repaired per call; a stranded backfill can leave hundreds. */
const UNFILLED_REPAIR_BATCH = 200;

/**
 * Remove thread rows that hold no message.
 *
 * Every sync path writes the thread row first and the message second
 * (`ensureThreadRow`, then `upsertMessageMeta`), as two statements. When the
 * second one throws, the first stays: a row with no subject, no sender and no
 * body, dated "now", which every list then shows as unarchived mail and which
 * opens to an empty screen. `recomputeThread` would remove it, but a sync that
 * threw never reaches its recompute. Run on every sync, so one failed write
 * costs one tick of a blank row rather than a permanent one.
 */
export async function reapEmptyThreads(db: Kysely<DB>, userId: string): Promise<number> {
  const before = new Date(Date.now() - EMPTY_THREAD_GRACE_MS).toISOString();
  const empty = await db
    .selectFrom('email_threads as t')
    .select('t.gmail_thread_id')
    .where('t.user_id', '=', userId)
    .where('t.created_at', '<', before)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('email_messages as m')
            .select('m.id')
            .whereRef('m.thread_id', '=', 't.id'),
        ),
      ),
    )
    // Bounded like the repair below; the rest go on the next sync.
    .limit(UNFILLED_REPAIR_BATCH)
    .execute();
  // recomputeThread is what deletes a message-less thread, and it also retires
  // anything suggested from it.
  for (const t of empty) await recomputeThread(db, userId, t.gmail_thread_id);
  if (empty.length > 0) {
    logger.info(`email reaped empty threads user=${userId} n=${empty.length}`);
    sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
  }
  return empty.length;
}

/**
 * Fill in thread rows that hold messages but were never recomputed.
 *
 * A thread row is written empty (`ensureThreadRow`: no subject, no sender, no
 * search index, `last_message_at` = the moment of the write) and filled from
 * its messages only by `recomputeThread`, which every sync runs once at the
 * END of its pass. A pass that stops after writing messages and before that
 * step (the process restarting mid-backfill, a throw later in the pass) leaves
 * the row empty for good: the next pass skips messages already mirrored, so it
 * never touches that thread again. The row then has no subject, cannot be
 * found by search, and sorts as the newest mail because its date is the sync's.
 *
 * `last_message_at = created_at` is the mark: a recompute sets it from the
 * newest message's own date, which matches the row's creation instant only if
 * it was never run.
 */
export async function repairUnfilledThreads(db: Kysely<DB>, userId: string): Promise<number> {
  const before = new Date(Date.now() - EMPTY_THREAD_GRACE_MS).toISOString();
  const unfilled = await db
    .selectFrom('email_threads as t')
    .select('t.gmail_thread_id')
    .where('t.user_id', '=', userId)
    .where('t.created_at', '<', before)
    .whereRef('t.last_message_at', '=', 't.created_at')
    .where(({ exists, selectFrom }) =>
      exists(selectFrom('email_messages as m').select('m.id').whereRef('m.thread_id', '=', 't.id')),
    )
    .limit(UNFILLED_REPAIR_BATCH)
    .execute();
  for (const t of unfilled) await recomputeThread(db, userId, t.gmail_thread_id);
  if (unfilled.length > 0) {
    logger.info(`email repaired unfilled threads user=${userId} n=${unfilled.length}`);
    sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
  }
  return unfilled.length;
}

/**
 * In-flight `afterSync` per user, plus whether another caller arrived while it
 * ran. The entry is deleted when the run settles, so this cannot grow.
 */
const afterSyncRuns = new Map<string, { run: Promise<void>; again: boolean; depth: MailSyncDepth }>();

/** Open sync rounds per user, and whether any mailbox in one had work. */
/**
 * How much of the post-sync pipeline a round is entitled to run (ADR 0144).
 *
 * `mirror` keeps the mailbox copy honest — body excerpts, the new-mail
 * notification, the vacation responder — and stops at the ADR 0079 gate.
 * `full` continues into the paid AI layer: classification, attachment import,
 * magics, person extraction.
 *
 * The split is not new: `runAfterSyncPasses` was already written in these two
 * tiers, because ADR 0079 had to decide which passes an unentitled user still
 * gets. A background sweep wants exactly the same line drawn for a different
 * reason, so it reuses that boundary rather than inventing a second one.
 */
export type MailSyncDepth = 'mirror' | 'full';

const mailSyncRounds = new Map<string, { dirty: boolean; depth: MailSyncDepth }>();

/**
 * Run `fn` as ONE sync round for this user: every `afterSync` inside it is
 * collapsed into a single pass at the end.
 *
 * The passes are USER-scoped — "everything of this user's that is unclassified
 * or unmined" — but the call is MAILBOX-scoped: each provider's sync ends with
 * `afterSync(db, account.user_id)`. The bulk paths iterate mailboxes with
 * `for … await`, so a user with three mailboxes ran the whole pipeline three
 * times per tick, one after another, for one round's worth of new mail — N×
 * the LLM spend, and N chances for two extractions of one thread to come back
 * differently worded.
 *
 * Scoping the round rather than moving the call is deliberate. The alternative
 * — strip `afterSync` from the providers and add it at each of the ~10 entry
 * points — is ten chances to forget, forever. Here the providers are untouched,
 * and an entry point that forgets to open a round degrades to today's
 * behaviour rather than to silence, which is the safe direction to fail.
 *
 * Nested rounds join the outer one: the outermost owns the flush. A round that
 * throws still flushes — the mail arrived either way.
 */
export async function withMailSyncRound<T>(
  db: Kysely<DB>,
  userId: string,
  fn: () => Promise<T>,
  depth: MailSyncDepth = 'full',
): Promise<T> {
  const open = mailSyncRounds.get(userId);
  if (open) {
    // A nested round may DEEPEN the outer one but never shallow it: the
    // background sweep must not downgrade a user-triggered sync that is
    // already running, while a real request arriving inside a sweep is
    // entitled to the passes it came for.
    if (depth === 'full') open.depth = 'full';
    return fn();
  }
  const round = { dirty: false, depth };
  mailSyncRounds.set(userId, round);
  try {
    return await fn();
  } finally {
    mailSyncRounds.delete(userId);
    if (round.dirty) await afterSync(db, userId, round.depth);
  }
}

/**
 * A sync the USER asked for (opening the Email tab, pulling to refresh): the
 * mirror now, the AI layer after.
 *
 * The request used to return only once classification, magics and person
 * extraction had run over what it fetched, so its latency was the sum of every
 * LLM call: 3.9 s mean with a half-second mock model in the load test, and
 * several seconds each with a real one. What the person is waiting for is their
 * mail. Everything at `mirror` depth (body excerpts, the new-mail notification,
 * the vacation responder) still runs before the response, exactly as before;
 * the AI passes start when it has been sent, and `email.synced` tells the
 * client to refetch once they finish, so tiles, badges and suggestions fill in
 * rather than the whole screen waiting on them. The background sweep already
 * runs the same passes on its own clock, so nothing is added to the schedule.
 *
 * `fn` must pass `'mirror'` to any round it opens itself (`syncAllAccounts`
 * takes a depth for this), or that inner round deepens this one back to `full`.
 *
 * A sync that changed nothing starts no AI passes: the Email tab syncs on
 * every visit, and the pipeline over an unchanged mailbox only re-read the
 * same tables. Backlog the passes still owe is drained by the sweep.
 */
export async function withMirrorSyncThenAi<T extends EmailSyncResult>(
  db: Kysely<DB>,
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const result = await withMailSyncRound(db, userId, fn, 'mirror');
  if (result.inserted + result.updated + result.deleted > 0) runAiPassesInBackground(db, userId);
  return result;
}

/** Test seam: resolves once every in-flight post-sync pass (any user) has drained. */
export async function __settleAfterSyncForTests(): Promise<void> {
  while (afterSyncRuns.size > 0 || backgroundAiChains.size > 0) {
    await Promise.all([...afterSyncRuns.values()].map((e) => e.run));
    await Promise.all([...backgroundAiChains]);
  }
}

/** `runAiPassesInBackground` chains still running, so the test seam can wait for them. */
const backgroundAiChains = new Set<Promise<unknown>>();

/** Run the AI layer without holding a request open, then tell the client to look again. */
export function runAiPassesInBackground(db: Kysely<DB>, userId: string): void {
  const chain = afterSync(db, userId, 'full')
    .then(() =>
      // Nothing new was fetched; the event is only the prompt to refetch what
      // the passes changed (categories, actions, staged suggestions).
      emitEmailSynced(userId, { inserted: 0, updated: 0, deleted: 0, backfillDone: true }),
    )
    .catch((err) => logger.warn('background email AI passes failed', { userId, err: (err as Error).message }))
    // Warms the newest page's worth of threads for the ADR 0180 read-time
    // pass (see `preprocessReadTimeMagics`). AFTER the sweep, not beside it
    // (ADR 0244): run in parallel it read mail the classifier had not
    // reached yet and staged its own card seconds before the sweep staged
    // the same email as something else. Its in-memory guard keeps it safe
    // alongside the per-open top-up call.
    .then(() => preprocessReadTimeMagics(db, userId))
    .catch((err) =>
      logger.warn('read-time preprocess after sync failed', { userId, err: (err as Error).message }),
    )
    .finally(() => backgroundAiChains.delete(chain));
  backgroundAiChains.add(chain);
}

/**
 * Post-sync pipeline, coalesced per user.
 *
 * Two separate collapses, for two separate ways this got called too often.
 *
 * A round (`withMailSyncRound`) folds the SEQUENTIAL case: one call per mailbox
 * as the bulk loop walks them. Those never overlap, so nothing below would
 * catch them.
 *
 * The coalescer below folds the CONCURRENT case: two rounds overlapping — a
 * route-triggered sync racing the scheduler tick. That is what put two
 * `ingestClassification` snapshot-replaces in flight at once and produced the
 * `email_categories_pkey` violations and `deadlock detected` that left three
 * prod mailboxes unclassified for days.
 *
 * A caller arriving mid-run joins that run rather than starting a second, and
 * a trailing pass is queued for it: rows its own sync landed may have arrived
 * after the in-flight pass had already read the table, and dropping them until
 * the next tick is how mail silently goes unmined. Every caller who arrives
 * during a pass shares the one that follows it.
 */
export async function afterSync(
  db: Kysely<DB>,
  userId: string,
  depth: MailSyncDepth = 'full',
): Promise<void> {
  // Inside a round: record that there was work and let the round flush once.
  const round = mailSyncRounds.get(userId);
  if (round) {
    round.dirty = true;
    return;
  }
  const inFlight = afterSyncRuns.get(userId);
  if (inFlight) {
    inFlight.again = true;
    // A caller that wants the AI layer must get it even when the run it joins
    // was opened for the mirror only: the trailing pass reads this, not the
    // depth the run started with.
    if (depth === 'full') {
      inFlight.depth = 'full';
      return inFlight.run;
    }
    // A caller that asked only for the mirror does not wait on a run that is
    // in the AI layer: nothing it needs is in that run's results, and the
    // trailing pass (`again`) covers the rows its own sync just landed. Joining
    // and awaiting it is how a second pull, or a pull that arrived while a
    // sweep was classifying, sat behind another user-visible wait of several
    // model calls. A run that is itself mirror-only is cheap, so that is still
    // awaited.
    if (inFlight.depth === 'full') return;
    return inFlight.run;
  }
  const entry: { run: Promise<void>; again: boolean; depth: MailSyncDepth } = {
    run: Promise.resolve(),
    again: false,
    depth,
  };
  entry.run = (async () => {
    try {
      do {
        entry.again = false;
        await runAfterSyncPasses(db, userId, entry.depth);
        // Loop rather than run once more: a caller arriving during the
        // trailing pass has the same claim as one who arrived during the
        // first. Each turn requires a distinct caller to have asked, and the
        // passes no-op when nothing is unmined, so this drains rather than
        // spins.
      } while (entry.again);
    } finally {
      afterSyncRuns.delete(userId);
    }
  })();
  afterSyncRuns.set(userId, entry);
  return entry.run;
}

/**
 * (dev) classify tiles, optionally sync category→Gmail labels when the user
 * opted in, then run the LLM magics pass (gated) to stage calendar/list
 * proposals from new mail. Best-effort — a failure here never breaks a sync.
 */
async function runAfterSyncPasses(
  db: Kysely<DB>,
  userId: string,
  depth: MailSyncDepth = 'full',
): Promise<void> {
  // Above the ADR 0079 gate on purpose, and moved here from below it: the
  // pass feeds the extraction passes (so it still runs before either) but its
  // text is ALSO what body search reads, and search is mirror rather than
  // intelligence. Left under the gate, an unentitled user's older mail would
  // stay unsearchable. It costs provider fetches, not LLM calls, which is the
  // line the gate actually draws.
  try {
    await reapEmptyThreads(db, userId);
  } catch (err) {
    logger.warn('empty thread reap failed', { userId, err: (err as Error).message });
  }
  try {
    await repairUnfilledThreads(db, userId);
  } catch (err) {
    logger.warn('unfilled thread repair failed', { userId, err: (err as Error).message });
  }
  try {
    await backfillBodyExcerpts(db, userId);
  } catch (err) {
    logger.warn('email body backfill pass failed', { userId, err: (err as Error).message });
  }
  try {
    await fillAttachmentFlags(db, userId);
  } catch (err) {
    logger.warn('attachment flag fill failed', { userId, err: (err as Error).message });
  }
  // Also above the gate (ADR 0225): fetching a message's images when it
  // arrives is what keeps opening it private, and it costs no LLM call. Not
  // awaited — a sync must not wait on the slowest image host in the mailbox.
  startImagePreload(db, userId);
  // Also above the gate: being told your own mail arrived is not the paid
  // layer (ADR 0117). Runs off the mirror, so every provider notifies the
  // same way without any of them being special-cased.
  try {
    await notifyNewMail(db, userId);
  } catch (err) {
    logger.warn('new-mail notify pass failed', { userId, err: (err as Error).message });
  }
  // Also above the gate (ADR 0124): the responder is a promise the user made
  // to whoever writes to them, and it must not lapse because a trial did.
  try {
    await runVacationReplies(db, userId);
  } catch (err) {
    logger.warn('vacation responder pass failed', { userId, err: (err as Error).message });
  }
  // Also above the gate: offering to leave a list the user never reads makes
  // no AI call, and fewer lists is less for every pass below to read.
  try {
    await offerUnsubscribes(db, userId);
  } catch (err) {
    logger.warn('unsubscribe offer pass failed', { userId, err: (err as Error).message });
  }
  // Also above the gate: a sender the user asked to keep out of the inbox
  // (a list Chord could not unsubscribe them from). No AI call.
  try {
    await applyAutoTrash(db, userId);
  } catch (err) {
    logger.warn('auto-trash pass failed', { userId, err: (err as Error).message });
  }
  // Also above the gate (ADR 0309): the user's own filing rules, after Trash
  // so a sender sent to Trash is not also filed. No AI call.
  try {
    await applyFilingRules(db, userId);
  } catch (err) {
    logger.warn('filing rules pass failed', { userId, err: (err as Error).message });
  }
  // ADR 0144 — a background sweep stops here. Everything above keeps the
  // mailbox copy honest and costs provider fetches, not LLM calls; everything
  // below is the AI layer, which stays on the surfaces the user actually
  // asked for (opening the mail tab, the morning briefing). Same line the
  // entitlement gate draws, for a different reason.
  if (depth === 'mirror') return;
  // ADR 0283 — no AI over the mailbox until the user agreed; the mirror above
  // already ran.
  if (!(await hasAiConsent(db, userId))) return;
  // ADR 0079 — post-trial gate: the AI passes over the mailbox stop for an
  // unentitled user. The mirror/reader itself keeps working (it's their
  // mail); classification, magics, and person extraction are the paid layer.
  if (env.BILLING_ENABLED) {
    const ent = await getEntitlement(db, userId);
    if (!ent.entitled) {
      logger.info('afterSync AI passes skipped (not entitled)', { userId });
      return;
    }
  }
  try {
    await runMockClassifier(db, userId);
  } catch (err) {
    logger.warn('mock classifier failed', { userId, err: (err as Error).message });
  }
  try {
    await runLlmClassifier(db, userId);
  } catch (err) {
    // `error`, not `warn`. This fired on every sync for two users for days
    // while their mailboxes stayed entirely unclassified, and read as a flaky
    // LLM call — the failure was a primary-key violation inside ingest, which
    // is a data-integrity fault that repeats forever until someone looks.
    logger.error('llm classifier failed', { userId, err: (err as Error).message });
  }
  try {
    await maybeSyncCategoryLabels(db, userId);
  } catch (err) {
    logger.warn('email category label sync failed', { userId, err: (err as Error).message });
  }
  // Attachment import runs BEFORE magics: the imported copies carry the
  // extracted text (with origin_email_thread_id) that the magics extractor
  // reads — a newsletter PDF's dates are only visible in that order. A
  // thread whose attachments miss the per-tick import batch simply extracts
  // from body text alone (best effort, same as before).
  if (env.EMAIL_ATTACHMENTS_ENABLED) {
    try {
      await importEmailAttachments(db, userId);
    } catch (err) {
      logger.warn('email attachment import pass failed', { userId, err: (err as Error).message });
    }
  }
  if (env.EMAIL_MAGICS_ENABLED) {
    try {
      await runEmailMagics(db, userId);
    } catch (err) {
      logger.warn('email magics pass failed', { userId, err: (err as Error).message });
    }
    // ADR 0346 - the user's own replies on meetings still being arranged.
    try {
      await runOwnReplyScheduling(db, userId);
    } catch (err) {
      logger.warn('meeting own-reply pass failed', { userId, err: (err as Error).message });
    }
  }
  if (env.EMAIL_PERSONS_ENABLED) {
    try {
      await runPersonExtraction(db, userId);
    } catch (err) {
      logger.warn('email person extraction pass failed', { userId, err: (err as Error).message });
    }
  }
  // ADR 0276 — last, so a vector includes the category and facts the passes
  // above just filed. No-op unless EMBEDDINGS_ENABLED.
  try {
    await runEmbedPass(db, userId);
  } catch (err) {
    logger.warn('search embedding pass failed', { userId, err: (err as Error).message });
  }
}

/**
 * When `gmail_sync_labels_enabled`, ensure each classified thread has its
 * `Chord/<category>` Gmail label applied. Manual Apply-label ignores this gate.
 */
export async function maybeSyncCategoryLabels(
  db: Kysely<DB>,
  userId: string,
  opts: { limit?: number } = {},
): Promise<number> {
  const prefs = await db
    .selectFrom('users')
    .select('gmail_sync_labels_enabled')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!prefs || Number(prefs.gmail_sync_labels_enabled ?? 0) !== 1) return 0;
  // A mailbox whose grant has gone has nothing to write to. Without this the
  // loop below failed once per thread on every pass: 8,640 warnings in a day
  // for one disconnected user.
  if (!(await hasGmailScope(db, userId))) return 0;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const threads = await db
    .selectFrom('email_threads')
    .innerJoin('email_categories', 'email_categories.id', 'email_threads.category_id')
    .select([
      'email_threads.id as id',
      'email_threads.gmail_label_ids as labelIds',
      'email_categories.id as categoryId',
      'email_categories.title as title',
      'email_categories.gmail_label_id as gmailLabelId',
    ])
    .where('email_threads.user_id', '=', userId)
    // Gmail labels only exist on the Gmail mailbox (ADR 0080).
    .where('email_threads.account_id', 'is', null)
    .where('email_threads.category_id', 'is not', null)
    // Only threads still missing their label: filtering after the LIMIT meant
    // the newest N, once labelled, filled every batch and older ones were
    // never reached.
    .where(
      sql<boolean>`(email_categories.gmail_label_id is null
        or not (coalesce(email_threads.gmail_label_ids, '[]'::jsonb)
                @> jsonb_build_array(email_categories.gmail_label_id)))`,
    )
    .orderBy('email_threads.last_message_at', 'desc')
    .limit(limit)
    .execute();

  let applied = 0;
  // A label the user deleted in Gmail keeps its id here; applying it again
  // fails on every pass, and making it again undoes the deletion.
  // A list that cannot be read is no evidence of a deletion: no check.
  const present = threads.some((t) => t.gmailLabelId)
    ? await getGmailApi(db, userId)
        .then((api) => cachedGmailLabels(db, userId, api))
        .then((labels) => new Set(labels.map((l) => l.id)))
        .catch(() => null)
    : null;
  const gone = new Set<string>();
  for (const t of threads) {
    try {
      let labelId = t.gmailLabelId;
      if (labelId && present && !present.has(labelId)) {
        if (!gone.has(t.categoryId)) {
          gone.add(t.categoryId);
          await noteFolderRemoved(db, userId, mailboxKeyOf(null), `Chord/${t.title}`);
          await db
            .updateTable('email_categories')
            .set({ gmail_label_id: null })
            .where('id', '=', t.categoryId)
            .execute();
        }
        continue;
      }
      if (!labelId) {
        labelId = await ensureLabel(db, userId, `Chord/${t.title}`);
        if (!labelId) continue;
        await db
          .updateTable('email_categories')
          .set({ gmail_label_id: labelId })
          .where('id', '=', t.categoryId)
          .execute();
      }
      const current = Array.isArray(t.labelIds) ? t.labelIds : [];
      if (current.includes(labelId)) continue;
      await applyThreadModify(db, userId, t.id, { addLabelIds: [labelId] });
      applied += 1;
    } catch (err) {
      logger.warn('apply category label failed', {
        userId,
        threadId: t.id,
        err: (err as Error).message,
      });
      // The grant died mid-pass: every remaining thread would fail the same way.
      if (err instanceof GoogleAuthError && err.needsReconnect) break;
    }
  }
  return applied;
}

// ── backfill + incremental ────────────────────────────────────────────
/**
 * The local mirror must never mix providers: threads synced under
 * GMAIL_PROVIDER=mock are fixtures and must not surface once the deploy
 * flips to real (or vice versa). On a provider mismatch, wipe the mirror
 * and sync state so the next sync rebuilds from the current provider.
 */
export async function ensureMirrorProvider(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  const row = await db
    .selectFrom('users')
    .select(['gmail_mirror_provider'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row?.gmail_mirror_provider && row.gmail_mirror_provider !== env.GMAIL_PROVIDER) {
    logger.warn('gmail mirror provider changed — wiping local mirror', {
      userId,
      from: row.gmail_mirror_provider,
      to: env.GMAIL_PROVIDER,
    });
    await disconnectGmail(db, userId);
  }
  await db
    .updateTable('users')
    .set({ gmail_mirror_provider: env.GMAIL_PROVIDER })
    .where('id', '=', userId)
    .execute();
}

// ── resumable backfill (ADR 0206 addendum) ────────────────────────────
/**
 * Where an unfinished backfill got to. A backfill that runs into Gmail's
 * per-minute quota keeps what it fetched and picks up from here on the next
 * pass. Without this it started again at page 1 every time and could never get
 * past the quota (prod, 2026-10: 48 restarts in three days for one mailbox).
 */
export interface GmailBackfillProgress {
  /** The mailbox's historyId when the backfill began. Incremental sync resumes
   *  from it, so changes made while the backfill ran are replayed. */
  startHistoryId: string;
  startedAt: string;
  /** Next messages.list page; null = the first page. */
  pageToken: string | null;
  pages: number;
  /** 'finish' = every page fetched; only the reverse-delete and the read/inbox
   *  reconcile are left. */
  phase: 'fetch' | 'finish';
  /** The page cap was hit: the snapshot is incomplete, so nothing is reconciled. */
  truncated: boolean;
}

const backfillProgressSchema = z.object({
  startHistoryId: z.string(),
  startedAt: z.string(),
  pageToken: z.string().nullable(),
  pages: z.number().int().nonnegative(),
  phase: z.enum(['fetch', 'finish']),
  truncated: z.boolean(),
});

export function parseBackfillProgress(raw: unknown): GmailBackfillProgress | null {
  const parsed = backfillProgressSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Primary Gmail's progress. Attached Gmail keeps its own in `sync_cursor`. */
export const gmailBackfillProgress = defineUserDefault('gmail_backfill_progress', backfillProgressSchema);

/** A sync result that stopped on the quota. `pausedBy` drives the ADR 0206
 *  wait and is stripped before the result leaves the sync layer. */
export type PausableSyncResult = EmailSyncResult & { pausedBy?: unknown };

/** Lower than incremental sync's concurrency: a backfill is thousands of
 *  messages, which is what runs into the per-minute quota. */
const BACKFILL_FETCH_CONCURRENCY = () => Math.max(1, Math.min(env.GMAIL_FETCH_CONCURRENCY, 4));

export interface GmailBackfillTarget {
  userId: string;
  /** null = the primary Gmail on the user row (ADR 0080). */
  accountId: string | null;
  /** Provider id → the id stored in email_messages (attached accounts prefix it). */
  localId(nativeId: string): string;
  /** Local rows a complete snapshot may delete or relabel. */
  reconcilable?(localMessageId: string): boolean;
  loadProgress(): Promise<GmailBackfillProgress | null>;
  saveProgress(progress: GmailBackfillProgress | null): Promise<void>;
  /** A new backfill began; `historyId` is the mailbox's current one. */
  onStart(historyId: string): Promise<void>;
}

export interface GmailBackfillOutcome {
  status: 'complete' | 'paused';
  inserted: number;
  deleted: number;
  relabelled: number;
  startHistoryId: string | null;
  /** The quota error that paused it. */
  error?: unknown;
}

function mailboxMessages(db: Kysely<DB>, target: GmailBackfillTarget) {
  return target.accountId
    ? db.selectFrom('email_messages').where('account_id', '=', target.accountId)
    : db
        .selectFrom('email_messages')
        .where('user_id', '=', target.userId)
        .where('account_id', 'is', null);
}

/**
 * Import the GMAIL_BACKFILL_DAYS window, resumably. Runs when a mailbox is
 * first connected and when its history id expired.
 *
 * - The mailbox's historyId is stored before the first page and progress after
 *   every page, so a cut-off backfill neither restarts nor loses changes made
 *   while it ran.
 * - Only messages not already mirrored are fetched. Read and inbox state of
 *   the ones already mirrored is brought up to date at the end from two cheap
 *   list searches (is:unread, in:inbox). Their other labels are not, and
 *   history from the start id does not reach back past the backfill.
 * - A per-minute quota error stops the pass at the current page and returns
 *   'paused' instead of throwing; the caller records the ADR 0206 wait.
 * - The reverse-delete runs only on the pass that sees a complete snapshot.
 */
export async function runGmailBackfill(
  db: Kysely<DB>,
  api: GmailApi,
  target: GmailBackfillTarget,
  opts: { maxPages?: number } = {},
): Promise<GmailBackfillOutcome> {
  const { userId, accountId } = target;
  const now = new Date().toISOString();
  const q = `newer_than:${env.GMAIL_BACKFILL_DAYS}d`;
  const maxPages = opts.maxPages ?? 20;
  const touched = new Set<string>();
  let inserted = 0;
  let progress = await target.loadProgress();

  try {
    if (!progress) {
      const { historyId } = await api.getProfile();
      progress = {
        startHistoryId: historyId,
        startedAt: now,
        pageToken: null,
        pages: 0,
        phase: 'fetch',
        truncated: false,
      };
      await target.onStart(historyId);
      await target.saveProgress(progress);
    }

    let relisted = false;
    while (progress.phase === 'fetch') {
      let page: Awaited<ReturnType<GmailApi['listMessages']>>;
      try {
        page = await api.listMessages({ q, pageToken: progress.pageToken ?? undefined, maxResults: 100 });
      } catch (err) {
        // A page token from an earlier pass may no longer be accepted. Start
        // the listing over: mirrored messages are skipped, so that costs list
        // calls, not fetches.
        if (progress.pageToken === null || isRateLimitError(err) || relisted) throw err;
        logger.warn('gmail backfill page token refused — relisting from the start', {
          userId,
          accountId,
          err: (err as Error).message,
        });
        relisted = true;
        progress = { ...progress, pageToken: null, pages: 0 };
        continue;
      }

      const ids = page.messages.map((m) => target.localId(m.id));
      const have = new Set(
        ids.length === 0
          ? []
          : (
              await mailboxMessages(db, target)
                .select('gmail_message_id')
                .where('gmail_message_id', 'in', ids)
                .execute()
            ).map((r) => r.gmail_message_id),
      );
      const missing = page.messages.filter((m) => !have.has(target.localId(m.id)));
      let failure: unknown = null;
      const fetched = await mapConcurrent(missing, BACKFILL_FETCH_CONCURRENCY(), async ({ id }) => {
        if (failure !== null) return undefined;
        try {
          return await api.getMessage(id, 'full');
        } catch (err) {
          if (failure === null) failure = err;
          return undefined;
        }
      });
      // Keep what arrived before a failure; the next pass re-lists this page
      // and fetches only what is still missing.
      for (const raw of fetched) {
        // null = deleted between list and fetch. It is absent from the
        // reverse-delete's listing too, so a stale local copy is reaped.
        if (!raw) continue;
        // An unsent draft is not mail (ADR 0303): Chord's copy of a draft
        // being written would otherwise show in its thread as a message.
        if ((raw.labelIds ?? []).includes('DRAFT')) continue;
        const native = withoutBody(normalizeMessage(raw));
        const nm: NormalizedMessage =
          accountId === null
            ? native
            : {
                ...native,
                gmailMessageId: target.localId(native.gmailMessageId),
                gmailThreadId: target.localId(native.gmailThreadId),
              };
        const threadRowId = await ensureThreadRow(db, userId, nm.gmailThreadId, now, accountId);
        await upsertMessageMeta(db, userId, threadRowId, nm, now, accountId);
        touched.add(nm.gmailThreadId);
        inserted += 1;
      }
      // Filled in per page, not only at the end: a pass can run for minutes
      // across pages and quota waits, and one stopped before its `finally`
      // would leave every thread it wrote empty (see repairUnfilledThreads).
      for (const tid of touched) await recomputeThread(db, userId, tid);
      touched.clear();
      if (failure !== null) throw failure;

      const pages: number = progress.pages + 1;
      const next: string | null = page.nextPageToken ?? null;
      const truncated = next !== null && pages >= maxPages;
      progress = {
        ...progress,
        pages,
        pageToken: truncated ? null : next,
        phase: next === null || truncated ? 'finish' : 'fetch',
        truncated,
      };
      await target.saveProgress(progress);
    }

    let deleted = 0;
    let relabelled = 0;
    if (progress.truncated) {
      logger.warn('gmail backfill truncated at page cap', { userId, accountId, maxPages });
    } else {
      ({ deleted, relabelled } = await reconcileSnapshot(db, api, target, q, maxPages, touched));
    }

    const { startHistoryId } = progress;
    await target.saveProgress(null);
    return { status: 'complete', inserted, deleted, relabelled, startHistoryId };
  } catch (err) {
    if (!isRateLimitError(err)) throw err;
    logger.warn('gmail backfill paused on quota — will resume', {
      userId,
      accountId,
      pages: progress?.pages ?? 0,
      inserted,
      err: (err as Error).message,
    });
    return {
      status: 'paused',
      inserted,
      deleted: 0,
      relabelled: 0,
      startHistoryId: progress?.startHistoryId ?? null,
      error: err,
    };
  } finally {
    for (const tid of touched) await recomputeThread(db, userId, tid);
  }
}

/** Every id a search returns, or null when it ran past the page cap. */
async function listAllIds(api: GmailApi, q: string, maxPages: number): Promise<Set<string> | null> {
  const ids = new Set<string>();
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = await api.listMessages({ q, pageToken, maxResults: 100 });
    for (const m of page.messages) ids.add(m.id);
    pageToken = page.nextPageToken;
    pages += 1;
    if (pageToken && pages >= maxPages) return null;
  } while (pageToken);
  return ids;
}

/**
 * The complete-snapshot step. Deletes made while the cursor was dead are
 * ABSENT from the listing (Gmail leaves trashed and deleted mail out), so their
 * local copies go. The listing is re-read here rather than carried across
 * passes, which costs list calls only. Read and inbox state of mirrored
 * messages is set from the same kind of listing, since they are not re-fetched.
 */
async function reconcileSnapshot(
  db: Kysely<DB>,
  api: GmailApi,
  target: GmailBackfillTarget,
  q: string,
  maxPages: number,
  touched: Set<string>,
): Promise<{ deleted: number; relabelled: number }> {
  const toLocal = (ids: Set<string> | null) =>
    ids === null ? null : new Set([...ids].map((id) => target.localId(id)));
  const seen = toLocal(await listAllIds(api, q, maxPages));
  if (seen === null) return { deleted: 0, relabelled: 0 };
  const unread = toLocal(await listAllIds(api, `${q} is:unread`, maxPages));
  const inbox = toLocal(await listAllIds(api, `${q} in:inbox`, maxPages));

  const windowStart = new Date(
    Date.now() - env.GMAIL_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const local = await mailboxMessages(db, target)
    .select(['id', 'gmail_message_id', 'gmail_thread_id', 'gmail_label_ids'])
    .where('internal_date', '>=', windowStart)
    .execute();
  const candidates = local.filter((r) => target.reconcilable?.(r.gmail_message_id) ?? true);

  const absent = candidates.filter((r) => !seen.has(r.gmail_message_id));
  if (absent.length > 0) {
    await db
      .deleteFrom('email_messages')
      .where('id', 'in', absent.map((r) => r.id))
      .execute();
    for (const r of absent) touched.add(r.gmail_thread_id);
    logger.info(`gmail backfill reverse-delete user=${target.userId} messages=${absent.length}`);
  }

  let relabelled = 0;
  for (const r of candidates) {
    if (!seen.has(r.gmail_message_id)) continue;
    const labels = Array.isArray(r.gmail_label_ids) ? r.gmail_label_ids : [];
    const add: string[] = [];
    const remove: string[] = [];
    for (const [label, set] of [
      ['UNREAD', unread],
      ['INBOX', inbox],
    ] as const) {
      // A search that ran past the cap proves nothing about what it left out.
      if (set === null) continue;
      const has = labels.includes(label);
      if (set.has(r.gmail_message_id) && !has) add.push(label);
      if (!set.has(r.gmail_message_id) && has) remove.push(label);
    }
    if (add.length === 0 && remove.length === 0) continue;
    const next = applyLabelDelta(labels, add, remove);
    await db
      .updateTable('email_messages')
      .set({ gmail_label_ids: JSON.stringify(next), is_unread: next.includes('UNREAD') ? 1 : 0 })
      .where('id', '=', r.id)
      .execute();
    touched.add(r.gmail_thread_id);
    relabelled += 1;
  }
  return { deleted: absent.length, relabelled };
}

/**
 * Initial import of the GMAIL_BACKFILL_DAYS window for the primary Gmail, and
 * the fallback when its history id expired. Resumable: see runGmailBackfill.
 */
export async function backfillGmail(
  db: Kysely<DB>,
  userId: string,
  opts: { maxPages?: number } = {},
): Promise<PausableSyncResult> {
  await ensureMirrorProvider(db, userId);
  const api = await getGmailApi(db, userId);
  const out = await runGmailBackfill(
    db,
    api,
    {
      userId,
      accountId: null,
      localId: (id) => id,
      loadProgress: () => gmailBackfillProgress.get(db, userId),
      saveProgress: (p) => gmailBackfillProgress.set(db, userId, p),
      onStart: async (historyId) => {
        await db.updateTable('users').set({ gmail_history_id: historyId }).where('id', '=', userId).execute();
      },
    },
    opts,
  );

  if (out.status === 'paused') {
    // gmail_synced_at stays put: the mirror is not caught up (ADR 0206).
    const result: EmailSyncResult = { inserted: out.inserted, updated: 0, deleted: 0, backfillDone: false };
    if (out.inserted > 0) emitEmailSynced(userId, result);
    return { ...result, pausedBy: out.error };
  }

  const patch: Record<string, unknown> = {
    gmail_backfill_done: 1,
    gmail_synced_at: new Date().toISOString(),
  };
  if (out.startHistoryId) patch.gmail_history_id = out.startHistoryId;
  await db.updateTable('users').set(patch).where('id', '=', userId).execute();
  logger.info(
    `gmail backfill user=${userId} messages=${out.inserted} relabelled=${out.relabelled} deleted=${out.deleted}`,
  );
  await afterSync(db, userId);
  const result: EmailSyncResult = {
    inserted: out.inserted,
    updated: out.relabelled,
    deleted: out.deleted,
    backfillDone: true,
  };
  emitEmailSynced(userId, result);
  return result;
}

/**
 * Incremental sync via the History API. Falls back to a bounded re-backfill when
 * the stored historyId has expired (Gmail returns 404) or when the mailbox has
 * never been backfilled.
 */
export async function syncGmailIncremental(
  db: Kysely<DB>,
  userId: string,
): Promise<EmailSyncResult> {
  try {
    const { pausedBy, ...result } = await syncGmailIncrementalOnce(db, userId);
    if (pausedBy !== undefined) recordSyncPause(gmailKey(userId), pausedBy, result.inserted > 0);
    else recordSyncSuccess(gmailKey(userId));
    return result;
  } catch (err) {
    recordSyncFailure(gmailKey(userId), err);
    throw err;
  }
}

async function syncGmailIncrementalOnce(
  db: Kysely<DB>,
  userId: string,
): Promise<PausableSyncResult> {
  await ensureMirrorProvider(db, userId);
  const user = await db
    .selectFrom('users')
    .select(['gmail_history_id', 'gmail_backfill_done'])
    .where('id', '=', userId)
    .executeTakeFirst();
  // An unfinished backfill already stored its start historyId; incremental
  // from there would skip the pages it has not reached yet.
  if (
    !user ||
    user.gmail_backfill_done !== 1 ||
    !user.gmail_history_id ||
    (await gmailBackfillProgress.get(db, userId))
  ) {
    return backfillGmail(db, userId);
  }

  const api = await getGmailApi(db, userId);
  const now = new Date().toISOString();
  const records = [];
  let latestHistory = user.gmail_history_id;
  let pageToken: string | undefined;
  do {
    const page = await api.listHistory({ startHistoryId: user.gmail_history_id, pageToken });
    if (page.notFound) {
      logger.info('gmail history expired — re-backfilling', { userId });
      return backfillGmail(db, userId);
    }
    for (const r of page.history ?? []) records.push(r);
    if (page.historyId) latestHistory = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);

  const diff = diffHistory(records);
  let updated = 0;
  let deleted = 0;

  const addedRaw = await mapConcurrent(diff.addedMessageIds, env.GMAIL_FETCH_CONCURRENCY, (id) =>
    api.getMessage(id, 'full'),
  );
  for (const raw of addedRaw) {
    // Added then deleted before we fetched it — the delete shows up as its own
    // history record (this batch or the next), so skipping still converges.
    if (!raw) continue;
    const nm = withoutBody(normalizeMessage(raw));
    // Spam never enters the mirror. Backfill's messages.list already excludes
    // it (API default); history records don't, so filter here. A later rescue
    // out of spam arrives as a label change for an unknown row — handled below.
    if (nm.labelIds.includes('SPAM')) continue;
    // Nor does an unsent draft (ADR 0303); it arrives when it is sent.
    if (nm.labelIds.includes('DRAFT')) continue;
    const threadRowId = await ensureThreadRow(db, userId, nm.gmailThreadId, now);
    await upsertMessageMeta(db, userId, threadRowId, nm, now);
    updated += 1;
  }
  for (const id of diff.deletedMessageIds) {
    const res = await db
      .deleteFrom('email_messages')
      .where('user_id', '=', userId)
      .where('gmail_message_id', '=', id)
      .executeTakeFirst();
    deleted += Number(res.numDeletedRows ?? 0);
  }
  for (const ch of diff.labelChanges) {
    const row = await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .where('gmail_message_id', '=', ch.messageId)
      .executeTakeFirst();
    if (!row) {
      // Unknown row + label change = usually a rescue out of spam, or a draft
      // sent from Gmail itself (its message keeps its id and loses DRAFT) -
      // both adds were skipped above. Fetch and store it now that it's mail.
      if (ch.remove.includes('SPAM') || ch.remove.includes('DRAFT')) {
        const raw = await api.getMessage(ch.messageId, 'full');
        if (raw) {
          const nm = withoutBody(normalizeMessage(raw));
          if (!nm.labelIds.includes('SPAM') && !nm.labelIds.includes('DRAFT')) {
            const threadRowId = await ensureThreadRow(db, userId, nm.gmailThreadId, now);
            await upsertMessageMeta(db, userId, threadRowId, nm, now);
            updated += 1;
          }
        }
      }
      continue;
    }
    const next = applyLabelDelta(row.gmail_label_ids, ch.add, ch.remove);
    await db
      .updateTable('email_messages')
      .set({ gmail_label_ids: JSON.stringify(next), is_unread: next.includes('UNREAD') ? 1 : 0 })
      .where('id', '=', row.id)
      .execute();
    updated += 1;
  }
  for (const tid of diff.touchedThreadIds) await recomputeThread(db, userId, tid);

  await db
    .updateTable('users')
    .set({ gmail_history_id: latestHistory, gmail_synced_at: now })
    .where('id', '=', userId)
    .execute();
  await afterSync(db, userId);
  const result: EmailSyncResult = { inserted: 0, updated, deleted, backfillDone: true };
  emitEmailSynced(userId, result);
  return result;
}

/** Opportunistic, throttled, never-throws sync (foreground focus + proactive tick). */
export async function maybeSyncGmail(
  db: Kysely<DB>,
  userId: string,
  windowMs: number = SYNC_THROTTLE_MS(),
): Promise<void> {
  try {
    if (!env.GMAIL_ENABLED) return;
    if (!(await hasGmailScope(db, userId))) return;
    const row = await db
      .selectFrom('users')
      .select('gmail_synced_at')
      .where('id', '=', userId)
      .executeTakeFirst();
    const last = row?.gmail_synced_at ? Date.parse(row.gmail_synced_at) : 0;
    if (Date.now() - last < windowMs) return;
    // `gmail_synced_at` only moves on success, so without this a failing
    // mailbox looks stale on every tick and is retried every 15 seconds.
    if (backoffRemainingMs(gmailKey(userId)) > 0) return;
    await syncGmailIncremental(db, userId);
  } catch (err) {
    logger.warn('maybeSyncGmail failed', {
      userId,
      err: (err as Error).message,
      retryInMs: backoffRemainingMs(gmailKey(userId)),
    });
  }
}

// ── read: thread + lazy bodies ────────────────────────────────────────
/**
 * Compose a NEW message from the PRIMARY Gmail mailbox (ADR 0107).
 *
 * Deliberately does not touch the mirror. A reply upserts its own sent message
 * because the thread is already local and the user is looking at it; a new
 * message has no local thread, and inventing one would mean guessing the
 * provider's thread id. The next sync mirrors it from the mailbox, which is
 * the same rule the rest of the reader follows: the provider is the truth.
 */
export async function sendNewMessage(
  db: Kysely<DB>,
  userId: string,
  input: {
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    body: string;
  attachments?: { filename: string; mimeType: string; content: Buffer }[];
    /** ADR 0130 - a verified send-as address. The caller has already checked
     *  it; this function never decides who the user may impersonate. */
    from?: string;
  } & Omit<ComposedBody, 'body'>,
): Promise<{ fromEmail: string }> {
  const me = await db
    .selectFrom('users')
    .select(['email', 'email_signature', 'email_signature_html'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const fromEmail = input.from ?? me?.email ?? 'me@example.com';
  const bodies = composedBodies(input, await mailboxSignatureRow(db, userId, null));
  const textBody = bodies.text;
  const htmlBody = bodies.plain ? undefined : bodies.html;

  const raw = buildReplyRaw({
    fromEmail,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    // No threading headers and no 'Re:' — this starts a conversation.
    subject: input.subject,
    inReplyTo: null,
    references: null,
    body: textBody,
    htmlBody,
    attachments: input.attachments,
  });
  const api = await getGmailApi(db, userId);
  await api.sendMessage(raw);
  return { fromEmail };
}
/**
 * A body that shows `cid:` images, with a part list recorded before parts
 * carried their Content-ID, cannot render those images — nothing maps the
 * reference to a part. Re-reading the part list settles it.
 */
function lacksInlinePartIds(
  html: string | null,
  attachments: { contentId?: string }[] | null,
): boolean {
  if (!hasInlineImageRefs(html)) return false;
  return !(Array.isArray(attachments) ? attachments : []).some((a) => a.contentId);
}

/** A message whose body or part list a thread open has to fetch. */
export interface MissingMessage {
  id: string;
  gmail_message_id: string;
  /** What is stored now: a re-read keeps these ids (keepAttachmentIds). */
  attachments_json: EmailAttachmentRef[] | null;
}

/** What a body fetch learned about the mailbox while it was there. */
export interface BodyFetchOutcome {
  /** Message row ids the provider no longer has. */
  gone?: string[];
  /** The fetcher already changed message rows itself (an Outlook move). */
  changed?: boolean;
}

/** Core thread read; the body fetcher is provider-specific (ADR 0080). A row
 *  is "missing" when its body OR its attachment metadata is undiscovered —
 *  the fetcher must settle both (attachments_json '[]' when none).
 *
 *  Opening a thread is also a look at the mailbox. A message the provider says
 *  it no longer has is dropped here, and a thread left with no message is
 *  removed and reads as not found - rather than a row that stays listed as
 *  inbox mail and opens to a blank page. */
export async function getThreadWith(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  fetchMissingBodies: (missing: MissingMessage[]) => Promise<void | BodyFetchOutcome>,
): Promise<EmailThreadDetail | null> {
  let thread = await db
    .selectFrom('email_threads')
    .selectAll()
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return null;

  let messages = await db
    .selectFrom('email_messages')
    .selectAll()
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', userId)
    .orderBy('internal_date', 'asc')
    .execute();

  const missing = messages.filter(
    (m) =>
      (m.body_text === null && m.body_html === null) ||
      m.attachments_json === null ||
      (m.cid_parts_checked === 0 && lacksInlinePartIds(m.body_html, m.attachments_json)),
  );
  let mailboxChanged = false;
  let bodiesPending = false;
  if (missing.length > 0) {
    const settle = (async (): Promise<BodyFetchOutcome> => {
      const outcome =
        (await fetchMissingBodies(
          missing.map((m) => ({ id: m.id, gmail_message_id: m.gmail_message_id, attachments_json: m.attachments_json })),
        )) ?? {};
      if (outcome.gone?.length) {
        await db
          .deleteFrom('email_messages')
          .where('user_id', '=', userId)
          .where('id', 'in', outcome.gone)
          .execute();
      }
      return outcome;
    })();
    // A provider that is slow or failing must not hold the open: past the
    // budget the thread is shown with what is stored, and the rest is
    // announced when it lands (the open reader reloads on thread.updated).
    const outcome = await withinBudget(settle, threadOpenFetchBudgetMs);
    if (outcome === null) {
      bodiesPending = true;
      runInBackground(
        settle.then((late) =>
          announceLateBodies(
            db,
            userId,
            threadRowId,
            thread!.gmail_thread_id,
            // Only a row that had no body can "arrive"; one missing just its
            // part list would read as news on every open.
            missing.filter((m) => m.body_text === null && m.body_html === null).map((m) => m.id),
            late,
          ),
        ),
        'thread body fetch',
      );
    }
    mailboxChanged = !!outcome?.gone?.length || !!outcome?.changed;
    messages = await db
      .selectFrom('email_messages')
      .selectAll()
      .where('thread_id', '=', threadRowId)
      .where('user_id', '=', userId)
      .orderBy('internal_date', 'asc')
      .execute();
  }

  if (mailboxChanged || messages.length === 0) {
    await recomputeThread(db, userId, thread.gmail_thread_id);
    sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
    if (messages.length === 0) return null;
    const fresh = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('id', '=', threadRowId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (!fresh) return null;
    thread = fresh;
  }

  // Same rule as aggregateThread: a message trashed out of a live thread is
  // not part of what the reader sees (Gmail hides it too).
  const live = messages.filter(
    (m) => !(Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('TRASH')),
  );
  const mailbox = thread.account_id
    ? await db
        .selectFrom('email_accounts')
        .select('email_address as email')
        .where('id', '=', thread.account_id)
        .where('user_id', '=', userId)
        .executeTakeFirst()
    : await db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirst();
  const shown = live.length > 0 ? live : messages;
  return {
    thread: threadRowToSummary(thread),
    messages: await annotateSenderChecks(db, userId, {
      threadId: thread.id,
      bulk: thread.bulk === 1 || thread.bulk_inferred === 1,
      rows: shown,
      messages: shown.map(messageRowToDto),
    }),
    mailboxEmail: mailbox?.email ?? null,
    ...(bodiesPending ? { bodiesPending: true } : {}),
  };
}

/** How long a thread open waits on the provider for bodies it has not stored. */
let threadOpenFetchBudgetMs = 8_000;

export function __setThreadOpenFetchBudgetForTests(ms: number | null): void {
  threadOpenFetchBudgetMs = ms ?? 8_000;
}

/** The work's result, or null when it is still running after `ms`. */
async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bodies an open gave up waiting for arrived (or did not). Tell the user's
 * devices only when something changed, so a reader that reloads on the event
 * does not ask a failing provider again in a loop.
 */
async function announceLateBodies(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  gmailThreadId: string,
  missingIds: string[],
  outcome: BodyFetchOutcome,
): Promise<void> {
  const mailboxChanged = !!outcome.gone?.length || !!outcome.changed;
  if (mailboxChanged) {
    await recomputeThread(db, userId, gmailThreadId);
    sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });
  }
  const filled =
    missingIds.length > 0 &&
    !!(await db
      .selectFrom('email_messages')
      .select('id')
      .where('user_id', '=', userId)
      .where('id', 'in', missingIds)
      .where((eb) => eb.or([eb('body_text', 'is not', null), eb('body_html', 'is not', null)]))
      .executeTakeFirst());
  if (!mailboxChanged && !filled) return;
  const row = await db
    .selectFrom('email_threads')
    .selectAll()
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (row) emitEmailThreadUpdated(userId, threadRowToSummary(row));
}

const THREAD_BODY_FETCH_CONCURRENCY = 4;

export async function getThread(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
): Promise<EmailThreadDetail | null> {
  return getThreadWith(db, userId, threadRowId, async (missing) => {
    const api = await getGmailApi(db, userId);
    const gone: string[] = [];
    // A long thread opened for the first time fetched its bodies one after
    // another; a few at a time keeps the open quick without a burst.
    await forEachConcurrent(missing, THREAD_BODY_FETCH_CONCURRENCY, async (m) => {
      try {
        const raw = await api.getMessage(m.gmail_message_id, 'full');
        // Null is Gmail's 404 and nothing else: the message was deleted for
        // good and the history record saying so never reached us.
        if (!raw) {
          gone.push(m.id);
          return;
        }
        const bodies = extractBodies(raw.payload);
        const parts = keepAttachmentIds(m.attachments_json, listAttachmentParts(raw.payload).map(toAttachmentRef));
        await db
          .updateTable('email_messages')
          .set({
            ...(await sealMessageContent(userId, {
              body_text: bodies.text,
              body_html: bodies.html,
              attachments_json: JSON.stringify(parts),
            })),
            cid_parts_checked: 1,
          })
          .where('id', '=', m.id)
          .execute();
      } catch (err) {
        logger.warn('gmail body fetch failed', { userId, id: m.id, err: (err as Error).message });
      }
    });
    return { gone };
  });
}

// ── write-back: reply + modify ────────────────────────────────────────
/** The anchor's display name belongs on the To line only when the anchor's
 *  sender IS that recipient - else one person's name labels another's address. */
export function toNameFor(
  to: string[],
  anchor: { from_name: string | null; from_email: string | null } | undefined,
): string | null {
  if (!anchor?.from_name || to.length !== 1) return null;
  return anchor.from_email?.toLowerCase() === to[0].toLowerCase() ? anchor.from_name : null;
}

export async function sendReply(
  db: Kysely<DB>,
  userId: string,
  input: {
    threadRowId: string;
    body: string;
    /** Omitted → the latest sender (plain reply). */
    to?: string[];
    cc?: string[];
    bcc?: string[];
    attachments?: { filename: string; mimeType: string; content: Buffer }[];
    /** The message being answered; omitted = the newest not our own. */
    messageId?: string;
    /** ADR 0124 - an auto-reply is not reading. Default true: a person
     *  replying has read it. */
    markRead?: boolean;
    /** ADR 0314 - an automatic reply: sent with `Auto-Submitted` and marked
     *  so it never reads as the user answering. */
    autoReply?: boolean;
  } & Omit<ComposedBody, 'body'>,
): Promise<EmailThreadDetail | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'subject'])
    .where('id', '=', input.threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return null;

  const me = await db
    .selectFrom('users')
    .select(['email', 'email_signature', 'email_signature_html'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const latest =
    (await replyAnchor(db, userId, thread.id, {
      messageId: input.messageId,
      ownAddress: me?.email,
    })) ??
    // Every message is our own: still thread onto the newest.
    (await db
      .selectFrom('email_messages')
      .selectAll()
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', userId)
      .orderBy('internal_date', 'desc')
      .limit(1)
      .executeTakeFirst());
  const fromEmail = me?.email ?? 'me@example.com';
  const replyAddress = latest
    ? replyAddressOf({ fromEmail: latest.from_email, replyTo: latest.reply_to }, me?.email ?? null)
    : null;
  const to = input.to?.length ? input.to : replyAddress ? [replyAddress] : [];
  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const references = (latest?.headers_json as { references?: string | null } | undefined)?.references ?? null;
  const inReplyTo = latest?.rfc822_message_id ?? null;
  const subject = thread.subject || latest?.subject || '';

  const bodies = await withQuotedOriginal(
    db,
    userId,
    composedBodies(input, await mailboxSignatureRow(db, userId, null)),
    latest,
    { autoReply: input.autoReply },
  );
  const textBody = bodies.text;
  const htmlBody = bodies.plain ? undefined : bodies.html;

  const raw = buildReplyRaw({
    fromEmail,
    to,
    toName: toNameFor(to, latest),
    cc,
    bcc,
    // The builder no longer adds it; a reply still wants it.
    subject: replySubject(subject),
    inReplyTo,
    references,
    body: textBody,
    htmlBody,
    attachments: input.attachments,
    autoSubmitted: input.autoReply === true,
  });

  const api = await getGmailApi(db, userId);
  const sent = await api.sendMessage(raw, thread.gmail_thread_id);
  const now = new Date().toISOString();
  const nm: NormalizedMessage = {
    gmailMessageId: sent.id,
    gmailThreadId: thread.gmail_thread_id,
    fromName: null,
    fromEmail,
    toEmails: to,
    ccEmails: cc,
    subject: replySubject(subject),
    snippet: input.body.slice(0, 120),
    bodyText: textBody,
    bodyHtml: htmlBody ?? null,
    internalDate: now,
    isUnread: false,
    labelIds: sent.labelIds ?? ['SENT'],
    rfc822MessageId: null,
    headers: { references, inReplyTo, date: null },
    attachmentsJson: '[]',
    autoReply: input.autoReply === true,
  };
  await upsertMessageMeta(db, userId, thread.id, nm, now);
  // A reply implies the thread is read - unless nobody read it (ADR 0124).
  const summary =
    input.markRead === false
      ? null
      : await applyThreadModify(db, userId, thread.id, { markRead: true });
  // A successful mark-read already recomputed the thread with the new message.
  if (!summary) await recomputeThread(db, userId, thread.gmail_thread_id);
  const detail = await getThread(db, userId, thread.id);
  // applyThreadModify already emits emailThreadUpdated when markRead succeeds.
  if (!summary && detail) emitEmailThreadUpdated(userId, detail.thread);
  return detail;
}

/**
 * Put a thread aside until a moment, or wake it now (ADR 0129).
 *
 * Local only, and deliberately: Gmail's own snooze has no API, so there is
 * nothing to write through to. The thread stays visible in Gmail.
 */
export async function snoozeThread(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  until: string | null,
): Promise<EmailThreadSummary | null> {
  const now = new Date().toISOString();
  const res = await db
    .updateTable('email_threads')
    .set(until ? { snoozed_until: until, snoozed_at: now } : { snoozed_until: null, snoozed_at: null })
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (Number(res.numUpdatedRows ?? 0) === 0) return null;

  const row = await db
    .selectFrom('email_threads')
    .selectAll()
    .where('id', '=', threadRowId)
    .executeTakeFirst();
  if (!row) return null;
  const summary = threadRowToSummary(row);
  emitEmailThreadUpdated(userId, summary);
  return summary;
}

/** docs/notes/0199 — set by the retry sweep: a failure must throw so the
 *  sweep can back off, never re-queue (which would reset its own backoff). */
export interface ReadWriteOpts {
  fromRetry?: boolean;
}

/** Change read/archive/label state on a thread (Gmail + local mirror). */
export async function applyThreadModify(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  patch: EmailModifyRequest,
  opts: ReadWriteOpts = {},
): Promise<EmailThreadSummary | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'category_id', 'gmail_label_ids'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!thread) return null;

  if (patch.messageIds) {
    const msgs = await threadMessagesIn(db, userId, thread.id, patch.messageIds);
    if (msgs.length > 0) {
      // A failure is the caller's to retry: the ADR 0199 queue holds a THREAD
      // intent, and replaying "read" would mark messages nobody has seen.
      const api = await getGmailApi(db, userId);
      await api.modifyMessages(
        msgs.map((m) => m.gmail_message_id),
        { removeLabelIds: ['UNREAD'] },
      );
    }
    return applyLocalThreadLabels(db, userId, thread.id, thread.gmail_thread_id, [], ['UNREAD'], msgs.map((m) => m.id));
  }

  // ADR 0141 — Chord labels are local; apply before any provider call.
  await applyChordLabelPatch(db, userId, thread.id, patch);
  if (chordLabelPatchRequested(patch)) {
    const { pushChordLabels } = await import('../email/chord-label-push.js');
    await pushChordLabels(db, userId, thread.id, patch);
  }

  if (patch.trash === true) {
    const api = await getGmailApi(db, userId);
    await api.trashThread(thread.gmail_thread_id);
    return applyLocalThreadLabels(db, userId, thread.id, thread.gmail_thread_id, ...TRASH_DELTA);
  }

  const add = [...(patch.addLabelIds ?? [])];
  const remove = [...(patch.removeLabelIds ?? [])];

  if (patch.applyCategoryLabel === true) {
    if (!thread.category_id) {
      // No category → no-op for the label half; still allow other patch fields.
    } else {
      const cat = await db
        .selectFrom('email_categories')
        .select(['id', 'title', 'gmail_label_id'])
        .where('id', '=', thread.category_id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (cat) {
        // Asked for on this thread just now: found by name, and made again even
        // if the user once deleted it (a stored id may name a deleted label).
        const labelId = await ensureLabel(db, userId, `Chord/${cat.title}`, { explicit: true });
        if (labelId && labelId !== cat.gmail_label_id) {
          await db
            .updateTable('email_categories')
            .set({ gmail_label_id: labelId })
            .where('id', '=', cat.id)
            .execute();
        }
        const current = Array.isArray(thread.gmail_label_ids) ? thread.gmail_label_ids : [];
        if (labelId && !current.includes(labelId) && !add.includes(labelId)) add.push(labelId);
      }
    }
  }

  if (patch.markRead === true) remove.push('UNREAD');
  if (patch.markRead === false) add.push('UNREAD');
  if (patch.archive === true) remove.push('INBOX');
  if (patch.archive === false) add.push('INBOX');

  if (add.length === 0 && remove.length === 0) {
    // Chord-only (or no-op provider half) — return the local row.
    const unchanged = await db
      .selectFrom('email_threads')
      .selectAll()
      .where('id', '=', thread.id)
      .executeTakeFirst();
    if (!unchanged) return null;
    const summary = threadRowToSummary(unchanged);
    emitEmailThreadUpdated(userId, summary);
    return summary;
  }

  try {
    const api = await getGmailApi(db, userId);
    await api.modifyThread(thread.gmail_thread_id, { addLabelIds: add, removeLabelIds: remove });
  } catch (err) {
    // docs/notes/0199 — a read/unread Gmail refused is still what the user
    // chose: show it, and owe it to Gmail rather than dropping it. Anything
    // else in the patch (archive, labels) keeps failing loudly as before.
    if (!isReadOnlyDelta(add, remove) || opts.fromRetry || isGoneError(err)) throw err;
    logger.warn('gmail read-state write failed — queued for retry', { userId, err });
    await queueReadWrite(db, userId, thread.id, patch.markRead === false, err);
    return applyLocalThreadLabels(db, userId, thread.id, thread.gmail_thread_id, add, remove);
  }
  if (patch.markRead !== undefined) await clearReadWrite(db, thread.id);

  return applyLocalThreadLabels(db, userId, thread.id, thread.gmail_thread_id, add, remove);
}

/** The thread's own messages among `ids` (anything else is ignored). */
export async function threadMessagesIn(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  ids: readonly string[],
): Promise<{ id: string; gmail_message_id: string }[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('email_messages')
    .select(['id', 'gmail_message_id'])
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', userId)
    .where('id', 'in', [...ids])
    .execute();
}

/**
 * Store new label sets for several messages in one statement; `is_unread`
 * follows the UNREAD label, as everywhere else.
 */
async function writeMessageLabels(
  db: Kysely<DB>,
  userId: string,
  updates: { id: string; labels: string[] }[],
): Promise<void> {
  if (updates.length === 0) return;
  const values = sql.join(updates.map((u) => sql`(${u.id}::text, ${JSON.stringify(u.labels)}::jsonb)`));
  await sql`
    update email_messages as m
    set gmail_label_ids = v.labels,
        is_unread = case when v.labels @> '["UNREAD"]'::jsonb then 1 else 0 end
    from (values ${values}) as v(id, labels)
    where m.id = v.id and m.user_id = ${userId}
  `.execute(db);
}

/**
 * ADR 0215 — how a thread the provider just trashed looks in the mirror, on
 * every provider. INBOX goes too, so it leaves the inbox at once; TRASH on
 * every message is what makes `recomputeThread` retract the thread's pending
 * suggestions and retire its to-dos (ADR 0073/0143), as a trash done in the
 * provider already does.
 */
export const TRASH_DELTA: [add: string[], remove: string[]] = [['TRASH'], ['INBOX']];

/** Only the UNREAD label moves — a pure read/unread change. */
export function isReadOnlyDelta(add: string[], remove: string[]): boolean {
  return (
    add.length + remove.length > 0 &&
    add.every((l) => l === 'UNREAD') &&
    remove.every((l) => l === 'UNREAD')
  );
}

/** The thread or message no longer exists at the provider — nothing is owed. */
export function isGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|ErrorItemNotFound/.test(msg);
}

/**
 * Apply a label add/remove to the LOCAL mirror only (messages + thread
 * recompute + SSE). The provider-side effect must already have happened —
 * shared by the Gmail path and the ADR 0080 account providers.
 */
export async function applyLocalThreadLabels(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  gmailThreadId: string,
  add: string[],
  remove: string[],
  /** Only these messages (row ids); absent = every message of the thread. */
  onlyMessageIds?: readonly string[],
): Promise<EmailThreadSummary | null> {
  let q = db
    .selectFrom('email_messages')
    .select(['id', 'gmail_label_ids'])
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', userId);
  if (onlyMessageIds) {
    if (onlyMessageIds.length === 0) q = q.where(sql<boolean>`false`);
    else q = q.where('id', 'in', [...onlyMessageIds]);
  }
  const msgs = await q.execute();
  await writeMessageLabels(
    db,
    userId,
    msgs.map((m) => ({ id: m.id, labels: applyLabelDelta(m.gmail_label_ids, add, remove) })),
  );
  await recomputeThread(db, userId, gmailThreadId);

  const updated = await db
    .selectFrom('email_threads')
    .selectAll()
    .where('id', '=', threadRowId)
    .executeTakeFirst();
  const summary = updated ? threadRowToSummary(updated) : null;
  if (summary) emitEmailThreadUpdated(userId, summary);
  return summary;
}

/**
 * List thread summaries for the reader. `mode: 'traditional'` = the whole inbox
 * newest-first (archived excluded); `mode: 'category'` = threads assigned to the
 * given leaf category (subtree rollup is the tiles endpoint's job). `cursor` is
 * `<last_message_at>|<id>` of the last row seen (keyset pagination).
 */
export async function listThreads(
  db: Kysely<DB>,
  userId: string,
  opts: {
    mode?: 'traditional' | 'category';
    /** A category and its descendants — the subtree to filter by (category mode). */
    categoryIds?: string[];
    /** Action-axis filter; independent of category, so it composes with both
     *  modes. Empty/absent = no action filter. */
    actions?: EmailAction[];
    /** Unread threads only; composes with every other filter. */
    unreadOnly?: boolean;
    /** Which folder to read; a label predicate, not a column (ADR 0108). */
    folder?: EmailFolder;
    /** Browse one label (ADR 0125). Composes with the folder rather than
     *  replacing it: a label spans the inbox and the archive. */
    labelId?: string;
    /** One mailbox only (ADR 0119). `'primary'` means the Gmail on the user
     *  row, whose `account_id` is NULL — a filter has to be able to say that,
     *  and an empty string cannot. */
    accountId?: string;
    cursor?: string;
    /** ADR 0134 — return exactly these threads, archived ones included.
     *  An explicitly-requested set is not browsing, which is what ADR 0073's
     *  hide-archived rule governs. The caller has already decided which threads
     *  it means, and for "handled today" that set is a record of the user's own
     *  actions, which archiving the mail afterwards does not undo. */
    ids?: string[];
    limit?: number;
  },
): Promise<EmailThreadSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let q = db
    .selectFrom('email_threads')
    .leftJoin('email_accounts', 'email_accounts.id', 'email_threads.account_id')
    .selectAll('email_threads')
    .select('email_accounts.email_address as account_email')
    .select(
      sql<boolean>`exists (select 1 from email_messages m where m.thread_id = email_threads.id and m.has_attachments = 1)`.as(
        'has_attachments',
      ),
    )
    .where('email_threads.user_id', '=', userId)
    .orderBy('email_threads.last_message_at', 'desc')
    .orderBy('email_threads.id', 'desc')
    .limit(limit);
  if (opts.accountId === 'primary') {
    q = q.where('email_threads.account_id', 'is', null);
  } else if (opts.accountId) {
    q = q.where('email_threads.account_id', '=', opts.accountId);
  }
  if (opts.ids?.length) {
    // ADR 0134 - an explicit set is returned as asked for, archived rows
    // included: the caller named these threads, so a folder predicate would
    // silently drop exactly the ones it wanted. Qualified, because the
    // account join (ADR 0119) makes a bare `id` ambiguous.
    q = q.where('email_threads.id', 'in', opts.ids);
  } else {
    // A label is not inside a folder. In Gmail "labelled" and "archived" are
    // orthogonal, and the mail most likely to carry a label is precisely the
    // mail that left the inbox - so browsing one reads across the mirror
    // (minus deleted), the same reach search has (ADR 0125).
    q = q.where(
      opts.labelId
        ? searchablePredicate('email_threads.')
        : folderPredicate(opts.folder ?? 'inbox', 'email_threads.'),
    );
    if (opts.labelId) q = q.where(labelPredicate(opts.labelId, 'email_threads.'));
  }
  if (opts.mode === 'category') {
    // Empty subtree → no rows (avoids an `in ()` that matches everything).
    q = q.where(
      'email_threads.category_id',
      'in',
      opts.categoryIds?.length ? opts.categoryIds : ['\0none'],
    );
  }
  if (opts.actions?.length) q = q.where('email_threads.action', 'in', opts.actions);
  if (opts.unreadOnly) q = q.where('email_threads.is_unread', '=', 1);
  // Keyset pagination on the sort column: the client sends back the last row's
  // timestamp, so a page boundary cannot drift the way an OFFSET does when new
  // mail lands mid-scroll. `<timestamp>|<id>` breaks ties on the id: threads
  // sharing a timestamp at a page edge were skipped (Outlook stores whole
  // seconds). A bare timestamp is an older app's cursor.
  if (opts.cursor) {
    const bar = opts.cursor.lastIndexOf('|');
    if (bar > 0) {
      const at = opts.cursor.slice(0, bar);
      const id = opts.cursor.slice(bar + 1);
      q = q.where((eb) =>
        eb.or([
          eb('email_threads.last_message_at', '<', at),
          eb.and([eb('email_threads.last_message_at', '=', at), eb('email_threads.id', '<', id)]),
        ]),
      );
    } else {
      q = q.where('email_threads.last_message_at', '<', opts.cursor);
    }
  }
  const rows = await q.execute();
  const summaries = rows.map(threadRowToSummary);
  const files = await threadFiles(
    db,
    userId,
    summaries.filter((s) => s.hasAttachments).map((s) => s.id),
  );
  const drafts = await threadsWithDrafts(db, userId, summaries.map((s) => s.id));
  return summaries.map((s) => ({
    ...s,
    ...(files.has(s.id) ? { files: files.get(s.id) } : {}),
    ...(drafts.has(s.id) ? { hasDraft: true } : {}),
  }));
}

/**
 * ADR 0338: the threads among `threadIds` holding an unsent reply or forward,
 * so the list can say so (a message already queued to send is not a draft).
 */
export async function threadsWithDrafts(db: Kysely<DB>, userId: string, threadIds: string[]): Promise<Set<string>> {
  if (!threadIds.length) return new Set();
  const rows = await db
    .selectFrom('email_drafts')
    .select('thread_id')
    .distinct()
    .where('user_id', '=', userId)
    .where('thread_id', 'in', threadIds)
    .where('send_after', 'is', null)
    .execute();
  return new Set(rows.map((r) => r.thread_id).filter((t): t is string => !!t));
}

const THREAD_FILES_MAX = 20;

/**
 * The files of these threads, newest email first, for the list row. The part
 * lists are sealed, so only messages flagged as carrying a file are read; an
 * image shown inside the body (a part with a Content-ID) is not a file.
 */
async function threadFiles(
  db: Kysely<DB>,
  userId: string,
  threadIds: string[],
): Promise<Map<string, EmailThreadFile[]>> {
  const out = new Map<string, EmailThreadFile[]>();
  if (threadIds.length === 0) return out;
  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'thread_id', 'attachments_json'])
    .where('user_id', '=', userId)
    .where('thread_id', 'in', threadIds)
    .where('has_attachments', '=', 1)
    .orderBy(textInstant('internal_date'), 'desc')
    .execute();
  for (const r of rows) {
    const list = out.get(r.thread_id) ?? [];
    for (const a of Array.isArray(r.attachments_json) ? r.attachments_json : []) {
      if ((a as { contentId?: string }).contentId || list.length >= THREAD_FILES_MAX) continue;
      list.push({ messageId: r.id, id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size });
    }
    out.set(r.thread_id, list);
  }
  return out;
}

/** Forget Chord's local Gmail mirror + sync state, and stop using the token
 *  for mail. The token itself is not revoked — it is shared with Calendar,
 *  and Google has no per-scope revoke. */
export async function disconnectGmail(db: Kysely<DB>, userId: string): Promise<void> {
  // Every mail path gates on `hasGmailScope`, which reads the STORED scope
  // list. Leaving gmail.modify in it made "disconnect" a wipe the next sync
  // re-imported, with Settings still reading "connected".
  const row = await db
    .selectFrom('users')
    .select('refresh_token_scopes')
    .where('id', '=', userId)
    .executeTakeFirst();
  const remaining = (row?.refresh_token_scopes ?? '')
    .split(/\s+/)
    .filter((s) => s && !s.startsWith('https://www.googleapis.com/auth/gmail.'))
    .join(' ');
  // ADR 0312 — what this mailbox's mail produced goes with it. Before the
  // threads go: attachment-filed trips are traced through them.
  const { purgeMailboxData } = await import('../email/mailbox-purge.js');
  await purgeMailboxData(db, userId, { kind: 'primary' });
  // ADR 0080 — attached accounts keep their mirrors; only Gmail rows go.
  await db
    .deleteFrom('email_threads')
    .where('user_id', '=', userId)
    .where('account_id', 'is', null)
    .execute();
  await db.deleteFrom('email_categories').where('user_id', '=', userId).execute();
  await db
    .updateTable('users')
    .set({
      gmail_history_id: null,
      gmail_synced_at: null,
      gmail_backfill_done: 0,
      gmail_reconnect_nudged_at: null,
      gmail_mirror_provider: null,
      ...(row?.refresh_token_scopes ? { refresh_token_scopes: remaining } : {}),
    })
    .where('id', '=', userId)
    .execute();
  await gmailBackfillProgress.set(db, userId, null);
  const { forgetPrimaryGmailAddress } = await import('../email/primary-gmail-address.js');
  await forgetPrimaryGmailAddress(db, userId);
}

/**
 * The Gmail label id for `name` (e.g. `Chord/Family`), made only the first
 * time: null when the user deleted it in Gmail (ADR 0303 addendum), unless
 * `explicit` - a person asking for it now - which makes it again.
 */
export async function ensureLabel(
  db: Kysely<DB>,
  userId: string,
  name: string,
  opts: { explicit?: boolean } = {},
): Promise<string | null> {
  const api = await getGmailApi(db, userId);
  const cached = await cachedGmailLabels(db, userId, api);
  const labels = [...cached];
  const label = await chordGmailLabel(db, userId, mailboxKeyOf(null), api, labels, name, opts);
  // The cached list is missing a label this just made or just found in Gmail.
  if (labels.length !== cached.length) forgetGmailLabels(db, userId);
  return label?.id ?? null;
}

export type { EmailThreadsTable, EmailMessagesTable };
