/**
 * Generic IMAP mailbox sync + write-back (ADR 0080) — Yahoo/AOL/iCloud/custom.
 * UID-based incremental sync into the shared mirror; bodies are parsed eagerly
 * (the full source is already fetched), threading is derived from References /
 * In-Reply-To (see imap-sync.ts), sends go out over SMTP. A UIDVALIDITY change
 * wipes the account mirror and re-backfills. Archive is local-mirror-only in
 * v1 (IMAP folder moves vary too much across providers); read-state syncs both
 * ways via \Seen.
 */
import { sql, type Kysely } from 'kysely';

import {
  replyAddressOf,
  type EmailSyncResult,
  type EmailThreadDetail,
  type EmailThreadSummary,
} from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { bodyExcerpt, cleanSnippet, modelBodyText } from '../../utils/email-text.js';
import {
  afterSync,
  applyLocalThreadLabels,
  TRASH_DELTA,
  emitEmailSynced,
  ensureThreadRow,
  getThreadWith,
  recomputeThread,
  replyAnchor,
  upsertMessageMeta,
  type ReadWriteOpts,
} from '../google/gmail.service.js';
import { clearReadWrite, queueReadWrite } from '../email/read-pending.js';
import { replySubject, type NormalizedMessage } from '../google/gmail-sync.js';
import {
  nativeId,
  MailboxWriteUnsupportedError,
  openAuthBlob,
  scopedId,
  syntheticLabels,
  updateAccountSync,
  type AccountRow,
  type ImapAuth,
} from './account-utils.js';
import {
  getImapApi,
  mockImapApi,
  withImapSession,
  type ImapApi,
  type ImapFetchedMessage,
} from './imap-api.js';
import {
  IMAP_KEY_VERSION,
  imapFlagsToLabels,
  imapNativeMessageId,
  imapSentNativeMessageId,
  imapThreadNativeId,
  parseImapCursor,
  uidFromNativeMessageId,
} from './imap-sync.js';
import { claimMirrorRow } from './mirror-identity.js';
import { withQuotedOriginal } from '../email/reply-quote.js';
import { composedBodies, mailboxSignatureRow, type ComposedBody } from '../email/signature.js';
import { FolderRemovedError } from '../email/mailbox-folder-memory.js';

/** Max full-message fetches per sync tick (backfill drains across ticks). */
const IMAP_FETCH_BATCH = 100;
/** Flag re-reads per tick for read-state convergence (newest first). */
const IMAP_FLAG_REFRESH = 200;
/** Trash lookups per tick. One connection covers the batch; the rest waits. */
const IMAP_TRASH_LOOKUP_BATCH = 200;

export function imapAccountApi(account: AccountRow): ImapApi {
  if (env.IMAP_PROVIDER === 'mock') return mockImapApi(account.id);
  return getImapApi(account.id, openAuthBlob<ImapAuth>(account));
}
const apiFor = imapAccountApi;

/** Every call in `fn` shares one login (ADR 0080 — Yahoo throttles on rate). */
export function withAccountSession<T>(account: AccountRow, fn: (api: ImapApi) => Promise<T>): Promise<T> {
  if (env.IMAP_PROVIDER === 'mock') return fn(mockImapApi(account.id));
  return withImapSession(account.id, openAuthBlob<ImapAuth>(account), fn);
}

