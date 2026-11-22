/**
 * On-demand email-attachment download (ADR 0080 addendum): receipts,
 * statements, coupons. Bytes are never stored — the route streams them
 * straight from the owning mailbox's provider, dispatched by account.
 */
import type { Kysely } from 'kysely';

import type { EmailAttachmentRef } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { sealMessageContent } from '../email/content-seal.js';
import { listAttachmentParts, toAttachmentRef, type GmailRawMessage } from '../google/gmail-sync.js';
import { getGmailApi } from '../google/gmail-api.js';
import { getAccount, nativeId } from './account-utils.js';
import { gmailAccountApi } from './gmail-account.service.js';
import { imapAccountApi } from './imap.service.js';
import { imapLocationFromNativeMessageId } from './imap-sync.js';
import { getOutlookApi, outlookAttachmentRef } from './outlook-api.js';
import { refindOutlookAttachment } from './outlook.service.js';

export interface EmailAttachmentData {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export async function fetchEmailAttachmentData(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
  attId: string,
): Promise<EmailAttachmentData | null> {
  const row = await db
    .selectFrom('email_messages')
    .select(['id', 'account_id', 'gmail_message_id', 'attachments_json', 'rfc822_message_id', 'gmail_label_ids'])
    .where('id', '=', messageRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  const stored = Array.isArray(row.attachments_json) ? row.attachments_json : [];
  // An id the stored list no longer holds is not refused: the list is
  // rewritten when the thread is read again, and the reader may still hold
  // the id it was given before that (Gmail issues new attachment ids on every
  // read; Outlook re-issues them when a message moves). The provider decides.
  const meta = stored.find((a) => a.id === attId);

  if (!row.account_id || (await getAccount(db, userId, row.account_id))?.provider === 'gmail') {
    const att = await fetchGmailPart(db, userId, row, attId);
    if (!att) return null;
    const part = meta ?? partOfSize(stored, att.size);
    return {
      buffer: Buffer.from(att.data, 'base64url'),
      filename: part?.filename ?? 'attachment',
      mimeType: part?.mimeType ?? 'application/octet-stream',
    };
  }

  const account = await getAccount(db, userId, row.account_id);
  if (!account) return null;
  const native = nativeId(account.id, row.gmail_message_id);

  if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    let att = meta ? await api.getAttachment(native, attId) : null;
    if (!att) {
      // The message moved in Outlook and got new ids (docs/notes/0199), or the
      // stored list is not the one the reader was given.
      const found = await refindOutlookAttachment(db, api, account, row, meta ?? { id: attId });
      if (found) att = await api.getAttachment(found.graphId, found.attId);
    }
    if (!att) return null;
    return {
      buffer: Buffer.from(att.contentBytes, 'base64'),
      filename: att.name || meta?.filename || 'attachment',
      mimeType: att.contentType || meta?.mimeType || 'application/octet-stream',
    };
  }
  // A Sent message's UID is a Sent-mailbox UID; read in INBOX it names
  // whichever inbox message happens to share the number.
  const at = imapLocationFromNativeMessageId(native);
  const index = Number((attId.match(/^i(\d+)$/) ?? [])[1]);
  if (at === null || !Number.isFinite(index)) return null;
  const att = await imapAccountApi(account).fetchAttachment(at.uid, index, at.folder);
  if (!att) return null;
  return {
    buffer: att.content,
    filename: att.filename || meta?.filename || 'attachment',
    mimeType: att.mimeType || meta?.mimeType || 'application/octet-stream',
  };
}

/** A Gmail part's bytes, primary or attached mailbox. An id Gmail no longer
 *  knows is null, not an error: the route then answers 404. */
async function fetchGmailPart(
  db: Kysely<DB>,
  userId: string,
  row: { account_id: string | null; gmail_message_id: string },
  attId: string,
): Promise<{ data: string; size: number } | null> {
  let api;
  let messageId = row.gmail_message_id;
  if (!row.account_id) {
    api = await getGmailApi(db, userId);
  } else {
    const account = await getAccount(db, userId, row.account_id);
    if (!account) return null;
    api = await gmailAccountApi(db, account);
    messageId = nativeId(account.id, row.gmail_message_id);
  }
  try {
    return await api.getAttachment(messageId, attId);
  } catch (err) {
    if (/ (400|404): |attachments\.get failed/.test((err as Error).message)) return null;
    throw err;
  }
}

/** The one stored part of this size, for naming bytes fetched by an id the
 *  stored list no longer carries. */
function partOfSize(parts: EmailAttachmentRef[], size: number): EmailAttachmentRef | undefined {
  const same = parts.filter((p) => p.size === size);
  return same.length === 1 ? same[0] : undefined;
}

/**
 * The attachment parts of one mirrored message, discovering them if this is
 * the first time anyone asked (ADR 0110).
 *
 * `attachments_json` is null until something looks: IMAP fills it at sync and
 * Gmail now does too, but Outlook's delta only says WHETHER a message has
 * attachments, and rows that predate this change have nothing stored. Null
 * means "never looked", `[]` means "looked, none there" — so a message with no
 * attachments is settled once rather than re-fetched forever.
 */
export async function attachmentPartsFor(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
): Promise<EmailAttachmentRef[]> {
  const row = await db
    .selectFrom('email_messages')
    .select(['id', 'account_id', 'gmail_message_id', 'attachments_json'])
    .where('id', '=', messageRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return [];
  if (Array.isArray(row.attachments_json)) return row.attachments_json;

  const parts = await discoverParts(db, userId, row);
  await db
    .updateTable('email_messages')
    .set(await sealMessageContent(userId, { attachments_json: JSON.stringify(parts) }, { index: 'none' }))
    .where('id', '=', row.id)
    .execute();
  return parts;
}

async function discoverParts(
  db: Kysely<DB>,
  userId: string,
  row: { account_id: string | null; gmail_message_id: string },
): Promise<EmailAttachmentRef[]> {
  const fromGmailPayload = (raw: GmailRawMessage | null): EmailAttachmentRef[] =>
    raw
      ? listAttachmentParts(raw.payload).map(toAttachmentRef)
      : [];

  if (!row.account_id) {
    const api = await getGmailApi(db, userId);
    return fromGmailPayload(await api.getMessage(row.gmail_message_id, 'full'));
  }
  const account = await getAccount(db, userId, row.account_id);
  if (!account) return [];
  const native = nativeId(account.id, row.gmail_message_id);

  if (account.provider === 'gmail') {
    const api = await gmailAccountApi(db, account);
    return fromGmailPayload(await api.getMessage(native, 'full'));
  }
  if (account.provider === 'outlook') {
    const api = await getOutlookApi(db, account);
    const raw = await api.getMessage(native);
    // `hasAttachments` spares a list call on the majority that have none.
    if (!raw?.hasAttachments) return [];
    return (await api.listAttachments(native)).map(outlookAttachmentRef);
  }
  // IMAP parses the whole source at sync, so a null here means the row predates
  // that and the parts are not recoverable without a re-sync.
  return [];
}
