/**
 * Secondary Gmail mailboxes (ADR 0080 addendum). The primary Gmail (login +
 * calendar anchor) stays on `users`; each additional Gmail is an
 * email_accounts row with its own sealed refresh token and historyId cursor.
 * Reuses the existing GmailApi seam verbatim — only the token source and the
 * cursor store differ from the primary path. Ids are account-prefixed like
 * every other provider.
 */
import type { Kysely } from 'kysely';

import { replyAddressOf, type EmailThreadDetail, type EmailThreadSummary } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { keepAttachmentIds } from '../email/attachment-ids.js';
import { sealMessageContent } from '../email/content-seal.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import {
  mockGmailApi,
  realGmailApi,
  type GmailApi,
} from '../google/gmail-api.js';
import {
  applyLabelDelta,
  buildReplyRaw,
  diffHistory,
  extractBodies,
  listAttachmentParts,
  toAttachmentRef,
  normalizeMessage,
  withoutBody,
  replySubject,
  type GmailHistoryRecord,
  type NormalizedMessage,
} from '../google/gmail-sync.js';
import { GoogleAuthError, refreshAccessTokenWith } from '../google/oauth.service.js';
import {
  afterSync,
  applyLocalThreadLabels,
  threadMessagesIn,
  TRASH_DELTA,
  emitEmailSynced,
  ensureThreadRow,
  getThreadWith,
  isGoneError,
  isReadOnlyDelta,
  parseBackfillProgress,
  recomputeThread,
  replyAnchor,
  runGmailBackfill,
  toNameFor,
  upsertMessageMeta,
  type GmailBackfillProgress,
  type PausableSyncResult,
  type ReadWriteOpts,
} from '../google/gmail.service.js';
import { clearReadWrite, queueReadWrite } from '../email/read-pending.js';
import {
  AccountAuthError,
  markAccountReconnect,
  nativeId,
  openAuthBlob,
  scopedId,
  updateAccountSync,
  type AccountRow,
} from './account-utils.js';
import { withQuotedOriginal } from '../email/reply-quote.js';
import { composedBodies, mailboxSignatureRow, type ComposedBody } from '../email/signature.js';
import { runInBackground } from '../../utils/background.js';

/** Auth blob for a secondary Gmail: refresh token + the client it's bound to. */
export interface GmailAccountAuth {
  refreshToken: string;
  clientId: string;
}

export async function gmailAccountApi(db: Kysely<DB>, account: AccountRow): Promise<GmailApi> {
  return apiFor(db, account);
}

async function apiFor(db: Kysely<DB>, account: AccountRow): Promise<GmailApi> {
  if (env.GMAIL_PROVIDER === 'mock') return mockGmailApi(account.id);
  const auth = openAuthBlob<GmailAccountAuth>(account);
  try {
    return realGmailApi(
      await refreshAccessTokenWith(auth.refreshToken, auth.clientId, (scopes) =>
        noteCalendarGrant(db, account, scopes),
      ),
    );
  } catch (err) {
    if (err instanceof GoogleAuthError && err.needsReconnect) {
      await markAccountReconnect(db, account.id);
      throw new AccountAuthError(`gmail account ${account.id} token dead`, {
        needsReconnect: true,
      });
    }
    throw err;
  }
}

/** ADR 0313 — the mailbox's calendar follows its grant; never fails the mail work. */
function noteCalendarGrant(db: Kysely<DB>, account: AccountRow, scopes: string): void {
  runInBackground(
    import('../gmail-calendar/grant.js')
      .then((m) => m.noteGmailCalendarGrant(db, account, scopes))
      .catch((err) =>
        logger.warn('gmail account calendar grant check failed', {
          accountId: account.id,
          err: (err as Error).message,
        }),
      ),
  );
}

/** Compose a new message from a SECONDARY Gmail mailbox (ADR 0107). */
export async function sendGmailAccountNew(
  db: Kysely<DB>,
  account: AccountRow,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: { filename: string; mimeType: string; content: Buffer }[] } & Omit<ComposedBody, 'body'>,
): Promise<{ fromEmail: string }> {
  const me = await mailboxSignatureRow(db, account.user_id, account.id);
  const newBodies = composedBodies(input, me);
  const textBody = newBodies.text;
  const htmlBody = newBodies.plain ? undefined : newBodies.html;
  const raw = buildReplyRaw({
    fromEmail: account.email_address,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    inReplyTo: null,
    references: null,
    body: textBody,
    htmlBody,
    attachments: input.attachments,
  });
  const api = await apiFor(db, account);
  await api.sendMessage(raw);
  return { fromEmail: account.email_address };
}
/** Prefix a normalized message's native ids with the owning account. */
function scopeMessage(accountId: string, nm: NormalizedMessage): NormalizedMessage {
  return {
    ...nm,
    gmailMessageId: scopedId(accountId, nm.gmailMessageId),
    gmailThreadId: scopedId(accountId, nm.gmailThreadId),
  };
}

