/**
 * Outlook / Microsoft 365 mailbox sync + write-back (ADR 0080). Mirrors the
 * Gmail service shape: delta-based sync into the shared email_threads /
 * email_messages mirror, lazy bodies on thread open, reply via the Graph
 * `reply` action, read/archive write-back. Provider ids are stored
 * account-prefixed; labels are synthesized (INBOX/UNREAD/SENT) so
 * aggregateThread and every listing surface work unchanged.
 */
import type { Kysely } from 'kysely';

import {
  addressOf,
  hasInlineImageRefs,
  parseAuthenticationResults,
  replyAddressOf,
  type SenderAuth,
  type EmailAttachmentRef,
  type EmailSyncResult,
  type EmailThreadDetail,
  type EmailThreadSummary,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { keepAttachmentIds } from '../email/attachment-ids.js';
import { sealMessageContent } from '../email/content-seal.js';
import { senderHeaderColumns } from '../email/sender-check/columns.js';
import type { DB } from '../../db/schema.js';
import { forEachConcurrent, mapConcurrent } from '../../utils/concurrency.js';
import { newId } from '../../utils/ids.js';
import { bodyExcerpt, cleanSnippet, modelBodyText } from '../../utils/email-text.js';
import {
  afterSync,
  applyLocalThreadLabels,
  TRASH_DELTA,
  emitEmailSynced,
  ensureThreadRow,
  getThreadWith,
  isGoneError,
  recomputeThread,
  replyAnchor,
  upsertMessageMeta,
  type ReadWriteOpts,
} from '../google/gmail.service.js';
import { clearReadWrite, queueReadWrite } from '../email/read-pending.js';
import {
  replySubject,
  type NormalizedMessage,
} from '../google/gmail-sync.js';
import {
  MailboxWriteUnsupportedError,
  nativeId,
  scopedId,
  syntheticLabels,
  updateAccountSync,
  type AccountRow,
} from './account-utils.js';
import {
  getOutlookApi,
  outlookAttachmentRef,
  type GraphMessage,
  type OutlookApi,
} from './outlook-api.js';
import { claimMirrorRow } from './mirror-identity.js';
import { composedBodies, mailboxSignatureRow, type ComposedBody } from '../email/signature.js';
import { FolderRemovedError } from '../email/mailbox-folder-memory.js';

function recipientEmail(r?: { emailAddress?: { name?: string; address?: string } }): {
  name: string | null;
  email: string | null;
} {
  return {
    name: r?.emailAddress?.name ?? null,
    email: r?.emailAddress?.address?.toLowerCase() ?? null,
  };
}

function isoOrNow(s: string | undefined): string {
  const ms = s ? Date.parse(s) : NaN;
  return new Date(Number.isNaN(ms) ? Date.now() : ms).toISOString();
}

/** Normalize a Graph message into the shared mirror shape (bodies lazy). */
export function normalizeGraphMessage(
  accountId: string,
  m: GraphMessage,
  folder: 'inbox' | 'sentitems' = 'inbox',
): NormalizedMessage {
  const from = recipientEmail(m.from);
  const bodies = graphBodies(m);
  return {
    gmailMessageId: scopedId(accountId, m.id),
    gmailThreadId: scopedId(accountId, m.conversationId ?? m.id),
    fromName: from.name,
    fromEmail: from.email,
    toEmails: (m.toRecipients ?? []).map((r) => recipientEmail(r).email).filter((e): e is string => !!e),
    ccEmails: (m.ccRecipients ?? []).map((r) => recipientEmail(r).email).filter((e): e is string => !!e),
    subject: m.subject ?? '',
    snippet: cleanSnippet(m.bodyPreview),
    bodyText: bodies.text,
    bodyHtml: bodies.html,
    // Graph's delta carries bodyPreview and no body, so an excerpt only
    // appears on a thread-open fetch — undefined leaves the column alone.
    bodyExcerpt:
      bodies.text === null && bodies.html === null
        ? undefined
        : bodyExcerpt(modelBodyText(bodies)),
    // Graph sends whole seconds ("…:00Z"); every other provider stores
    // toISOString's ".000Z", and these sort as text beside each other.
    internalDate: isoOrNow(m.receivedDateTime),
    isUnread: m.isRead === false,
    labelIds: syntheticLabels(
      folder === 'sentitems'
        ? { inInbox: false, unread: false, sent: true }
        : { inInbox: true, unread: m.isRead === false },
    ),
    rfc822MessageId: m.internetMessageId ?? null,
    // Absent on the delta, present on a thread open. Left undefined rather
    // than null so a later delta cannot wipe what the open discovered.
    ...(m.internetMessageHeaders
      ? {
          listUnsubscribe: graphHeader(m, 'list-unsubscribe'),
          listUnsubscribePost: graphHeader(m, 'list-unsubscribe-post'),
          ...graphSenderHeaders(m),
        }
      : {}),
    headers: { references: null, inReplyTo: null, date: m.receivedDateTime ?? null },
  };
}

/** ADR 0294 — Reply-To and the topmost Authentication-Results, as columns. */
function graphSenderHeaders(m: GraphMessage): { replyTo: string | null; authResults: SenderAuth | null } {
  const replyTo = graphHeader(m, 'reply-to');
  return {
    replyTo: replyTo ? addressOf(replyTo) : null,
    authResults: parseAuthenticationResults(graphHeader(m, 'authentication-results')),
  };
}

function graphHeader(m: GraphMessage, name: string): string | null {
  const hit = (m.internetMessageHeaders ?? []).find(
    (h) => (h.name ?? '').toLowerCase() === name,
  );
  return hit?.value?.trim() || null;
}

function graphBodies(m: GraphMessage): { text: string | null; html: string | null } {
  if (!m.body?.content) return { text: null, html: null };
  return m.body.contentType === 'html'
    ? { text: null, html: m.body.content }
    : { text: m.body.content, html: null };
}

/**
 * Graph's delta reports a change to a message it already sent as `id` plus
 * only the changed properties (`{ id, isRead }` once it is read anywhere).
 * Normalizing that as a whole message stored an empty subject, a null sender,
 * no recipients and a sync-time date over the real ones — the reply composer
 * then had nobody to address. `receivedDateTime` never changes and is on
 * every full delta item, so its absence marks a partial one; fetch the whole
 * resource instead. null = the message is gone, nothing to write.
 */
async function completeDeltaItem(api: OutlookApi, m: GraphMessage): Promise<GraphMessage | null> {
  if (m.receivedDateTime !== undefined) return m;
  return api.getMessage(m.id);
}

/**
 * Repair rows a partial delta item already blanked (see completeDeltaItem).
 * A real message always has a sender; a locally-synthesized sent reply
 * (`sent-…`) never had a Graph resource to re-read.
 */
async function healBlankedMessages(
  db: Kysely<DB>,
  api: OutlookApi,
  account: AccountRow,
  threadRowId: string,
): Promise<Map<string, GraphMessage>> {
  const fetched = new Map<string, GraphMessage>();
  const blanked = await db
    .selectFrom('email_messages')
    .select(['gmail_message_id', 'gmail_label_ids'])
    .where('thread_id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .where('from_email', 'is', null)
    .execute();
  const touched = new Set<string>();
  const now = new Date().toISOString();
  for (const row of blanked) {
    const native = nativeId(account.id, row.gmail_message_id);
    if (native.startsWith('sent-')) continue;
    try {
      const full = await api.getMessage(native);
      if (!full) continue;
      fetched.set(native, full);
      const labels = Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : [];
      const normalized = normalizeGraphMessage(
        account.id,
        full,
        labels.includes('SENT') ? 'sentitems' : 'inbox',
      );
      // Where the message lives is still right on the row; only its content
      // was blanked. Re-deriving INBOX here would un-archive it.
      const nm = labels.includes('INBOX')
        ? normalized
        : { ...normalized, labelIds: normalized.labelIds.filter((l) => l !== 'INBOX') };
      await upsertMessageMeta(db, account.user_id, threadRowId, nm, now, account.id);
      touched.add(nm.gmailThreadId);
    } catch (err) {
      logger.warn('outlook blanked-message repair failed', {
        accountId: account.id,
        err: (err as Error).message,
      });
    }
  }
  for (const tid of touched) await recomputeThread(db, account.user_id, tid);
  return fetched;
}

/**
 * Resolve one page's `@removed` entries. A single batched `IN (...)` lookup
 * replaces one SELECT per id, and the removal-state probes (Graph calls) run
 * bounded-concurrent instead of sequentially — the wall-clock-bound part of
 * the original loop, same as the message-fetch loops in gmail.service.ts.
 */
async function resolveRemovals(
  db: Kysely<DB>,
  api: OutlookApi,
  account: AccountRow,
  removedIds: string[],
): Promise<{ touchedThreadIds: string[]; deletedCount: number }> {
  const scopedIds = removedIds.map((id) => scopedId(account.id, id));
  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'thread_id', 'gmail_thread_id', 'gmail_label_ids', 'gmail_message_id', 'rfc822_message_id'])
    .where('user_id', '=', account.user_id)
    .where('gmail_message_id', 'in', scopedIds)
    .execute();
  const rowByScopedId = new Map(rows.map((r) => [r.gmail_message_id, r]));
  const candidates = removedIds
    .map((id) => ({ id, row: rowByScopedId.get(scopedId(account.id, id)) }))
    .filter((c): c is { id: string; row: (typeof rows)[number] } => !!c.row);
  if (candidates.length === 0) return { touchedThreadIds: [], deletedCount: 0 };

  // Archive and delete look identical in the delta feed, but only a DELETE
  // should retract the thread's pending to-dos (ADR 0073). Probe where each
  // went; a probe failure degrades to archive, the non-destructive reading.
  const states = await mapConcurrent(candidates, env.GMAIL_FETCH_CONCURRENCY, async ({ id, row }) => {
    try {
      const state = await api.getRemovalState(id);
      if (state !== 'gone' || !row.rfc822_message_id) return state;
      // Graph gives a message a new id when it moves folders, so the stored
      // id 404s for a move to Junk (Microsoft's filter often acts minutes
      // after delivery) or an archive as surely as for a purge. Find it by
      // its Message-ID before calling it deleted (docs/notes/0199).
      const current = await api.findIdByInternetMessageId(row.rfc822_message_id, 'received');
      return current ? await api.getRemovalState(current) : state;
    } catch (err) {
      logger.warn('outlook removal probe failed — treating as archived', {
        accountId: account.id,
        err: (err as Error).message,
      });
      return 'moved' as const;
    }
  });

  const touchedThreadIds: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const { row } = candidates[i];
    if (states[i] === 'moved' || states[i] === 'junk') {
      const kept = (Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : []).filter(
        (l) => l !== 'INBOX',
      );
      await db
        .updateTable('email_messages')
        .set({
          // Junk keeps the row, labelled the way Gmail labels spam, so the
          // shared recompute retires what the email produced.
          gmail_label_ids: JSON.stringify(states[i] === 'junk' ? [...kept, 'SPAM'] : kept),
        })
        .where('id', '=', row.id)
        .execute();
    } else {
      // Gone for real: dropping the row lets the shared recomputeThread reap
      // the thread and retract its pending proposals.
      await db.deleteFrom('email_messages').where('id', '=', row.id).execute();
    }
    touchedThreadIds.push(row.gmail_thread_id);
  }
  return { touchedThreadIds, deletedCount: candidates.length };
}