export function normalizeImapMessage(
  accountId: string,
  m: ImapFetchedMessage,
  folder: 'inbox' | 'sent' = 'inbox',
): NormalizedMessage {
  return {
    gmailMessageId: scopedId(
      accountId,
      folder === 'sent' ? imapSentNativeMessageId(m.uid) : imapNativeMessageId(m.uid),
    ),
    gmailThreadId: scopedId(accountId, imapThreadNativeId(m)),
    fromName: m.fromName,
    fromEmail: m.fromEmail,
    toEmails: m.toEmails,
    ccEmails: m.ccEmails,
    subject: m.subject,
    snippet: cleanSnippet(m.snippet),
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    internalDate: m.date,
    isUnread: folder === 'sent' ? false : !m.flags.includes('\\Seen'),
    // Sent mail carries SENT and no INBOX, the same shape Gmail's mirror has,
    // so ADR 0108's folder predicates work on it unchanged (ADR 0116).
    labelIds: folder === 'sent' ? ['SENT'] : imapFlagsToLabels(m.flags),
    rfc822MessageId: m.messageId,
    headers: { references: m.references, inReplyTo: m.inReplyTo, date: m.date },
    // IMAP parses the full source at sync, so attachment metadata is known now.
    attachmentsJson: JSON.stringify(m.attachments ?? []),
    // Likewise the invite part — keeping it spares the probe a whole login.
    icsText: m.icsText ?? '',
    listUnsubscribe: m.listUnsubscribe ?? null,
    listUnsubscribePost: m.listUnsubscribePost ?? null,
    listId: m.listId ?? null,
    replyTo: m.replyTo ?? null,
    authResults: m.authResults ?? null,
    autoReply: m.autoReply === true,
    // IMAP parses the whole source at sync, so the excerpt costs nothing.
    bodyExcerpt: bodyExcerpt(modelBodyText({ text: m.bodyText, html: m.bodyHtml })),
  };
}

async function wipeAccountMirror(db: Kysely<DB>, accountId: string): Promise<void> {
  await db.deleteFrom('email_threads').where('account_id', '=', accountId).execute();
}

/**
 * Sent used to share INBOX's `u<uid>` key, so a Sent row may sit on an inbox
 * UID (hiding that inbox message from sync) or over an inbox row (in the inbox
 * thread). Every SENT row with a `u` key is a Sent-mailbox UID: re-key it `s`,
 * which frees the inbox UID to be fetched, and re-walk Sent so each row goes
 * back to its own thread.
 */
