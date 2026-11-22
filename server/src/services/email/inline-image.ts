/**
 * The bytes behind a body's `<img src="cid:…">` — a part of the message itself
 * (a signature logo, a pasted photo), fetched from the reader's own mailbox.
 *
 * Nothing about this leaves the reader's trust boundary the way a remote image
 * does (ADR 0120), so it is not gated on the remote-image setting; it only
 * needs the part the body names. Served through the same sealed image token as
 * the remote proxy (ADR 0136) because an `<img>` cannot send a session header.
 */
import type { Kysely } from 'kysely';

import { normalizeContentId } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import {
  fetchEmailAttachmentData,
  type EmailAttachmentData,
} from '../email-accounts/attachment-fetch.js';
import { readStoredInlineImage, storeInlineImage } from './image-preload.js';

export async function fetchInlineImage(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
  rawContentId: string,
): Promise<EmailAttachmentData | null> {
  const row = await db
    .selectFrom('email_messages')
    .select(['attachments_json'])
    .where('id', '=', messageRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  const cid = normalizeContentId(rawContentId);
  if (!cid) return null;
  const part = (Array.isArray(row.attachments_json) ? row.attachments_json : []).find(
    (a) => a.contentId === cid,
  );
  if (!part) return null;
  const stored = await readStoredInlineImage(db, userId, messageRowId, cid);
  if (stored) return { buffer: stored.body, filename: part.filename, mimeType: stored.contentType };
  const data = await fetchEmailAttachmentData(db, userId, messageRowId, part.id);
  // An <img> is the only consumer; anything else behind a cid reference is
  // not something this route should hand to a renderer.
  if (!data || !data.mimeType.toLowerCase().startsWith('image/')) return null;
  await storeInlineImage(db, userId, messageRowId, cid, { body: data.buffer, contentType: data.mimeType });
  return data;
}
