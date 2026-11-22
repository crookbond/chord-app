/**
 * A draft also lives in the mailbox's own Drafts folder (ADR 0303).
 *
 * Chord's own row stays the source: the composer saves it within a second and a
 * half, so a crash loses almost nothing. This copies a changed row to Gmail /
 * Outlook / IMAP at most once per `EMAIL_PROVIDER_DRAFT_SECONDS`, so the draft
 * is also there when the user opens Gmail on a laptop. One direction only: an
 * edit made in Gmail's own editor is not read back (two writers to one draft
 * is ADR 0107's problem again).
 *
 * The one thing read back is a DELETION. A copy the user deleted (or sent) in
 * Outlook, Gmail or another IMAP client is never written again: the Chord
 * draft goes too. Found two ways - the next copy finding it gone, and a check
 * every `CHECK_EVERY_MS` on drafts nobody is editing, so it also leaves
 * Chord's Drafts list rather than waiting for an edit to rewrite it.
 *
 * The copy carries text and recipients, not files. Re-uploading every
 * attachment every thirty seconds while someone types is the cost that buys
 * nothing: the files stay on the Chord draft and go out with it on send.
 */
import type { Kysely } from 'kysely';

import { replyAddressOf } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { isLeader } from '../cluster/leadership.js';
import { getAccount, nativeId, type AccountRow } from '../email-accounts/account-utils.js';
import { gmailAccountApi } from '../email-accounts/gmail-account.service.js';
import { imapAccountApi } from '../email-accounts/imap.service.js';
import { getOutlookApi } from '../email-accounts/outlook-api.js';
import { getGmailApi } from '../google/gmail-api.js';
import { replyAnchor, toNameFor } from '../google/gmail.service.js';
import { buildReplyRaw, replySubject, textToHtml } from '../google/gmail-sync.js';
import { forwardDraftContent, forwardSubject } from './forward.service.js';
import { queueProviderDraftRemoval } from './drafts.service.js';
import { withQuotedOriginal } from './reply-quote.js';
import { composedBodies, mailboxSignatureRow, type ComposedBody } from './signature.js';

/** How many drafts and removals one pass handles. */
const PER_PASS = 50;
/** A failing copy waits 1 min, doubling, up to this. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
/** A removal that has failed this often is given up on, with an error log. */
const MAX_REMOVAL_ATTEMPTS = 12;
/** How often an untouched draft's copy is checked for a deletion elsewhere. */
const CHECK_EVERY_MS = 5 * 60 * 1000;

/** The copy this draft had was deleted or sent in another mail app. */
const GONE = { gone: true } as const;
type WriteResult = string | null | typeof GONE;
const isGone = (r: WriteResult | { gone: true }): r is typeof GONE => typeof r === 'object' && r !== null;

export const PRIMARY_MAILBOX = 'primary';

interface DraftRow {
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
  updated_at: string;
  provider_ref: string | null;
  provider_mailbox: string | null;
  provider_attempts: number;
  forward_message_id: string | null;
  body_format: string | null;
  body_html: string | null;
}

/** What goes into the provider's draft, before any provider shapes it. */
interface DraftMessage {
  fromEmail: string;
  to: string[];
  toName: string | null;
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
  /** ADR 0339: written in Plain, so text only where the provider allows. */
  plain: boolean;
  inReplyTo: string | null;
  references: string | null;
  /** The thread's native id in that mailbox (Gmail threads the draft on it). */
  nativeThreadId: string | null;
  /** The provider id of the message being answered (Outlook's createReply). */
  replyToNativeId: string | null;
}

type Mailbox = { key: typeof PRIMARY_MAILBOX } | { key: string; account: AccountRow };

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function mailboxFor(db: Kysely<DB>, row: DraftRow): Promise<Mailbox | null> {
  let accountId = row.account_id;
  if (row.kind !== 'new' && row.thread_id) {
    const thread = await db
      .selectFrom('email_threads')
      .select('account_id')
      .where('id', '=', row.thread_id)
      .where('user_id', '=', row.user_id)
      .executeTakeFirst();
    if (!thread) return null;
    accountId = thread.account_id;
  }
  if (!accountId) return { key: PRIMARY_MAILBOX };
  const account = await getAccount(db, row.user_id, accountId);
  return account ? { key: account.id, account } : null;
}