async function rekeyLegacySentRows(db: Kysely<DB>, accountId: string): Promise<number> {
  const prefix = `${accountId}:`;
  const res = await db
    .updateTable('email_messages')
    .set({
      gmail_message_id: sql<string>`${prefix} || 's' || substr(gmail_message_id, ${prefix.length + 2})`,
    })
    .where('account_id', '=', accountId)
    .where(sql<boolean>`gmail_label_ids @> '["SENT"]'::jsonb`)
    .where(sql<boolean>`left(gmail_message_id, ${prefix.length}) = ${prefix}`)
    .where(sql<boolean>`substr(gmail_message_id, ${prefix.length + 1}) ~ '^u[0-9]+$'`)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

/** Upsert one fetched message onto the row it already has, if any. Returns
 *  the id of an existing row that was re-keyed to it. */
async function mirrorImapMessage(
  db: Kysely<DB>,
  account: AccountRow,
  nm: NormalizedMessage,
  now: string,
  touched: Set<string>,
): Promise<string | null> {
  const threadRowId = await ensureThreadRow(db, account.user_id, nm.gmailThreadId, now, account.id);
  const claim = await claimMirrorRow(db, account.user_id, account.id, threadRowId, nm);
  if (claim.leftThread) touched.add(claim.leftThread);
  await upsertMessageMeta(db, account.user_id, threadRowId, nm, now, account.id);
  touched.add(nm.gmailThreadId);
  return claim.adoptedRowId;
}

export async function syncImapAccount(
  db: Kysely<DB>,
  account: AccountRow,
): Promise<EmailSyncResult> {
  // The whole tick — listWindow, fetch, findInTrash, fetchFlags — rides one
  // login instead of one apiece.
  return withAccountSession(account, (api) => syncImapAccountOn(db, account, api));
}

async function syncImapAccountOn(
  db: Kysely<DB>,
  account: AccountRow,
  api: ImapApi,
): Promise<EmailSyncResult> {
  const now = new Date().toISOString();
  // ADR 0142 — re-probe keyword support (servers can change; connect may have
  // used a one-shot verify key that differs from this session).
  try {
    const { recordImapLabelPushSupport } = await import('../email/chord-label-push.js');
    await recordImapLabelPushSupport(db, account.id, await api.probeKeywordSupport());
  } catch (err) {
    logger.info('imap keyword probe failed', {
      accountId: account.id,
      err: (err as Error).message,
    });
  }
  let cursor = parseImapCursor(account.sync_cursor);

  const { uidValidity, uids } = await api.listWindow(env.GMAIL_BACKFILL_DAYS);
  if (cursor && cursor.uidValidity !== uidValidity) {
    logger.warn('imap uidvalidity changed — rebuilding account mirror', {
      accountId: account.id,
      from: cursor.uidValidity,
      to: uidValidity,
    });
    await wipeAccountMirror(db, account.id);
    cursor = null;
  }
  if (cursor && cursor.keys !== IMAP_KEY_VERSION) {
    const rekeyed = await rekeyLegacySentRows(db, account.id);
    logger.info('imap sent rows re-keyed', { accountId: account.id, rekeyed });
    cursor = { ...cursor, sentLastUid: 0 };
  }

  const stored = await db
    .selectFrom('email_messages')
    .select([
      'id',
      'gmail_message_id',
      'gmail_thread_id',
      'gmail_label_ids',
      'is_unread',
      'internal_date',
      'rfc822_message_id',
    ])
    .where('account_id', '=', account.id)
    .execute();
  const storedByUid = new Map<number, (typeof stored)[number]>();
  for (const row of stored) {
    const uid = uidFromNativeMessageId(nativeId(account.id, row.gmail_message_id));
    if (uid !== null) storedByUid.set(uid, row);
  }

  const windowUids = new Set(uids);
  const touched = new Set<string>();
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  // New mail (bounded per tick; the rest drains next sync).
  const newUids = uids.filter((u) => !storedByUid.has(u));
  const batch = newUids.slice(-IMAP_FETCH_BATCH);
  const fetched = await api.fetch(batch);
  // A message moved back into INBOX has a new UID; its old row was just
  // re-keyed to it and must not then be treated as having vanished.
  const adopted = new Set<string>();
  for (const m of fetched) {
    const rowId = await mirrorImapMessage(db, account, normalizeImapMessage(account.id, m), now, touched);
    if (rowId) adopted.add(rowId);
    inserted += 1;
  }

  // Vanished from INBOX (archived/deleted server-side) → archive locally.
  const windowStart = new Date(
    Date.now() - env.GMAIL_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const vanished: (typeof stored)[number][] = [];
  for (const [uid, row] of storedByUid) {
    if (windowUids.has(uid)) continue;
    if (adopted.has(row.id)) continue;
    if (row.internal_date < windowStart) continue;
    const labels = Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : [];
    if (!labels.includes('INBOX')) continue;
    vanished.push(row);
  }

  // A vanished UID is a move — to Archive, or to Trash. Only the latter is a
  // delete, and only a delete retracts the thread's pending to-dos (ADR 0073).
  // The whole batch resolves in ONE connection; overflow waits for the next
  // tick rather than being mislabelled, since a wrong "archived" is sticky
  // (the row stops looking vanished once INBOX is stripped).
  const checking = vanished.slice(0, IMAP_TRASH_LOOKUP_BATCH);
  if (vanished.length > checking.length) {
    logger.info('imap trash lookup deferred to next tick', {
      accountId: account.id,
      deferred: vanished.length - checking.length,
    });
  }
  let trashedIds = new Set<string>();
  try {
    // A lookup failure degrades the batch to archive (non-destructive).
    trashedIds = await api.findInTrash(
      checking.map((r) => r.rfc822_message_id).filter((id): id is string => !!id),
    );
  } catch (err) {
    logger.warn('imap trash lookup failed — treating as archived', {
      accountId: account.id,
      err: (err as Error).message,
    });
  }

  // Grouped by the resulting label set rather than written per row — IMAP's
  // synthetic labels (INBOX/UNREAD) leave only a handful of distinct outcomes
  // even across a 200-row batch, so this collapses to a couple of statements.
  const toDelete: string[] = [];
  const archiveGroups = new Map<string, string[]>();
  for (const row of checking) {
    if (row.rfc822_message_id && trashedIds.has(row.rfc822_message_id)) {
      toDelete.push(row.id);
    } else {
      const labels = Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : [];
      const labelsJson = JSON.stringify(labels.filter((l) => l !== 'INBOX'));
      const ids = archiveGroups.get(labelsJson);
      if (ids) ids.push(row.id);
      else archiveGroups.set(labelsJson, [row.id]);
    }
    touched.add(row.gmail_thread_id);
    deleted += 1;
  }
  if (toDelete.length > 0) {
    // Dropping the rows lets the shared recomputeThread reap their threads and
    // retract pending proposals.
    await db.deleteFrom('email_messages').where('id', 'in', toDelete).execute();
  }
  for (const [labelsJson, ids] of archiveGroups) {
    await db
      .updateTable('email_messages')
      .set({ gmail_label_ids: labelsJson })
      .where('id', 'in', ids)
      .execute();
  }

  // Read-state convergence for the newest known UIDs. Same grouping trick —
  // the resulting (labels, unread) pair collapses to a small number of groups.
  const refreshUids = uids.filter((u) => storedByUid.has(u)).slice(-IMAP_FLAG_REFRESH);
  const flags = await api.fetchFlags(refreshUids);
  const readGroups = new Map<string, { labelsJson: string; unread: number; ids: string[] }>();
  for (const [uid, f] of flags) {
    const row = storedByUid.get(uid);
    if (!row) continue;
    const unread = f.includes('\\Seen') ? 0 : 1;
    if (row.is_unread === unread) continue;
    const labels = new Set(Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : []);
    if (unread === 1) labels.add('UNREAD');
    else labels.delete('UNREAD');
    const labelsJson = JSON.stringify([...labels]);
    const key = `${unread}:${labelsJson}`;
    const group = readGroups.get(key);
    if (group) group.ids.push(row.id);
    else readGroups.set(key, { labelsJson, unread, ids: [row.id] });
    touched.add(row.gmail_thread_id);
    updated += 1;
  }
  for (const { labelsJson, unread, ids } of readGroups.values()) {
    await db
      .updateTable('email_messages')
      .set({ gmail_label_ids: labelsJson, is_unread: unread })
      .where('id', 'in', ids)
      .execute();
  }

  // ADR 0116 — the Sent mailbox, so the mirror holds mail the user sent from
  // any client rather than only what Chord sent. Deliberately simpler than the
  // inbox pass: sent mail has no unread state to converge and does not get
  // archived out from under us, so this is fetch-forward only.
  let sentUidValidity = cursor?.sentUidValidity;
  let sentLastUid = cursor?.sentLastUid ?? 0;
  try {
    const sentWindow = await api.listSentWindow(env.GMAIL_BACKFILL_DAYS);
    if (sentWindow) {
      // A validity change means the server renumbered the mailbox; start over
      // rather than trusting a high-water mark against different UIDs.
      if (sentUidValidity && sentUidValidity !== sentWindow.uidValidity) sentLastUid = 0;
      sentUidValidity = sentWindow.uidValidity;
      const fresh = sentWindow.uids.filter((u) => u > sentLastUid).slice(0, IMAP_FETCH_BATCH);
      if (fresh.length > 0) {
        for (const m of await api.fetchSent(fresh)) {
          await mirrorImapMessage(db, account, normalizeImapMessage(account.id, m, 'sent'), now, touched);
          inserted += 1;
        }
        sentLastUid = fresh[fresh.length - 1];
      }
    }
  } catch (err) {
    // A Sent folder we cannot read must not fail the inbox sync that already
    // succeeded; the next tick tries again from the same high-water mark.
    logger.warn('imap sent sync failed', {
      accountId: account.id,
      err: (err as Error).message,
    });
  }

  for (const tid of touched) await recomputeThread(db, account.user_id, tid);

  const backfillDone = newUids.length <= IMAP_FETCH_BATCH;
  const lastUid = uids.length > 0 ? uids[uids.length - 1] : cursor?.lastUid ?? 0;
  await updateAccountSync(db, account.id, {
    sync_cursor: JSON.stringify({
      uidValidity,
      lastUid,
      sentUidValidity,
      sentLastUid,
      keys: IMAP_KEY_VERSION,
    }),
    backfill_done: backfillDone ? 1 : 0,
    synced_at: now,
  });
  await db.updateTable('email_accounts').set({ status: 'ok' }).where('id', '=', account.id).execute();

  logger.info(
    `imap sync account=${account.id} fetched=${inserted} flags=${updated} archived=${deleted}`,
  );
  await afterSync(db, account.user_id);
  const result: EmailSyncResult = { inserted, updated, deleted, backfillDone };
  emitEmailSynced(account.user_id, result);
  return result;
}

/** Compose a new message over SMTP (ADR 0107). */
export async function sendImapNew(
  db: Kysely<DB>,
  account: AccountRow,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: { filename: string; mimeType: string; content: Buffer }[] } & Omit<ComposedBody, 'body'>,
): Promise<{ fromEmail: string }> {
  const me = await mailboxSignatureRow(db, account.user_id, account.id);
  const newBodies = composedBodies(input, me);
  const textBody = newBodies.text;
  const htmlBody = newBodies.plain ? undefined : newBodies.html;
  await apiFor(account).send({
    from: account.email_address,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: textBody,
    html: htmlBody,
    inReplyTo: null,
    references: null,
    attachments: input.attachments,
  });
  return { fromEmail: account.email_address };
}
/** Bodies + attachment metadata land at sync; the lazy pass only settles
 *  legacy rows mirrored before attachment discovery existed. */
export async function getImapThread(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
): Promise<EmailThreadDetail | null> {
  return getThreadWith(db, account.user_id, threadRowId, async (missing) => {
    if (missing.length === 0) return;
    await db
      .updateTable('email_messages')
      .set({ attachments_json: '[]' })
      .where('id', 'in', missing.map((m) => m.id))
      .where('attachments_json', 'is', null)
      .execute();
  });
}

export async function sendImapReply(
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

  const headers = latest.headers_json as { references?: string | null } | undefined;
  const inReplyTo = latest.rfc822_message_id ?? null;
  const references = [headers?.references, inReplyTo].filter(Boolean).join(' ').trim() || null;
  const replyAddress = replyAddressOf({ fromEmail: latest.from_email, replyTo: latest.reply_to }, account.email_address);
  const to = input.to?.length ? input.to : replyAddress ? [replyAddress] : [];
  const subject = replySubject(thread.subject || latest.subject || '');

  const api = apiFor(account);
  const { messageId: sentMessageId } = await api.send({
    from: account.display_name
      ? `${account.display_name} <${account.email_address}>`
      : account.email_address,
    to,
    cc: input.cc,
    bcc: input.bcc,
    subject,
    text: textBody,
    html: htmlBody,
    inReplyTo,
    references,
    attachments: input.attachments,
    autoSubmitted: input.autoReply === true,
  });

  const now = new Date().toISOString();
  const nm: NormalizedMessage = {
    gmailMessageId: scopedId(account.id, `sent-${newId('emm')}`),
    gmailThreadId: thread.gmail_thread_id,
    fromName: account.display_name,
    fromEmail: account.email_address,
    toEmails: to,
    ccEmails: input.cc ?? [],
    subject,
    snippet: input.body.slice(0, 120),
    bodyText: textBody,
    bodyHtml: htmlBody ?? null,
    internalDate: now,
    isUnread: false,
    labelIds: syntheticLabels({ inInbox: false, unread: false, sent: true }),
    // The Sent-folder copy carries this Message-ID, which is how the sync
    // recognises it as this placeholder (docs/notes/0199 addendum).
    rfc822MessageId: sentMessageId,
    headers: { references, inReplyTo, date: null },
    attachmentsJson: '[]',
    autoReply: input.autoReply === true,
  };
  await upsertMessageMeta(db, account.user_id, thread.id, nm, now, account.id);
  // ADR 0124 - an auto-reply is not reading.
  if (input.markRead !== false) {
    await applyImapThreadModify(db, account, thread.id, { markRead: true });
  }
  return getImapThread(db, account, thread.id);
}

/**
 * Read-state syncs via \Seen; archive is a real folder move (ADR 0107).
 *
 * Archive used to be local-mirror-only in BOTH directions, so a thread archived
 * in Chord vanished from every listing while still sitting in the user's inbox
 * everywhere else. The local label is now written only when the move actually
 * happened — a mailbox with no archive folder, or a failed move, leaves the
 * thread where it is rather than lying about it.
 */
export async function applyImapThreadModify(
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

  if (patch.trash === true) return trashImapThread(db, account, thread);
  const only = patch.messageIds ? new Set(patch.messageIds) : null;
  let onlyIds: string[] = [];

  const add: string[] = [];
  const remove: string[] = [];
  if (patch.markRead === true) remove.push('UNREAD');
  if (patch.markRead === false) add.push('UNREAD');
  // docs/notes/0199 — a \Seen the server refused is still owed, not dropped.
  let readOwed: unknown = null;

  const needsUids = patch.markRead !== undefined || patch.archive !== undefined;
  let uids: number[] = [];
  // Already where an archive/un-archive asks it to be: a repeat of a move
  // that went through is done, not "this mailbox has no archive folder".
  let archiveDone = false;
  if (needsUids) {
    const msgs = (
      await db
        .selectFrom('email_messages')
        .select(['id', 'gmail_message_id', 'gmail_label_ids'])
        .where('thread_id', '=', thread.id)
        .where('user_id', '=', account.user_id)
        .execute()
    ).filter((m) => !only || only.has(m.id));
    onlyIds = msgs.map((m) => m.id);
    uids = msgs
      .map((m) => uidFromNativeMessageId(nativeId(account.id, m.gmail_message_id)))
      .filter((u): u is number => u !== null);
    if (patch.archive !== undefined && msgs.length > 0) {
      const inInbox = msgs.map((m) => Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('INBOX'));
      archiveDone = patch.archive ? inInbox.every((x) => !x) : inInbox.every((x) => x);
    }
  }

  let archiveMoved = archiveDone;
  // Nothing on the server to flag: no login spent on it (ADR 0080).
  if (only && uids.length === 0) {
    return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove, onlyIds);
  }
  // One session covers both writes — a mark-read + archive is one user action,
  // not two IMAP logins.
  try {
    await withAccountSession(account, async (api) => {
      if (patch.markRead !== undefined) {
        try {
          await api.setSeen(uids, patch.markRead);
        } catch (err) {
          logger.warn('imap setSeen failed', { accountId: account.id, err: (err as Error).message });
          readOwed = err;
        }
      }

      if (patch.archive !== undefined && !archiveDone) {
        try {
          archiveMoved = await api.setArchived(uids, patch.archive);
        } catch (err) {
          logger.warn('imap archive move failed', {
            accountId: account.id,
            archive: patch.archive,
            err: (err as Error).message,
          });
        }
      }
    });
  } catch (err) {
    // Could not even log in (Yahoo throttles logins, ADR 0080): the read-state
    // is owed; an archive falls through to the refusal below.
    logger.warn('imap session failed', { accountId: account.id, err: (err as Error).message });
    if (patch.markRead !== undefined) readOwed = err;
  }

  if (only) {
    // Single messages are the caller's to retry: ADR 0199 holds a thread intent.
    if (readOwed !== null) throw readOwed;
    return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove, onlyIds);
  }

  if (patch.markRead !== undefined) {
    if (readOwed !== null) {
      if (opts.fromRetry) throw readOwed;
      await queueReadWrite(db, account.user_id, thread.id, !patch.markRead, readOwed);
    } else {
      await clearReadWrite(db, thread.id);
    }
  }

  if (patch.archive !== undefined) {
    if (archiveMoved) {
      if (patch.archive) remove.push('INBOX');
      else add.push('INBOX');
    } else {
      // The UID moves on a successful archive, so the next sync would have to
      // re-resolve it anyway; refusing here keeps the mirror honest instead.
      throw new MailboxWriteUnsupportedError(
        patch.archive
          ? 'this mailbox has no archive folder, so the message was left in the inbox'
          : 'could not move the message back to the inbox',
      );
    }
  }

  return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, add, remove);
}