/**
 * Delta sync over the Inbox folder. `@removed` entries (archived / deleted /
 * moved out of Inbox on the Outlook side) drop the INBOX label locally, which
 * marks the thread archived (hidden everywhere, ADR 0073 semantics). On a 410
 * resync the delta restarts from scratch — upserts are idempotent.
 */
export async function syncOutlookAccount(
  db: Kysely<DB>,
  account: AccountRow,
): Promise<EmailSyncResult> {
  const api = await getOutlookApi(db, account);
  const now = new Date().toISOString();
  // One cursor per folder. The old single-key shape still parses, so an
  // account synced before ADR 0116 keeps its inbox position and picks up
  // Sent from scratch on the next tick.
  const cursor = account.sync_cursor
    ? (JSON.parse(account.sync_cursor) as { deltaLink?: string; sentDeltaLink?: string })
    : null;

  const nextCursor: { deltaLink?: string; sentDeltaLink?: string } = {
    deltaLink: cursor?.deltaLink,
    sentDeltaLink: cursor?.sentDeltaLink,
  };
  let inserted = 0;
  let deleted = 0;
  const touched = new Set<string>();

  // Inbox, then Sent — so a mailbox mirrors what Gmail's does, and the
  // ADR 0108 Sent folder holds real sent mail rather than only what Chord
  // itself sent.
  for (const folder of ['inbox', 'sentitems'] as const) {
    let link: string | null =
      (folder === 'inbox' ? cursor?.deltaLink : cursor?.sentDeltaLink) ?? null;
    let deltaLink: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await api.deltaPage(link, env.GMAIL_BACKFILL_DAYS, folder);
      if (page.resync) {
        logger.info('outlook delta token expired — resyncing', { accountId: account.id });
        link = null;
        continue;
      }
      const removedIds: string[] = [];
      for (const m of page.messages) {
        if (m['@removed']) {
          removedIds.push(m.id);
          continue;
        }
        const full = await completeDeltaItem(api, m);
        if (!full) continue;
        const nm = normalizeGraphMessage(account.id, full, folder);
        const threadRowId = await ensureThreadRow(
          db,
          account.user_id,
          nm.gmailThreadId,
          now,
          account.id,
        );
        // A message moved back into the Inbox arrives under a new Graph id,
        // and Chord's own reply under a placeholder: both already have a row.
        const claim = await claimMirrorRow(db, account.user_id, account.id, threadRowId, nm);
        if (claim.leftThread) touched.add(claim.leftThread);
        await upsertMessageMeta(db, account.user_id, threadRowId, nm, now, account.id);
        touched.add(nm.gmailThreadId);
        inserted += 1;
      }
      if (removedIds.length > 0) {
        const { touchedThreadIds, deletedCount } = await resolveRemovals(db, api, account, removedIds);
        for (const tid of touchedThreadIds) touched.add(tid);
        deleted += deletedCount;
      }
      if (page.nextLink) {
        link = page.nextLink;
        continue;
      }
      deltaLink = page.deltaLink;
      break;
    }
    if (deltaLink) {
      if (folder === 'inbox') nextCursor.deltaLink = deltaLink;
      else nextCursor.sentDeltaLink = deltaLink;
    }
  }

  for (const tid of touched) await recomputeThread(db, account.user_id, tid);

  await updateAccountSync(db, account.id, {
    sync_cursor: JSON.stringify(nextCursor),
    backfill_done: 1,
    synced_at: now,
  });
  await db
    .updateTable('email_accounts')
    .set({ status: 'ok' })
    .where('id', '=', account.id)
    .execute();

  logger.info(`outlook sync account=${account.id} messages=${inserted} removed=${deleted}`);
  await afterSync(db, account.user_id);
  const result: EmailSyncResult = { inserted, updated: 0, deleted, backfillDone: true };
  emitEmailSynced(account.user_id, result);
  return result;
}