/**
 * `email_accounts.sync_cursor` for a Gmail account. `backfill` is set while a
 * backfill is unfinished (ADR 0206 addendum); `historyId` is then the
 * mailbox's historyId from when it began.
 */
interface GmailCursor {
  historyId: string | null;
  backfill: GmailBackfillProgress | null;
}

function parseCursor(raw: string | null): GmailCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { historyId?: unknown; backfill?: unknown };
    return {
      historyId: typeof parsed.historyId === 'string' ? parsed.historyId : null,
      backfill: parseBackfillProgress(parsed.backfill),
    };
  } catch {
    return null;
  }
}

async function readCursor(db: Kysely<DB>, accountId: string): Promise<GmailCursor | null> {
  const row = await db
    .selectFrom('email_accounts')
    .select('sync_cursor')
    .where('id', '=', accountId)
    .executeTakeFirst();
  return parseCursor(row?.sync_cursor ?? null);
}

async function writeCursor(db: Kysely<DB>, accountId: string, cursor: GmailCursor): Promise<void> {
  await updateAccountSync(db, accountId, {
    sync_cursor: JSON.stringify({
      ...(cursor.historyId ? { historyId: cursor.historyId } : {}),
      ...(cursor.backfill ? { backfill: cursor.backfill } : {}),
    }),
  });
}

async function backfill(
  db: Kysely<DB>,
  account: AccountRow,
  api: GmailApi,
): Promise<PausableSyncResult> {
  const out = await runGmailBackfill(db, api, {
    userId: account.user_id,
    accountId: account.id,
    localId: (id) => scopedId(account.id, id),
    // Locally-synthesized sent copies are never in a listing under their
    // synthetic id — only real mirror rows reconcile.
    reconcilable: (localId) => !nativeId(account.id, localId).startsWith('sent-'),
    loadProgress: async () => (await readCursor(db, account.id))?.backfill ?? null,
    saveProgress: async (progress) => {
      const cur = await readCursor(db, account.id);
      await writeCursor(db, account.id, { historyId: cur?.historyId ?? null, backfill: progress });
    },
    onStart: async (historyId) => {
      const cur = await readCursor(db, account.id);
      await writeCursor(db, account.id, { historyId, backfill: cur?.backfill ?? null });
    },
  });
  if (out.status === 'paused') {
    return { inserted: out.inserted, updated: 0, deleted: 0, backfillDone: false, pausedBy: out.error };
  }
  await updateAccountSync(db, account.id, {
    ...(out.startHistoryId ? { sync_cursor: JSON.stringify({ historyId: out.startHistoryId }) } : {}),
    backfill_done: 1,
    synced_at: new Date().toISOString(),
  });
  logger.info(`gmail-account backfill account=${account.id} messages=${out.inserted}`);
  return { inserted: out.inserted, updated: out.relabelled, deleted: out.deleted, backfillDone: true };
}