/**
 * ADR 0215 — move the thread's inbox messages to Trash. Only inbox copies:
 * a stored UID belongs to the folder the message was in when synced, and once
 * it has been archived that UID means nothing in INBOX, so a move would
 * report success for mail it never touched.
 */
/**
 * ADR 0309 — file a thread's inbox messages into the mailbox named `folder`,
 * made if missing. The thread then leaves the Chord inbox the way an archive
 * does. Nothing is filed when nothing of the thread is still in the inbox.
 */
export async function fileImapThread(
  db: Kysely<DB>,
  account: AccountRow,
  threadRowId: string,
  folder: string,
  /** An open session to reuse (the filing pass files many threads on one login). */
  session?: ImapApi,
  /** `create: false`: a missing mailbox throws FolderRemovedError, not made. */
  opts?: { create?: boolean },
): Promise<EmailThreadSummary | null> {
  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', account.user_id)
    .executeTakeFirst();
  if (!thread) return null;
  const msgs = await db
    .selectFrom('email_messages')
    .select(['gmail_message_id', 'gmail_label_ids'])
    .where('thread_id', '=', thread.id)
    .where('user_id', '=', account.user_id)
    .execute();
  const uids = msgs
    .filter((m) => Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('INBOX'))
    .map((m) => uidFromNativeMessageId(nativeId(account.id, m.gmail_message_id)))
    .filter((u): u is number => u !== null);
  if (uids.length === 0) return null;
  let moved: boolean;
  try {
    moved = session
      ? await session.moveToFolder(uids, folder, opts)
      : await withAccountSession(account, (api) => api.moveToFolder(uids, folder, opts));
  } catch (err) {
    logger.warn('imap file failed', { accountId: account.id, err: (err as Error).message });
    throw new MailboxWriteUnsupportedError(`could not move this message to "${folder}"`);
  }
  if (!moved) throw new FolderRemovedError(folder);
  return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, [], ['INBOX']);
}