/** Lazy body fetch for an Outlook thread (mirrors the Gmail path). */
export async function getOutlookThread(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
): Promise<EmailThreadDetail | null> {
  const api = await getOutlookApi(db, account);
  // A message the repair just read in full is not read from Graph again below.
  const healed = await healBlankedMessages(db, api, account, threadRowId);
  return getThreadWith(db, account.user_id, threadRowId, async (missing) => {
    // A few at a time, as the Gmail path does: one after another, a long
    // thread waited on Graph once per message.
    await forEachConcurrent(missing, OUTLOOK_BODY_FETCH_CONCURRENCY, async (m) => {
      // Locally-synthesized sent replies have no fetchable Graph id — settle
      // their attachment state so they don't count as missing forever.
      const native = nativeId(account.id, m.gmail_message_id);
      if (native.startsWith('sent-')) {
        await db
          .updateTable('email_messages')
          .set({ attachments_json: '[]' })
          .where('id', '=', m.id)
          .where('attachments_json', 'is', null)
          .execute();
        return;
      }
      try {
        const raw = healed.get(native) ?? (await api.getMessage(native));
        if (!raw) return;
        const bodies = graphBodies(raw);
        // Graph's hasAttachments ignores inline parts, so a body that points
        // at a `cid:` image has to list them anyway or the image never renders.
        const atts = keepAttachmentIds(
          m.attachments_json,
          raw.hasAttachments || hasInlineImageRefs(bodies.html)
            ? (await api.listAttachments(native)).map(outlookAttachmentRef)
            : [],
        );
        await db
          .updateTable('email_messages')
          .set(
            {
              ...(await sealMessageContent(account.user_id, {
                body_text: bodies.text,
                body_html: bodies.html,
                attachments_json: JSON.stringify(atts),
              })),
              cid_parts_checked: 1,
              // The open is the only fetch that carries Graph's headers.
              ...(raw.internetMessageHeaders ? senderHeaderColumns(graphSenderHeaders(raw)) : {}),
            },
          )
          .where('id', '=', m.id)
          .execute();
      } catch (err) {
        logger.warn('outlook body fetch failed', {
          accountId: account.id,
          id: m.id,
          err: (err as Error).message,
        });
      }
    });
  });
}