/** The draft as the message it would send, or null when its thread is gone. */
/** ADR 0339: how the draft was written, as the send reads it. */
function composedOf(row: DraftRow, body: string, bodyHtml?: string | null): ComposedBody {
  const format = row.body_format === 'plain' || row.body_format === 'rich' ? row.body_format : undefined;
  return { body, format, bodyHtml: format === 'rich' ? (bodyHtml ?? row.body_html) : null };
}

async function draftMessage(db: Kysely<DB>, row: DraftRow, mailbox: Mailbox): Promise<DraftMessage | null> {
  const me = await db
    .selectFrom('users')
    .select('email')
    .where('id', '=', row.user_id)
    .executeTakeFirst();
  const account = 'account' in mailbox ? mailbox.account : null;
  const signature = await mailboxSignatureRow(db, row.user_id, account?.id ?? null);
  const fromEmail = account?.email_address ?? me?.email ?? 'me@example.com';
  const base = {
    fromEmail,
    to: row.to_emails,
    toName: null as string | null,
    cc: row.cc_emails,
    bcc: row.bcc_emails,
    inReplyTo: null as string | null,
    references: null as string | null,
    nativeThreadId: null as string | null,
    replyToNativeId: null as string | null,
  };

  if (row.kind === 'new' || !row.thread_id) {
    const { text, html, plain } = composedBodies(composedOf(row, row.body), signature);
    return { ...base, subject: row.subject, text, html, plain };
  }

  const thread = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'subject'])
    .where('id', '=', row.thread_id)
    .where('user_id', '=', row.user_id)
    .executeTakeFirst();
  if (!thread) return null;
  const native = account ? nativeId(account.id, thread.gmail_thread_id) : thread.gmail_thread_id;

  if (row.kind === 'forward') {
    // The same quote the send builds (ADR 0112 addendum): the draft's chosen
    // message, its visible text, a readable date.
    const content = await forwardDraftContent(
      db,
      row.user_id,
      thread.id,
      row.body,
      row.forward_message_id ?? undefined,
    );
    const full = content?.body ?? row.body;
    // The send puts a rich note above the forwarded email as text (ADR 0339).
    const quoted = full.startsWith(row.body) ? full.slice(row.body.length).replace(/^\s+/, '') : full;
    const noteHtml = row.body_format === 'rich' && row.body_html?.trim() ? `${row.body_html}<br>${textToHtml(quoted)}` : null;
    const { text, html, plain } = composedBodies(composedOf(row, full, noteHtml), signature);
    return { ...base, subject: content?.subject ?? forwardSubject(thread.subject || ''), text, html, plain };
  }

  // A reply: same anchor, recipients and threading headers the send will use.
  const anchor = await replyAnchor(db, row.user_id, thread.id, { ownAddress: fromEmail });
  const address = replyAddressOf(
    anchor ? { fromEmail: anchor.from_email, replyTo: anchor.reply_to } : null,
    fromEmail,
  );
  const to = row.to_emails.length ? row.to_emails : address ? [address] : [];
  // ADR 0338: the copy quotes what it answers, as the send will (Outlook's
  // PATCH would otherwise replace the quote createReply built).
  const { text, html, plain } = await withQuotedOriginal(
    db,
    row.user_id,
    composedBodies(composedOf(row, row.body), signature),
    anchor,
  );
  const theirs = anchor && anchor.from_email?.toLowerCase() !== fromEmail.toLowerCase();
  return {
    ...base,
    to,
    toName: toNameFor(to, anchor),
    subject: replySubject(thread.subject || anchor?.subject || ''),
    text,
    html,
    plain,
    inReplyTo: anchor?.rfc822_message_id ?? null,
    references: (anchor?.headers_json as { references?: string | null } | undefined)?.references ?? null,
    nativeThreadId: native,
    replyToNativeId:
      theirs && account ? nativeId(account.id, anchor.gmail_message_id) : null,
  };
}

function rawMime(m: DraftMessage): string {
  return buildReplyRaw({
    fromEmail: m.fromEmail,
    to: m.to,
    toName: m.toName,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    inReplyTo: m.inReplyTo,
    references: m.references,
    body: m.text,
    htmlBody: m.plain ? undefined : m.html,
  });
}

