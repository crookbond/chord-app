/**
 * Email → knowledge base (ADR 0071): after each sync, scan new mirror messages
 * for real attachments and save them into the user's PERSONAL group
 * via the normal `saveFile` pipeline — so extraction, summaries, FTS indexing,
 * the Attachments tab, and the bot's search all pick them up with zero new
 * surfaces. Bounded per tick; each message is scanned at most once
 * (`attachments_imported_at`), mirroring the magics pass.
 *
 * ADR 0110 — every mailbox, not just Gmail. ADR 0080 scoped this to Gmail
 * because attached accounts had "no fetchable attachment parts", and then its
 * own addendum built `fetchEmailAttachmentData` to fetch exactly those for the
 * download route. The constraint outlived its reason, and in prod it meant a
 * BitGo invoice — a PDF in the Outlook mailbox — was the one legible copy of an
 * amount nothing ever read.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { minablePredicate } from './bulk-gate.js';
import { searchablePredicate } from './folders.js';
import { saveFile } from '../attachments.service.js';
import { ensurePersonalGroup } from '../groups.service.js';
import {
  attachmentPartsFor,
  fetchEmailAttachmentData,
} from '../email-accounts/attachment-fetch.js';

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** Inline logos / signature images — named, but not knowledge. */
const MIN_IMAGE_BYTES = 20 * 1024;

export interface AttachmentImportResult {
  /** Messages scanned (and marked) this pass. */
  processed: number;
  /** Attachments actually saved. */
  imported: number;
}

export function shouldImport(part: { filename: string; mimeType: string; size: number }): boolean {
  if (!part.filename) return false;
  if (part.size > MAX_ATTACHMENT_BYTES) return false;
  if (part.mimeType.startsWith('image/') && part.size < MIN_IMAGE_BYTES) return false;
  // Calendar parts belong to the invite pipeline (magics UID proposals), not
  // the knowledge base — importing them just piles up "invite.ics" files.
  const mt = part.mimeType.toLowerCase();
  if (mt === 'text/calendar' || mt === 'application/ics' || /\.ics$/i.test(part.filename)) {
    return false;
  }
  return true;
}

export async function importEmailAttachments(
  db: Kysely<DB>,
  userId: string,
  opts: { limit?: number } = {},
): Promise<AttachmentImportResult> {
  const limit = Math.min(Math.max(opts.limit ?? env.EMAIL_ATTACHMENTS_BATCH_SIZE, 1), 50);
  const rows = await db
    .selectFrom('email_messages')
    .innerJoin('email_threads', 'email_threads.id', 'email_messages.thread_id')
    .select([
      'email_messages.id as id',
      'email_messages.thread_id as thread_id',
      'email_messages.gmail_message_id as gmail_message_id',
      'email_messages.gmail_label_ids as gmail_label_ids',
    ])
    .where('email_messages.user_id', '=', userId)
    .where('email_messages.attachments_imported_at', 'is', null)
    // ADR 0127 — a promotional blast's images are the clearest case of the
    // knowledge base filling with things nobody saved.
    .where(minablePredicate(userId, { prefix: 'email_threads.' }))
    // ADR 0073 — deleted mail feeds nothing. Left unmarked rather than
    // marked, so a thread restored from Trash is imported then. An archived
    // thread's files ARE imported (search reaches archived mail, ADR 0108);
    // the auto-filer is what skips it (`emailCopyFiling`).
    .where(searchablePredicate('email_threads.'))
    .orderBy('email_messages.internal_date', 'desc')
    .limit(limit)
    .execute();
  if (rows.length === 0) return { processed: 0, imported: 0 };

  const personal = await ensurePersonalGroup(db, userId);
  const now = new Date().toISOString();
  let imported = 0;
  // Every row is marked once it has been looked at, however it went (one bad
  // message must not wedge the queue). That was one UPDATE per row; it is one
  // for the batch. A crash before it just re-scans the batch, and the dupe
  // check below keeps a re-scan from saving a file twice.
  const done: string[] = [];
  const markDone = async (): Promise<void> => {
    if (done.length === 0) return;
    await db
      .updateTable('email_messages')
      .set({ attachments_imported_at: now })
      .where('id', 'in', done.splice(0))
      .execute();
  };

  for (const row of rows) {
    // Belt-and-suspenders: legacy spam rows (stored before the sync-side
    // filter) must never feed the knowledge base. Marked so they drop out
    // of the queue.
    const labels = Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : [];
    // A single trashed message (Gmail trashes per message) the same way.
    if (labels.includes('SPAM') || labels.includes('TRASH')) {
      done.push(row.id);
      continue;
    }
    try {
      const parts = (await attachmentPartsFor(db, userId, row.id)).filter(shouldImport);
      for (const part of parts) {
        // Same file forwarded across messages (or a re-scan after a partial
        // failure) — one copy per personal group is enough.
        const dupe = await db
          .selectFrom('attachments')
          .select('id')
          .where('scope_kind', '=', 'group')
          .where('scope_id', '=', personal.id)
          .where('filename', '=', part.filename)
          .where('size', '=', part.size)
          // A row whose blob is gone must not satisfy the dupe check — a
          // re-arrival of the same file is how the loss heals.
          .where('blob_missing_at', 'is', null)
          .executeTakeFirst();
        if (dupe) continue;
        const fetched = await fetchEmailAttachmentData(db, userId, row.id, part.id);
        if (!fetched) continue;
        const buffer = fetched.buffer;
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_ATTACHMENT_BYTES) continue;
        await saveFile(db, {
          scope: { kind: 'group', groupId: personal.id },
          uploadedBy: userId,
          filename: part.filename,
          mimeType: part.mimeType,
          buffer,
          // This pass already runs deferred (afterSync); awaiting keeps
          // extraction from outliving the caller's DB connection.
          awaitExtraction: true,
          // Links the copy to its email (the Attachments tab opens it from
          // there) and keeps its picture out of the screenshot suggestions.
          originEmailThreadId: row.thread_id,
        });
        imported += 1;
      }
    } catch (err) {
      logger.warn('email attachment import failed', {
        userId,
        messageId: row.gmail_message_id,
        err: (err as Error).message,
      });
    }
    // Mark even on failure — one bad message must not wedge the queue.
    done.push(row.id);
  }
  await markDone();

  if (imported > 0) {
    logger.info(`email attachments user=${userId} imported=${imported} scanned=${rows.length}`);
  }
  return { processed: rows.length, imported };
}