const OUTLOOK_BODY_FETCH_CONCURRENCY = 4;

/** Compose a new message through Graph sendMail (ADR 0107). */
export async function sendOutlookNew(
  db: Kysely<DB>,
  account: AccountRow,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: { filename: string; mimeType: string; content: Buffer }[] } & Omit<ComposedBody, 'body'>,
): Promise<{ fromEmail: string }> {
  const me = await mailboxSignatureRow(db, account.user_id, account.id);
  const { html: htmlBody } = composedBodies(input, me); // Graph takes html only
  const api = await getOutlookApi(db, account);
  await api.sendNew({
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    html: htmlBody,
    attachments: input.attachments,
  });
  return { fromEmail: account.email_address };
}
/** Reply via the Graph `reply` action; the sent copy is upserted locally. */
export async function sendOutlookReply(
  db: Kysely<DB>,
  account: AccountRow,
  input: { threadRowId: string; body: string; to?: string[]; cc?: string[]; bcc?: string[]; attachments?: { filename: string; mimeType: string; content: Buffer }[]; messageId?: string; markRead?: boolean; autoReply?: boolean } & Omit<ComposedBody, 'body'>,
): Promise<EmailThreadDetail | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'subject'])
    .where('id', '=', input.threadRowId)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!thread) return null;

  // Graph replies TO a message it can address, and one Chord sent itself has
  // only a placeholder id until the next sync - so an own message is never the
  // anchor here.
  const picked = await replyAnchor(db, account.user_id, thread.id, {
    messageId: input.messageId,
    ownAddress: account.email_address,
  });
  const latest =
    picked && picked.from_email?.toLowerCase() === account.email_address.toLowerCase()
      ? await replyAnchor(db, account.user_id, thread.id, { ownAddress: account.email_address })
      : picked;
  if (!latest) return null;

  const me = await mailboxSignatureRow(db, account.user_id, account.id);
  const { text: textBody, html: htmlBody } = composedBodies(input, me);

  const replyAddress = replyAddressOf({ fromEmail: latest.from_email, replyTo: latest.reply_to }, account.email_address);
  const to = input.to?.length ? input.to : replyAddress ? [replyAddress] : [];
  const api = await getOutlookApi(db, account);
  await api.reply(
    nativeId(account.id, latest.gmail_message_id),
    htmlBody,
    { to, cc: input.cc, bcc: input.bcc },
    input.attachments,
  );

  const now = new Date().toISOString();
  const nm: NormalizedMessage = {
    gmailMessageId: scopedId(account.id, `sent-${newId('emm')}`),
    gmailThreadId: thread.gmail_thread_id,
    fromName: account.display_name,
    fromEmail: account.email_address,
    toEmails: to,
    ccEmails: input.cc ?? [],
    subject: replySubject(thread.subject || latest.subject || ''),
    snippet: input.body.slice(0, 120),
    bodyText: textBody,
    bodyHtml: htmlBody,
    internalDate: now,
    isUnread: false,
    labelIds: syntheticLabels({ inInbox: false, unread: false, sent: true }),
    rfc822MessageId: null,
    headers: { references: null, inReplyTo: null, date: null },
    attachmentsJson: '[]',
    autoReply: input.autoReply === true,
  };
  await upsertMessageMeta(db, account.user_id, thread.id, nm, now, account.id);
  // ADR 0124 - an auto-reply is not reading.
  if (input.markRead !== false) {
    await applyOutlookThreadModify(db, account, thread.id, { markRead: true });
  }
  return getOutlookThread(db, account, thread.id);
}