/**
 * Write the copy, creating it when `ref` is null. Returns the copy's ref, null
 * when this mailbox cannot hold drafts, or GONE when `ref` names a copy the
 * provider no longer has: someone deleted or sent it elsewhere, and writing a
 * new one would undo that.
 */
async function writeProviderDraft(
  db: Kysely<DB>,
  userId: string,
  mailbox: Mailbox,
  m: DraftMessage,
  ref: string | null,
): Promise<WriteResult> {
  const account = 'account' in mailbox ? mailbox.account : null;

  if (!account || account.provider === 'gmail') {
    const api = account ? await gmailAccountApi(db, account) : await getGmailApi(db, userId);
    if (!api.createDraft || !api.updateDraft) return null;
    const raw = rawMime(m);
    const threadId = m.nativeThreadId ?? undefined;
    if (ref) {
      const updated = await api.updateDraft(ref, raw, threadId);
      return updated ? updated.id : GONE;
    }
    return (await api.createDraft(raw, threadId)).id;
  }

  if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    if (!api.createDraft || !api.updateDraft) return null;
    const content = { to: m.to, cc: m.cc, bcc: m.bcc, subject: m.subject, html: m.html };
    if (ref) return (await api.updateDraft(ref, content)) ? ref : GONE;
    // A reply starts from createReply so Outlook files it in the conversation.
    const fresh =
      (m.replyToNativeId && api.createReplyDraft ? await api.createReplyDraft(m.replyToNativeId) : null) ??
      (await api.createDraft(content));
    if (!(await api.updateDraft(fresh, content))) throw new Error('outlook draft vanished after create');
    return fresh;
  }

  const api = imapAccountApi(account);
  if (!api.saveDraft) return null;
  const raw = rawMime(m);
  const mime = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const saved = await api.saveDraft(mime, ref);
  return isGone(saved) ? GONE : saved;
}

/** Delete a copy. Already gone is a success. */
async function removeProviderDraft(
  db: Kysely<DB>,
  userId: string,
  mailboxKey: string,
  ref: string,
): Promise<void> {
  if (mailboxKey === PRIMARY_MAILBOX) {
    const api = await getGmailApi(db, userId);
    await api.deleteDraft?.(ref);
    return;
  }
  const account = await getAccount(db, userId, mailboxKey);
  // A mailbox the user removed took its drafts' copies with it as far as we
  // can reach: nothing left to delete through.
  if (!account) return;
  if (account.provider === 'gmail') await (await gmailAccountApi(db, account)).deleteDraft?.(ref);
  else if (account.provider === 'outlook') await (await getOutlookApi(db, account)).deleteDraft?.(ref);
  else await imapAccountApi(account).deleteDraft?.(ref);
}

/** Which of `refs` (all in one mailbox) the provider no longer holds as drafts. */
async function missingProviderDrafts(
  db: Kysely<DB>,
  userId: string,
  mailboxKey: string,
  refs: string[],
): Promise<Set<string>> {
  if (mailboxKey === PRIMARY_MAILBOX) {
    return (await (await getGmailApi(db, userId)).missingDrafts?.(refs)) ?? new Set();
  }
  const account = await getAccount(db, userId, mailboxKey);
  if (!account) return new Set();
  if (account.provider === 'gmail') {
    return (await (await gmailAccountApi(db, account)).missingDrafts?.(refs)) ?? new Set();
  }
  if (account.provider === 'outlook') {
    return (await (await getOutlookApi(db, account)).missingDrafts?.(refs)) ?? new Set();
  }
  return (await imapAccountApi(account).missingDrafts?.(refs)) ?? new Set();
}

/**
 * The copy was deleted (or sent) in another mail app: delete the Chord draft
 * too, with nothing queued for removal since there is nothing left to remove.
 * Only the version that was looked at - a save that landed since keeps its
 * row and is judged on its own next pass.
 */
async function dropDeletedElsewhere(
  db: Kysely<DB>,
  row: { id: string; user_id: string; updated_at: string },
): Promise<boolean> {
  const res = await db
    .deleteFrom('email_drafts')
    .where('id', '=', row.id)
    .where('updated_at', '=', row.updated_at)
    .where('send_after', 'is', null)
    .executeTakeFirst();
  const dropped = Number(res.numDeletedRows ?? 0) > 0;
  if (dropped) logger.info('draft deleted in its mailbox - Chord draft removed', { userId: row.user_id, draft: row.id });
  return dropped;
}

