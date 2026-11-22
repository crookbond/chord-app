/**
 * Unsent mail (ADR 0113).
 *
 * A draft is an unfinished answer, which ADR 0107 puts on Chord's side of the
 * line — so these are ours, not the provider's. That is also the only way
 * autosave can be cheap: a local row can be rewritten every second without
 * asking Gmail's permission.
 *
 * The upsert rule is what makes autosave idempotent. A reply or forward has at
 * most ONE draft per thread (enforced by a partial unique index, not just by
 * this code), so typing does not mint a row per session. A composed message has
 * no thread, so the client holds its id after the first save.
 */
import type { Kysely } from 'kysely';

import type { EmailDraft, EmailDraftKind, EmailDraftRequest } from '@chord/kernel';

import { sealField } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { describeOutgoingAttachments } from './outgoing-attachments.js';

interface DraftRow {
  id: string;
  kind: string;
  thread_id: string | null;
  account_id: string | null;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  body: string;
  attachment_ids: string[];
  updated_at: string;
  last_error: string | null;
  forward_message_id: string | null;
  body_format: string | null;
  body_html: string | null;
}

/**
 * What the list row shows. Computed here rather than on each client so the
 * three of them cannot disagree about what an empty draft looks like — and an
 * empty draft is the normal case for a second or two after it is created.
 */
function previewOf(row: { subject: string; body: string }): string {
  const subject = row.subject.trim();
  if (subject) return subject;
  const firstLine = row.body.split('\n').find((l) => l.trim().length > 0)?.trim();
  return firstLine ? firstLine.slice(0, 120) : '(no subject)';
}

function toDraft(row: DraftRow): EmailDraft {
  return {
    id: row.id,
    kind: row.kind as EmailDraftKind,
    threadId: row.thread_id,
    accountId: row.account_id,
    to: row.to_emails,
    cc: row.cc_emails,
    bcc: row.bcc_emails,
    subject: row.subject,
    body: row.body,
    ...(row.body_format === 'plain' || row.body_format === 'rich' ? { format: row.body_format } : {}),
    ...(row.body_format === 'rich' ? { bodyHtml: row.body_html } : {}),
    attachmentIds: row.attachment_ids,
    updatedAt: row.updated_at,
    preview: previewOf(row),
    lastError: row.last_error,
    forwardMessageId: row.forward_message_id,
  };
}

const COLUMNS = [
  'id',
  'kind',
  'thread_id',
  'account_id',
  'to_emails',
  'cc_emails',
  'bcc_emails',
  'subject',
  'body',
  'attachment_ids',
  'updated_at',
  'last_error',
  'forward_message_id',
  'body_format',
  'body_html',
] as const;

/** Create or update, resolving which by id, then by thread. */
export async function saveDraft(
  db: Kysely<DB>,
  userId: string,
  input: EmailDraftRequest,
): Promise<EmailDraft> {
  const now = new Date().toISOString();
  const fields = {
    kind: input.kind,
    thread_id: input.threadId ?? null,
    account_id: input.accountId ?? null,
    to_emails: JSON.stringify(input.to ?? []),
    cc_emails: JSON.stringify(input.cc ?? []),
    bcc_emails: JSON.stringify(input.bcc ?? []),
    // ADR 0201 - a draft is mail in progress; sealed like the mail it becomes.
    subject: await sealField(userId, 'email_drafts:subject', input.subject ?? ''),
    body: await sealField(userId, 'email_drafts:body', input.body ?? ''),
    attachment_ids: JSON.stringify(input.attachmentIds ?? []),
    // ADR 0339. Left alone when omitted (an older app's autosave).
    ...(input.format !== undefined
      ? {
          body_format: input.format,
          body_html:
            input.format === 'rich' && input.bodyHtml
              ? await sealField(userId, 'email_drafts:body_html', input.bodyHtml)
              : null,
        }
      : {}),
    updated_at: now,
    // New text is a new attempt at the provider copy (ADR 0303), whatever
    // the last one ran into.
    provider_attempts: 0,
    provider_retry_at: null,
    // Left alone when omitted: an older app's autosave does not know the
    // field, and must not unpin the message a newer one chose.
    ...(input.forwardMessageId !== undefined
      ? { forward_message_id: input.forwardMessageId ?? null }
      : {}),
  };

  // An explicit id wins; otherwise a thread-scoped draft finds its own row, so
  // a reply typed across two sittings stays one draft.
  let existingId = input.id ?? null;
  if (!existingId && input.threadId) {
    const found = await db
      .selectFrom('email_drafts')
      .select('id')
      .where('user_id', '=', userId)
      .where('kind', '=', input.kind)
      .where('thread_id', '=', input.threadId)
      .executeTakeFirst();
    existingId = found?.id ?? null;
  }

  if (existingId) {
    const updated = await db
      .updateTable('email_drafts')
      .set(fields)
      .where('id', '=', existingId)
      .where('user_id', '=', userId)
      .returning(COLUMNS)
      .executeTakeFirst();
    // A draft deleted in another window between save and save. Falling through
    // to an insert beats throwing at someone who is still typing.
    if (updated) return toDraft(updated as DraftRow);
  }

  const row = await db
    .insertInto('email_drafts')
    .values({ id: newId('edr'), user_id: userId, created_at: now, ...fields })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toDraft(row as DraftRow);
}