/**
 * Read/archive write-back for an Outlook thread. Gmail label operations
 * (addLabelIds / applyCategoryLabel) have no Graph equivalent and are
 * ignored provider-side; the local mirror still converges via the shared
 * label-delta application.
 */
export async function applyOutlookThreadModify(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  patch: { markRead?: boolean; archive?: boolean; trash?: boolean; messageIds?: string[] },
  opts: ReadWriteOpts = {},
): Promise<EmailThreadSummary | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!thread) return null;

  if (patch.trash === true) return trashOutlookThread(db, account, thread);

  const add: string[] = [];
  const remove: string[] = [];
  if (patch.markRead === true) remove.push('UNREAD');
  if (patch.markRead === false) add.push('UNREAD');
  if (patch.archive === true) remove.push('INBOX');
  if (patch.archive === false) add.push('INBOX');

  const only = patch.messageIds ? new Set(patch.messageIds) : null;
  const msgs = (
    await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_message_id', 'rfc822_message_id', 'gmail_label_ids'])
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', account.user_id)
      .execute()
  ).filter((m) => !only || only.has(m.id));
  let readOwed: unknown = null;
  let api: OutlookApi | null = null;
  try {
    api = await getOutlookApi(db, account);
  } catch (err) {
    // No token to write with: the read-state is still owed (docs/notes/0199);
    // an archive has nothing to fall back to and fails as before.
    if (patch.archive !== undefined) throw err;
    readOwed = err;
  }
  for (const m of api ? msgs : []) {
    if (nativeId(account.id, m.gmail_message_id).startsWith('sent-')) continue;
    if (patch.markRead !== undefined) {
      const read = patch.markRead;
      try {
        await withCurrentGraphId(db, api!, account, m, (id) => api!.setRead(id, read));
      } catch (err) {
        logger.warn('outlook read-state write failed', {
          accountId: account.id,
          err: (err as Error).message,
        });
        readOwed = err;
      }
    }
    if (patch.archive !== undefined) {
      try {
        // Both directions reach the server. Un-archive used to be local-only, so
        // a thread restored in Chord stayed filed away everywhere else (ADR 0107).
        await withCurrentGraphId(db, api!, account, m, (id) =>
          patch.archive ? api!.archive(id) : api!.moveToInbox(id),
        );
      } catch (err) {
        logger.warn('outlook modify failed', { accountId: account.id, err: (err as Error).message });
        throw new MailboxWriteUnsupportedError(
          patch.archive
            ? 'could not archive this message in Outlook'
            : 'could not move this message back to the inbox',
        );
      }
    }
  }

  if (only) {
    // Single messages are the caller's to retry: ADR 0199 holds a thread intent.
    if (readOwed !== null) throw readOwed;
    return applyLocalThreadLabels(
      db,
      account.user_id,
      thread.id,
      thread.gmail_thread_id,
      add,
      remove,
      msgs.map((m) => m.id),
    );
  }
  if (patch.markRead !== undefined) {
    if (readOwed !== null) {
      if (opts.fromRetry) throw readOwed;
      await queueReadWrite(db, account.user_id, thread.id, !patch.markRead, readOwed);
    } else {
      await clearReadWrite(db, thread.id);
    }
  }
  return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove);
}