/** Copy one draft. Never throws: a failure is recorded on the row. */
async function pushOne(db: Kysely<DB>, row: DraftRow): Promise<'pushed' | 'skipped' | 'failed' | 'dropped'> {
  try {
    const mailbox = await mailboxFor(db, row);
    // A thread or mailbox that is gone leaves nothing to file the copy in.
    const m = mailbox ? await draftMessage(db, row, mailbox) : null;
    if (!mailbox || !m) {
      await db
        .updateTable('email_drafts')
        .set({ provider_synced_at: row.updated_at, provider_error: 'no mailbox for this draft' })
        .where('id', '=', row.id)
        .execute();
      return 'skipped';
    }

    // Queued or discarded since this pass listed it: copying it now would only
    // make work for the removal queue. Whatever slips past this check is
    // settled by the row update below.
    const still = await db
      .selectFrom('email_drafts')
      .select('send_after')
      .where('id', '=', row.id)
      .executeTakeFirst();
    if (!still || still.send_after !== null) return 'skipped';

    // The From changed since the last copy: that copy is in another mailbox.
    let ref = row.provider_ref;
    if (ref && row.provider_mailbox && row.provider_mailbox !== mailbox.key) {
      await queueProviderDraftRemoval(db, row.user_id, row.provider_mailbox, ref);
      ref = null;
    }

    const written = await writeProviderDraft(db, row.user_id, mailbox, m, ref);
    if (isGone(written)) return (await dropDeletedElsewhere(db, row)) ? 'dropped' : 'skipped';
    const next = written;
    const res = await db
      .updateTable('email_drafts')
      .set({
        provider_ref: next,
        provider_mailbox: next ? mailbox.key : null,
        provider_synced_at: row.updated_at,
        provider_attempts: 0,
        provider_retry_at: null,
        provider_error: next ? null : 'this mailbox has no drafts folder',
        provider_checked_at: new Date().toISOString(),
      })
      // Deliberately NOT guarded on send_after: a draft queued (Send) while
      // the copy was written still exists, and may yet be undone, so the row
      // must name the copy that is really there. Its send's deleteDraft
      // queues that ref; recording nothing here instead queued the copy for
      // removal while an undone draft still pointed at it.
      .where('id', '=', row.id)
      .executeTakeFirst();
    // Discarded or sent (row deleted) while the copy was being written: its
    // removal was queued with the old ref, so the one just written must go
    // too.
    if (Number(res.numUpdatedRows ?? 0) === 0 && next) {
      await queueProviderDraftRemoval(db, row.user_id, mailbox.key, next);
    }
    return next ? 'pushed' : 'skipped';
  } catch (err) {
    const attempts = row.provider_attempts + 1;
    const message = (err as Error).message;
    logger.warn('provider draft copy failed', { userId: row.user_id, draft: row.id, attempts, err: message });
    await db
      .updateTable('email_drafts')
      .set({
        provider_attempts: attempts,
        provider_retry_at: new Date(Date.now() + backoffMs(attempts)).toISOString(),
        provider_error: message.slice(0, 500),
      })
      .where('id', '=', row.id)
      .execute();
    return 'failed';
  }
}

/**
 * Drafts nobody is editing whose copy has not been looked at for a while: ask
 * each mailbox which are gone, and drop those Chord drafts.
 */
async function checkDeletedElsewhere(db: Kysely<DB>, now: string): Promise<number> {
  const due = new Date(Date.parse(now) - CHECK_EVERY_MS).toISOString();
  const rows = await db
    .selectFrom('email_drafts')
    .select(['id', 'user_id', 'updated_at', 'provider_ref', 'provider_mailbox'])
    .where('send_after', 'is', null)
    .where('provider_ref', 'is not', null)
    .where('provider_mailbox', 'is not', null)
    // Unchanged since the last copy; a changed one is judged when it is copied.
    .where((eb) => eb('provider_synced_at', '=', eb.ref('updated_at')))
    .where((eb) => eb.or([eb('provider_checked_at', 'is', null), eb('provider_checked_at', '<=', due)]))
    .orderBy('provider_checked_at', (ob) => ob.asc().nullsFirst())
    .limit(PER_PASS)
    .execute();

  const byMailbox = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = JSON.stringify([r.user_id, r.provider_mailbox]);
    byMailbox.set(key, [...(byMailbox.get(key) ?? []), r]);
  }

  let dropped = 0;
  for (const group of byMailbox.values()) {
    const userId = group[0]!.user_id;
    const mailboxKey = group[0]!.provider_mailbox!;
    let missing = new Set<string>();
    try {
      missing = await missingProviderDrafts(db, userId, mailboxKey, group.map((r) => r.provider_ref!));
    } catch (err) {
      // An outage is not a deletion; ask again next interval.
      logger.warn('provider draft check failed', { userId, mailbox: mailboxKey, err: (err as Error).message });
    }
    await db
      .updateTable('email_drafts')
      .set({ provider_checked_at: now })
      .where('id', 'in', group.map((r) => r.id))
      .execute();
    for (const r of group) {
      if (missing.has(r.provider_ref!) && (await dropDeletedElsewhere(db, r))) dropped += 1;
    }
  }
  return dropped;
}