export async function syncGmailAccount(
  db: Kysely<DB>,
  account: AccountRow,
): Promise<PausableSyncResult> {
  const api = await apiFor(db, account);
  const cursor = parseCursor(account.sync_cursor);
  let result: PausableSyncResult;

  if (Number(account.backfill_done) !== 1 || !cursor?.historyId || cursor.backfill) {
    result = await backfill(db, account, api);
  } else {
    const now = new Date().toISOString();
    const records: GmailHistoryRecord[] = [];
    const startHistoryId = cursor.historyId;
    let latestHistory = startHistoryId;
    let pageToken: string | undefined;
    let expired = false;
    do {
      const page = await api.listHistory({ startHistoryId, pageToken });
      if (page.notFound) {
        expired = true;
        break;
      }
      for (const r of page.history ?? []) records.push(r);
      if (page.historyId) latestHistory = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);

    if (expired) {
      logger.info('gmail-account history expired — re-backfilling', { accountId: account.id });
      result = await backfill(db, account, api);
    } else {
      const diff = diffHistory(records);
      const touched = new Set<string>();
      let updated = 0;
      let deleted = 0;

      const addedRaw = await mapConcurrent(diff.addedMessageIds, env.GMAIL_FETCH_CONCURRENCY, (id) =>
        api.getMessage(id, 'full'),
      );
      for (const raw of addedRaw) {
        if (!raw) continue;
        // Spam never enters the mirror (same rule as the primary mailbox).
        if ((raw.labelIds ?? []).includes('SPAM')) continue;
        // Nor does an unsent draft (ADR 0303); it arrives when it is sent.
        if ((raw.labelIds ?? []).includes('DRAFT')) continue;
        const nm = scopeMessage(account.id, withoutBody(normalizeMessage(raw)));
        const threadRowId = await ensureThreadRow(
          db,
          account.user_id,
          nm.gmailThreadId,
          now,
          account.id,
        );
        await upsertMessageMeta(db, account.user_id, threadRowId, nm, now, account.id);
        touched.add(nm.gmailThreadId);
        updated += 1;
      }
      for (const id of diff.deletedMessageIds) {
        const res = await db
          .deleteFrom('email_messages')
          .where('account_id', '=', account.id)
          .where('gmail_message_id', '=', scopedId(account.id, id))
          .executeTakeFirst();
        deleted += Number(res.numDeletedRows ?? 0);
      }
      for (const ch of diff.labelChanges) {
        const row = await db
          .selectFrom('email_messages')
          .select(['id', 'gmail_label_ids'])
          .where('account_id', '=', account.id)
          .where('gmail_message_id', '=', scopedId(account.id, ch.messageId))
          .executeTakeFirst();
        if (!row) {
          // A draft sent from Gmail itself keeps its id and loses DRAFT; its
          // add was skipped above, so it is mirrored now that it is mail.
          if (!ch.remove.includes('DRAFT')) continue;
          const raw = await api.getMessage(ch.messageId, 'full');
          const labels = raw?.labelIds ?? [];
          if (!raw || labels.includes('DRAFT') || labels.includes('SPAM')) continue;
          const nm = scopeMessage(account.id, withoutBody(normalizeMessage(raw)));
          const threadRowId = await ensureThreadRow(db, account.user_id, nm.gmailThreadId, now, account.id);
          await upsertMessageMeta(db, account.user_id, threadRowId, nm, now, account.id);
          touched.add(nm.gmailThreadId);
          updated += 1;
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
      for (const tid of diff.touchedThreadIds) touched.add(scopedId(account.id, tid));
      for (const tid of touched) await recomputeThread(db, account.user_id, tid);

      await updateAccountSync(db, account.id, {
        sync_cursor: JSON.stringify({ historyId: latestHistory }),
        backfill_done: 1,
        synced_at: now,
      });
      result = { inserted: 0, updated, deleted, backfillDone: true };
    }
  }

  await db.updateTable('email_accounts').set({ status: 'ok' }).where('id', '=', account.id).execute();
  // A paused backfill leaves the AI passes for the pass that finishes it.
  const { pausedBy, ...synced } = result;
  if (pausedBy === undefined) await afterSync(db, account.user_id);
  emitEmailSynced(account.user_id, synced);
  return result;
}

export async function getGmailAccountThread(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
): Promise<EmailThreadDetail | null> {
  return getThreadWith(db, account.user_id, threadRowId, async (missing) => {
    const api = await apiFor(db, account);
    const gone: string[] = [];
    for (const m of missing) {
      const native = nativeId(account.id, m.gmail_message_id);
      if (native.startsWith('sent-')) {
        await db
          .updateTable('email_messages')
          .set({ attachments_json: '[]' })
          .where('id', '=', m.id)
          .where('attachments_json', 'is', null)
          .execute();
        continue;
      }
      try {
        const raw = await api.getMessage(native, 'full');
        // Gmail's 404: deleted for good at the source.
        if (!raw) {
          gone.push(m.id);
          continue;
        }
        const bodies = extractBodies(raw.payload);
        const parts = keepAttachmentIds(m.attachments_json, listAttachmentParts(raw.payload).map(toAttachmentRef));
        await db
          .updateTable('email_messages')
          .set({
            ...(await sealMessageContent(account.user_id, {
              body_text: bodies.text,
              body_html: bodies.html,
              attachments_json: JSON.stringify(parts),
            })),
            cid_parts_checked: 1,
          })
          .where('id', '=', m.id)
          .execute();
      } catch (err) {
        logger.warn('gmail-account body fetch failed', {
          accountId: account.id,
          id: m.id,
          err: (err as Error).message,
        });
      }
    }
    return { gone };
  });
}

export async function sendGmailAccountReply(
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

  const latest = await replyAnchor(db, account.user_id, thread.id, {
    messageId: input.messageId,
    ownAddress: account.email_address,
  });
  if (!latest) return null;

  const me = await mailboxSignatureRow(db, account.user_id, account.id);
  const bodies = await withQuotedOriginal(
    db,
    account.user_id,
    composedBodies(input, me),
    latest,
    { autoReply: input.autoReply },
  );
  const textBody = bodies.text;
  const htmlBody = bodies.plain ? undefined : bodies.html;

  const replyAddress = replyAddressOf({ fromEmail: latest.from_email, replyTo: latest.reply_to }, account.email_address);
  const to = input.to?.length ? input.to : replyAddress ? [replyAddress] : [];
  const references =
    (latest.headers_json as { references?: string | null } | undefined)?.references ?? null;
  const inReplyTo = latest.rfc822_message_id ?? null;
  const subject = thread.subject || latest.subject || '';

  const raw = buildReplyRaw({
    fromEmail: account.email_address,
    to,
    toName: toNameFor(to, latest),
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: replySubject(subject),
    inReplyTo,
    references,
    body: textBody,
    htmlBody,
    attachments: input.attachments,
    autoSubmitted: input.autoReply === true,
  });

  const api = await apiFor(db, account);
  const sent = await api.sendMessage(raw, nativeId(account.id, thread.gmail_thread_id));
  const now = new Date().toISOString();
  const nm: NormalizedMessage = {
    gmailMessageId: scopedId(account.id, sent.id),
    gmailThreadId: thread.gmail_thread_id,
    fromName: account.display_name,
    fromEmail: account.email_address,
    toEmails: to,
    ccEmails: input.cc ?? [],
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
  await upsertMessageMeta(db, account.user_id, thread.id, nm, now, account.id);
  // ADR 0124 - an auto-reply is not reading.
  if (input.markRead !== false) {
    await applyGmailAccountThreadModify(db, account, thread.id, { markRead: true });
  }
  return getGmailAccountThread(db, account, thread.id);
}

/** Full Gmail label support — unlike Outlook/IMAP, label ids pass through. */
export async function applyGmailAccountThreadModify(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  patch: {
    markRead?: boolean;
    archive?: boolean;
    trash?: boolean;
    addLabelIds?: string[];
    removeLabelIds?: string[];
    /** Only these messages read (EmailModifyRequest.messageIds). */
    messageIds?: string[];
  },
  opts: ReadWriteOpts = {},
): Promise<EmailThreadSummary | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!thread) return null;

  if (patch.messageIds) {
    const msgs = await threadMessagesIn(db, account.user_id, thread.id, patch.messageIds);
    if (msgs.length > 0) {
      // Not queued on failure: ADR 0199 holds a thread intent (same as primary).
      const api = await apiFor(db, account);
      await api.modifyMessages(
        msgs.map((m) => nativeId(account.id, m.gmail_message_id)),
        { removeLabelIds: ['UNREAD'] },
      );
    }
    return applyLocalThreadLabels(
      db,
      account.user_id,
      thread.id,
      thread.gmail_thread_id,
      [],
      ['UNREAD'],
      msgs.map((m) => m.id),
    );
  }

  if (patch.trash === true) {
    const api = await apiFor(db, account);
    await api.trashThread(nativeId(account.id, thread.gmail_thread_id));
    return applyLocalThreadLabels(
      db,
      account.user_id,
      thread.id,
      thread.gmail_thread_id,
      ...TRASH_DELTA,
    );
  }

  const add = [...(patch.addLabelIds ?? [])];
  const remove = [...(patch.removeLabelIds ?? [])];
  if (patch.markRead === true) remove.push('UNREAD');
  if (patch.markRead === false) add.push('UNREAD');
  if (patch.archive === true) remove.push('INBOX');
  if (patch.archive === false) add.push('INBOX');
  if (add.length === 0 && remove.length === 0) {
    return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, [], []);
  }

  try {
    const api = await apiFor(db, account);
    await api.modifyThread(nativeId(account.id, thread.gmail_thread_id), {
      addLabelIds: add,
      removeLabelIds: remove,
    });
  } catch (err) {
    // docs/notes/0199 — same rule as the primary Gmail.
    if (!isReadOnlyDelta(add, remove) || opts.fromRetry || isGoneError(err)) throw err;
    logger.warn('gmail-account read-state write failed — queued for retry', {
      accountId: account.id,
      err,
    });
    await queueReadWrite(db, account.user_id, thread.id, patch.markRead === false, err);
    return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove);
  }
  if (patch.markRead !== undefined) await clearReadWrite(db, thread.id);
  return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove);
}