/** ADR 0215 — every message of the thread into Deleted Items. */
async function trashOutlookThread(
  db: Kysely<DB>,
  account: AccountRow,
  thread: { id: string; gmail_thread_id: string },
): Promise<EmailThreadSummary | null> {
  const msgs = await db
    .selectFrom('email_messages')
    .select(['id', 'gmail_message_id', 'rfc822_message_id', 'gmail_label_ids'])
    .where('thread_id', '=', thread.id)
    .where('user_id', '=', account.user_id)
    .execute();
  const api = await getOutlookApi(db, account);
  for (const m of msgs) {
    if (nativeId(account.id, m.gmail_message_id).startsWith('sent-')) continue;
    try {
      await withCurrentGraphId(db, api, account, m, (id) => api.trash(id));
    } catch (err) {
      logger.warn('outlook trash failed', { accountId: account.id, err: (err as Error).message });
      throw new MailboxWriteUnsupportedError('could not move this message to Trash in Outlook');
    }
  }
  return applyLocalThreadLabels(
    db,
    account.user_id,
    thread.id,
    thread.gmail_thread_id,
    ...TRASH_DELTA,
  );
}

/**
 * ADR 0309 — file a thread's inbox messages into the folder named `folder`,
 * made if missing. The thread then leaves the Chord inbox the way an archive
 * does. Nothing is filed when nothing of the thread is still in the inbox.
 */