/**
 * One pass: copy every changed draft, drop drafts deleted in their mailbox,
 * then delete copies whose Chord draft is gone.
 */
export async function syncProviderDrafts(
  db: Kysely<DB>,
): Promise<{ pushed: number; removed: number; dropped: number }> {
  const now = new Date().toISOString();
  const rows = (await db
    .selectFrom('email_drafts')
    .select([
      'id',
      'user_id',
      'kind',
      'thread_id',
      'account_id',
      'to_emails',
      'cc_emails',
      'bcc_emails',
      'subject',
      'body',
      'updated_at',
      'provider_ref',
      'provider_mailbox',
      'provider_attempts',
      'forward_message_id',
      'body_format',
      'body_html',
    ])
    .where('send_after', 'is', null)
    .where((eb) => eb.or([eb('provider_synced_at', 'is', null), eb('provider_synced_at', '<', eb.ref('updated_at'))]))
    .where((eb) => eb.or([eb('provider_retry_at', 'is', null), eb('provider_retry_at', '<=', now)]))
    .orderBy('updated_at', 'asc')
    .limit(PER_PASS)
    .execute()) as DraftRow[];

  let pushed = 0;
  let dropped = 0;
  for (const row of rows) {
    const outcome = await pushOne(db, row);
    if (outcome === 'pushed') pushed += 1;
    if (outcome === 'dropped') dropped += 1;
  }
  dropped += await checkDeletedElsewhere(db, now);

  const removals = await db
    .selectFrom('email_provider_draft_removals')
    .selectAll()
    .where('retry_at', '<=', now)
    .orderBy('retry_at', 'asc')
    .limit(PER_PASS)
    .execute();
  let removed = 0;
  for (const r of removals) {
    try {
      await removeProviderDraft(db, r.user_id, r.provider_mailbox, r.provider_ref);
      await db.deleteFrom('email_provider_draft_removals').where('id', '=', r.id).execute();
      removed += 1;
    } catch (err) {
      const attempts = r.attempts + 1;
      if (attempts >= MAX_REMOVAL_ATTEMPTS) {
        logger.error('provider draft removal abandoned - a stale draft stays in the mailbox', {
          userId: r.user_id,
          mailbox: r.provider_mailbox,
          err: (err as Error).message,
        });
        await db.deleteFrom('email_provider_draft_removals').where('id', '=', r.id).execute();
        continue;
      }
      await db
        .updateTable('email_provider_draft_removals')
        .set({ attempts, retry_at: new Date(Date.now() + backoffMs(attempts)).toISOString() })
        .where('id', '=', r.id)
        .execute();
    }
  }
  return { pushed, removed, dropped };
}

export function startProviderDraftSync(db: Kysely<DB>): { stop: () => void } {
  if (env.EMAIL_PROVIDER_DRAFT_SECONDS <= 0) {
    logger.info('provider draft sync off (EMAIL_PROVIDER_DRAFT_SECONDS=0)');
    return { stop: () => {} };
  }
  let inFlight = false;
  const interval = setInterval(async () => {
    // ADR 0280 - several worker copies would each write the same draft.
    if (inFlight || !isLeader('worker')) return;
    inFlight = true;
    try {
      await syncProviderDrafts(db);
    } catch (err) {
      logger.error('provider draft sync failed', { err: (err as Error).message });
    } finally {
      inFlight = false;
    }
  }, env.EMAIL_PROVIDER_DRAFT_SECONDS * 1000);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}