/**
 * Drafts, meaning things still being written. A row with `send_after` set is
 * on its way out (ADR 0115) and deliberately absent here: it is not something
 * the user can pick up and edit, and showing it would invite exactly that. A
 * send that fails clears the stamp, so a message that could not go comes back
 * to this list carrying its `lastError`.
 */
export async function listDrafts(db: Kysely<DB>, userId: string): Promise<EmailDraft[]> {
  const rows = await db
    .selectFrom('email_drafts')
    .select(COLUMNS)
    .where('user_id', '=', userId)
    .where('send_after', 'is', null)
    .orderBy('updated_at', 'desc')
    .limit(200)
    .execute();
  return rows.map((r) => toDraft(r as DraftRow));
}

export async function getDraft(
  db: Kysely<DB>,
  userId: string,
  id: string,
): Promise<EmailDraft | null> {
  const row = await db
    .selectFrom('email_drafts')
    .select(COLUMNS)
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  const draft = toDraft(row as DraftRow);
  return {
    ...draft,
    attachments: await describeOutgoingAttachments(db, userId, draft.attachmentIds),
  };
}

/**
 * The one draft a thread's reply or forward has, with its files named. This is
 * what lets a composer opened again pick up what was written last time.
 */
export async function getThreadDraft(
  db: Kysely<DB>,
  userId: string,
  kind: EmailDraftKind,
  threadId: string,
): Promise<EmailDraft | null> {
  const row = await db
    .selectFrom('email_drafts')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .where('thread_id', '=', threadId)
    .where('send_after', 'is', null)
    .executeTakeFirst();
  return row ? getDraft(db, userId, row.id) : null;
}

/** Idempotent: a draft already gone is a success, since that is the state the
 *  caller wanted and a send should not fail on its own cleanup. Its copy in
 *  the mailbox's Drafts folder (ADR 0303) is queued for removal, not removed
 *  here, so a send never waits on - or fails on - a provider round trip. */
export async function deleteDraft(db: Kysely<DB>, userId: string, id: string): Promise<void> {
  const gone = await db
    .deleteFrom('email_drafts')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .returning(['provider_ref', 'provider_mailbox'])
    .executeTakeFirst();
  if (gone?.provider_ref && gone.provider_mailbox) {
    await queueProviderDraftRemoval(db, userId, gone.provider_mailbox, gone.provider_ref);
  }
}

/** ADR 0303 - a provider draft copy to delete on the next provider-draft pass. */
export async function queueProviderDraftRemoval(
  db: Kysely<DB>,
  userId: string,
  mailbox: string,
  ref: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('email_provider_draft_removals')
    .values({
      id: newId('epr'),
      user_id: userId,
      provider_mailbox: mailbox,
      provider_ref: ref,
      retry_at: now,
      created_at: now,
    })
    .execute();
}