export async function fileOutlookThread(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  folder: string,
  /** Per-pass cache of resolved folder ids, keyed by folder name. */
  folderIds?: Map<string, string>,
  /** `create: false`: a missing folder throws FolderRemovedError, not made. */
  opts?: { create?: boolean },
): Promise<EmailThreadSummary | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!thread) return null;
  const msgs = (
    await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_message_id', 'rfc822_message_id', 'gmail_label_ids'])
      .where('thread_id', '=', thread.id)
      .where('user_id', '=', account.user_id)
      .execute()
  ).filter(
    (m) =>
      Array.isArray(m.gmail_label_ids) &&
      m.gmail_label_ids.includes('INBOX') &&
      !nativeId(account.id, m.gmail_message_id).startsWith('sent-'),
  );
  if (msgs.length === 0) return null;
  const api = await getOutlookApi(db, account);
  const folderId = folderIds?.get(folder) ?? (await api.ensureFolder(folder, opts));
  if (!folderId) throw new FolderRemovedError(folder);
  folderIds?.set(folder, folderId);
  for (const m of msgs) {
    try {
      await withCurrentGraphId(db, api, account, m, (id) => api.moveToFolder(id, folderId));
    } catch (err) {
      logger.warn('outlook file failed', { accountId: account.id, err: (err as Error).message });
      throw new MailboxWriteUnsupportedError(`could not move this message to "${folder}" in Outlook`);
    }
  }
  return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, [], ['INBOX']);
}

/**
 * Run a Graph write against a stored message id, re-finding the message when
 * that id has gone stale. Outlook gives a message a NEW id when it moves to
 * another folder (archived in Outlook), so every write to a moved message 404'd
 * — forever, since retrying the same id cannot succeed (docs/notes/0199, prod:
 * ErrorItemNotFound on archived mail). The RFC 822 Message-ID does not change,
 * so it finds the current id, which is stored for next time. A message that is
 * found nowhere has been deleted: there is nothing left to write to.
 */