async function trashImapThread(
  db: Kysely<DB>,
  account: AccountRow,
  thread: { id: string; gmail_thread_id: string },
): Promise<EmailThreadSummary | null> {
  const msgs = await db
    .selectFrom('email_messages')
    .select(['gmail_message_id', 'gmail_label_ids'])
    .where('thread_id', '=', thread.id)
    .where('user_id', '=', account.user_id)
    .execute();
  // Already in Trash: a repeat of a Trash that went through is done, not a
  // refusal ("only mail still in the inbox...").
  if (msgs.length > 0 && msgs.every((m) => Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('TRASH'))) {
    return applyLocalThreadLabels(db, account.user_id, thread.id, thread.gmail_thread_id, ...TRASH_DELTA);
  }
  const uids = msgs
    .filter((m) => Array.isArray(m.gmail_label_ids) && m.gmail_label_ids.includes('INBOX'))
    .map((m) => uidFromNativeMessageId(nativeId(account.id, m.gmail_message_id)))
    .filter((u): u is number => u !== null);
  if (uids.length === 0) {
    throw new MailboxWriteUnsupportedError(
      'only mail still in the inbox can be moved to Trash on this mailbox',
    );
  }

  let moved = false;
  try {
    moved = await withAccountSession(account, (api) => api.moveToTrash(uids));
  } catch (err) {
    logger.warn('imap trash move failed', { accountId: account.id, err: (err as Error).message });
  }
  if (!moved) {
    throw new MailboxWriteUnsupportedError(
      'could not move this message to Trash (the mailbox may have no Trash folder)',
    );
  }
  return applyLocalThreadLabels(
    db,
    account.user_id,
    thread.id,
    thread.gmail_thread_id,
    ...TRASH_DELTA,
  );
}