async function withCurrentGraphId(
  db: Kysely<DB>,
  api: OutlookApi,
  account: AccountRow,
  row: {
    id: string;
    gmail_message_id: string;
    rfc822_message_id: string | null;
    gmail_label_ids: string[] | null;
  },
  write: (graphId: string) => Promise<void>,
): Promise<void> {
  const stored = nativeId(account.id, row.gmail_message_id);
  try {
    await write(stored);
    return;
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }
  const current = await refindGraphMessage(api, row);
  if (!current) return;
  await write(current);
  if (current !== stored) await storeCurrentGraphId(db, account, row, current);
}

type GraphMessageRow = {
  id: string;
  gmail_message_id: string;
  rfc822_message_id: string | null;
  gmail_label_ids: string[] | null;
};

/** The message's id now, found by its RFC 822 Message-ID (which a move does
 *  not change); null when it is gone from the mailbox. */
async function refindGraphMessage(api: OutlookApi, row: GraphMessageRow): Promise<string | null> {
  if (!row.rfc822_message_id) return null;
  // A message sent to yourself has a Sent copy and a received copy under one
  // Message-ID; each row must find its own.
  const copy =
    Array.isArray(row.gmail_label_ids) && row.gmail_label_ids.includes('SENT') ? 'sent' : 'received';
  return api.findIdByInternetMessageId(row.rfc822_message_id, copy);
}

/**
 * An attachment whose stored ids stopped working. Outlook re-issues a message's
 * id when it moves folders, and its attachments' ids with it, so a download by
 * the stored ids 404'd for good. The message is found again, its parts are
 * listed and stored, and the asked-for part is matched by id, else by name and
 * size. Null when the message or the part is gone.
 */
export async function refindOutlookAttachment(
  db: Kysely<DB>,
  api: OutlookApi,
  account: AccountRow,
  row: GraphMessageRow,
  wanted: Pick<EmailAttachmentRef, 'id'> & Partial<EmailAttachmentRef>,
): Promise<{ graphId: string; attId: string } | null> {
  const stored = nativeId(account.id, row.gmail_message_id);
  const current = (await refindGraphMessage(api, row)) ?? stored;
  const parts = (await api.listAttachments(current)).map(outlookAttachmentRef);
  if (parts.length === 0) return null;
  await db
    .updateTable('email_messages')
    .set(await sealMessageContent(account.user_id, { attachments_json: JSON.stringify(parts) }))
    .where('id', '=', row.id)
    .execute();
  const part =
    parts.find((p) => p.id === wanted.id) ??
    parts.find((p) => p.filename === wanted.filename && p.size === wanted.size) ??
    (parts.filter((p) => p.filename === wanted.filename).length === 1
      ? parts.find((p) => p.filename === wanted.filename)
      : undefined);
  if (!part) return null;
  if (current !== stored) await storeCurrentGraphId(db, account, row, current);
  return { graphId: current, attId: part.id };
}

/** Point the row at the message's current id; a twin already holding that id
 *  is the live copy, and this row is removed instead (docs/notes/0199). */
async function storeCurrentGraphId(
  db: Kysely<DB>,
  account: AccountRow,
  row: GraphMessageRow,
  current: string,
): Promise<void> {
  const live = await db
    .selectFrom('email_messages')
    .select('id')
    .where('user_id', '=', account.user_id)
    .where('gmail_message_id', '=', scopedId(account.id, current))
    .executeTakeFirst();
  if (!live) {
    await db
      .updateTable('email_messages')
      .set({ gmail_message_id: scopedId(account.id, current) })
      .where('id', '=', row.id)
      .execute();
    return;
  }
  // A twin written before syncs adopted moved messages (docs/notes/0199
  // addendum): the row under the current id is the live copy, this one is not.
  const stale = await db
    .deleteFrom('email_messages')
    .where('id', '=', row.id)
    .returning('gmail_thread_id')
    .executeTakeFirst();
  if (stale) await recomputeThread(db, account.user_id, stale.gmail_thread_id);
}
