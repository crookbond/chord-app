import fs from 'node:fs/promises';
import path from 'node:path';

import mime from 'mime-types';
import { sql, type ExpressionBuilder, type Kysely } from 'kysely';
import { MAX_IMAGE_TAGS, normalizeImageTag, type Attachment, type ImageMeta } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { sealField, writeBlob } from '../db/crypto/index.js';
import type { AttachmentsTable, DB } from '../db/schema.js';
import { textInstant } from '../db/text-instant.js';
import { newId } from '../utils/ids.js';
import { extractAndSummarize } from './attachments.extract.js';
import { getLlmForUser } from './llm/factory.js';
import { canUseAi, isAiRefusal } from './llm/refusal.js';
import { queueAiWork } from './ai-backlog.service.js';
import { runInBackground } from '../utils/background.js';
import { indexAttachmentChunks, removeAttachmentChunks } from './attachments.index.js';
import { classifyAndAutoFileAttachment } from './bot/trip_classifier.js';
import { classifyAndProposeContent } from './bot/content_classifier.js';

export interface SaveFileInput {
  scope: { kind: 'group'; groupId: string } | { kind: 'user'; userId: string };
  uploadedBy: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
  /** Skip background LLM extraction + trip classification. Used by bulk
   *  imports so we don't fan out thousands of LLM calls. Default true. */
  index?: boolean;
  /** Await extraction instead of firing it in the background. Callers that
   *  already run in a deferred pipeline (email attachment import) use this so
   *  no work outlives their transaction/connection. */
  awaitExtraction?: boolean;
  /** Uploader's UTC offset in minutes (e.g. -300 for EST). Used to anchor
   *  bare-date calendar entries to local midnight instead of UTC midnight. */
  uploaderTzOffsetMinutes?: number;
  /** The email thread this file was copied out of (ADR 0071). Nobody posted
   *  it, so nothing is suggested from its picture: a scanned postcard or a
   *  marketing image is not a screenshot someone took to act on. The email
   *  itself gets its own, gated, suggestion pass. */
  originEmailThreadId?: string;
}

function scopeDir(scope: SaveFileInput['scope']): string {
  if (scope.kind === 'group') return path.join(env.FILES_DIR, 'group', scope.groupId);
  return path.join(env.FILES_DIR, 'user', scope.userId);
}

function parseImageMeta(raw: string | null): ImageMeta | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    const num = (k: string): number | undefined =>
      typeof o[k] === 'number' ? (o[k] as number) : undefined;
    const tagsRaw = o['tags'];
    const tags = Array.isArray(tagsRaw)
      ? Array.from(
          new Set(
            tagsRaw.map(normalizeImageTag).filter((t): t is string => t !== null),
          ),
        ).slice(0, MAX_IMAGE_TAGS)
      : [];
    return {
      caption: typeof o['caption'] === 'string' ? (o['caption'] as string) : null,
      keyFacts: Array.isArray(o['keyFacts']) ? (o['keyFacts'] as unknown[]).map(String) : [],
      tags,
      mimeType: typeof o['mimeType'] === 'string' ? (o['mimeType'] as string) : '',
      sourceMimeType:
        typeof o['sourceMimeType'] === 'string' ? (o['sourceMimeType'] as string) : undefined,
      sizeBytes: typeof o['sizeBytes'] === 'number' ? (o['sizeBytes'] as number) : 0,
      ocrChars: typeof o['ocrChars'] === 'number' ? (o['ocrChars'] as number) : 0,
      width: num('width'),
      height: num('height'),
      origWidth: num('origWidth'),
      origHeight: num('origHeight'),
      orientation:
        typeof o['orientation'] === 'number'
          ? (o['orientation'] as number)
          : o['orientation'] === null
            ? null
            : undefined,
      normalizedSizeBytes: num('normalizedSizeBytes'),
      normalized: typeof o['normalized'] === 'boolean' ? (o['normalized'] as boolean) : undefined,
    };
  } catch {
    return undefined;
  }
}

function rowToAttachment(row: AttachmentsTable): Attachment {
  const scope: Attachment['scope'] =
    row.scope_kind === 'group'
      ? { kind: 'group', groupId: row.scope_id }
      : { kind: 'user', userId: row.scope_id };
  return {
    id: row.id,
    scope,
    uploadedBy: row.uploaded_by,
    filename: row.filename,
    mimeType: row.mime_type,
    size: row.size,
    path: row.path,
    summary: row.summary ?? undefined,
    extractedText: row.extracted_text ?? undefined,
    imageMeta: parseImageMeta(row.image_meta),
    pinned: row.pinned === 1,
    blobMissing: row.blob_missing_at ? true : undefined,
    indexedAt: row.indexed_at ?? undefined,
    originEmailThreadId: row.origin_email_thread_id ?? undefined,
    createdAt: row.created_at,
  };
}

/**
 * Stamp an attachment whose blob turned out to be gone from disk (the
 * download route's ENOENT path). Search skips stamped rows; listings keep
 * them so the loss is visible and re-uploadable.
 */
export async function markBlobMissing(db: Kysely<DB>, attachmentId: string): Promise<void> {
  await db
    .updateTable('attachments')
    .set({ blob_missing_at: new Date().toISOString() })
    .where('id', '=', attachmentId)
    .where('blob_missing_at', 'is', null)
    .execute();
}

/** Client-supplied types we treat as "unknown" and try to recover from. */
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * Magic-byte sniff for the formats phones actually send. Last-resort when the
 * client gave no usable mime AND the filename has no helpful extension.
 */
function sniffMimeFromBuffer(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4).startsWith('GIF8')) return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'heif', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  return null;
}

/**
 * Resolve the real content type. The mobile document picker (and some IM
 * bridges) hand us `application/octet-stream` for images they don't recognize;
 * the image picker, by contrast, always sets `image/*`. A wrong mime silently
 * disables classification — vision extraction and the content/trip classifiers
 * all gate on `image/*` — so an octet-stream JPEG never gets tagged or filed.
 * When the provided type is missing or generic, recover it from the filename
 * extension, then from the buffer's magic bytes.
 */
export function resolveMimeType(provided: string, filename: string, buffer: Buffer): string {
  if (provided && !GENERIC_MIMES.has(provided.toLowerCase())) return provided;
  const fromName = mime.lookup(filename);
  if (fromName) return fromName;
  return sniffMimeFromBuffer(buffer) ?? provided ?? 'application/octet-stream';
}

export async function saveFile(
  db: Kysely<DB>,
  input: SaveFileInput,
): Promise<Attachment> {
  const mimeType = resolveMimeType(input.mimeType, input.filename, input.buffer);
  const id = newId('a');
  const dir = path.join(scopeDir(input.scope), id);
  await fs.mkdir(dir, { recursive: true });
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 128) || 'file';
  const full = path.join(dir, safeName);
  // Sealed under the owner's key when content encryption is on (ADR 0201). A
  // group-scope file belongs to the group, so any member's request can open it.
  await writeBlob(input.scope.kind === 'group' ? input.scope.groupId : input.scope.userId, full, input.buffer);
  const relative = path.relative(env.DATA_DIR, full);

  const now = new Date().toISOString();
  const row: AttachmentsTable = {
    id,
    scope_kind: input.scope.kind,
    scope_id: input.scope.kind === 'group' ? input.scope.groupId : input.scope.userId,
    uploaded_by: input.uploadedBy,
    filename: input.filename,
    mime_type: mimeType,
    size: input.buffer.byteLength,
    path: relative,
    summary: null,
    extracted_text: null,
    image_meta: null,
    pinned: 0,
    indexed_at: null,
    // Record intent: a row left unindexed because extraction was requested
    // (1) is an interrupted upload the boot sweep should retry; one that was
    // deliberately skipped (0) must never be re-extracted.
    index_requested: input.index === false ? 0 : 1,
    created_at: now,
    ...(input.originEmailThreadId ? { origin_email_thread_id: input.originEmailThreadId } : {}),
  };
  await db.insertInto('attachments').values(row).execute();

  if (input.index === false) {
    return rowToAttachment(row);
  }

  // Background-ish: kick off extraction, but attach errors to logger only.
  const extraction = runAttachmentExtraction(db, {
    id,
    fullPath: full,
    mimeType,
    filename: input.filename,
    scope: input.scope,
    uploadedBy: input.uploadedBy,
    uploaderTzOffsetMinutes: input.uploaderTzOffsetMinutes,
    originEmailThreadId: input.originEmailThreadId,
  });
  if (input.awaitExtraction) await extraction;

  return rowToAttachment(row);
}

interface ExtractionParams {
  id: string;
  /** Absolute on-disk path to the stored file. */
  fullPath: string;
  mimeType: string;
  filename: string;
  scope: SaveFileInput['scope'];
  uploadedBy: string;
  uploaderTzOffsetMinutes?: number;
  /** Copied out of this email (`email_threads.id`): no suggestions from its
   *  picture (see SaveFileInput), and the auto-filer applies the email path's
   *  rules (`emailCopyFiling`). */
  originEmailThreadId?: string;
}

/**
 * Extract + summarize a stored attachment, persist the result, build its
 * chunk index, and run the group auto-filers. Awaitable (tests + the boot
 * recovery sweep await it) but safe to fire-and-forget — all errors are
 * logged, never thrown. Shared by `saveFile` (fresh upload) and
 * `requeuePendingExtractions` (interrupted upload, retried on boot).
 */
export async function runAttachmentExtraction(
  db: Kysely<DB>,
  p: ExtractionParams,
): Promise<void> {
  try {
    const res = await extractAndSummarize({
      path: p.fullPath,
      mimeType: p.mimeType,
      filename: p.filename,
      llm: await getLlmForUser(db, p.uploadedBy, 'attachment_read'),
    });
    // Persist the extracted fields first so indexAttachmentChunks (which
    // reads them back from the row) sees them, then stamp indexed_at last.
    // indexed_at is the "fully indexed" signal callers poll on (boot
    // recovery, tests) — stamping it before the chunk index exists would
    // expose a window where the row looks done but has zero chunks.
    await db
      .updateTable('attachments')
      .set(
        await sealAttachmentText(p.scope.kind === 'group' ? p.scope.groupId : p.scope.userId, {
          extracted_text: res.text || null,
          summary: res.summary ?? null,
          image_meta: res.imageMeta ?? null,
          answerable_questions: res.answerableQuestions?.length
            ? res.answerableQuestions.join('\n')
            : null,
        }),
      )
      .where('id', '=', p.id)
      .execute();
    await indexAttachmentChunks(db, p.id);
    await db
      .updateTable('attachments')
      .set({ indexed_at: new Date().toISOString() })
      .where('id', '=', p.id)
      .execute();
    logger.info(
      `indexed ${p.filename}: text=${res.text.length} chars, summary=${res.summary ? 'y' : 'n'}`,
    );

    // ADR 0283 — the auto-filers below are model calls; the text extraction
    // and keyword index above are not, so a file still becomes searchable.
    // Without consent or an allowance the summary and the filers wait, and
    // the whole extraction is re-run once both are met (ai-backlog).
    if (!(await canUseAi(db, p.uploadedBy))) {
      await queueAiWork(db, { userId: p.uploadedBy, kind: 'attachment', ref: p.id });
      return;
    }

    let autoFiled = false;
    if (p.scope.kind === 'group' && (res.text || res.pageImage)) {
      autoFiled = await classifyAndAutoFileAttachment(db, {
        attachmentId: p.id,
        groupId: p.scope.groupId,
        uploadedBy: p.uploadedBy,
        filename: p.filename,
        extractedText: res.text,
        pageImage: res.pageImage,
        uploaderTzOffsetMinutes: p.uploaderTzOffsetMinutes,
        originEmailThreadId: p.originEmailThreadId,
      });
    }

    // Skip the general image content classifier when the trip/recipe/etc.
    // auto-filer already handled this doc — otherwise a flight itinerary
    // becomes both a trip AND duplicate calendar-event proposals (which then
    // conflict with the trip on confirm).
    if (
      !autoFiled &&
      !p.originEmailThreadId &&
      p.scope.kind === 'group' &&
      p.mimeType.startsWith('image/') &&
      res.imageMeta
    ) {
      const meta = JSON.parse(res.imageMeta) as ImageMeta;
      await classifyAndProposeContent(db, {
        attachmentId: p.id,
        groupId: p.scope.groupId,
        uploadedBy: p.uploadedBy,
        filename: p.filename,
        mimeType: p.mimeType,
        imagePath: p.fullPath,
        imageMeta: meta,
      });
    }
  } catch (err) {
    if (isAiRefusal(err)) {
      await queueAiWork(db, { userId: p.uploadedBy, kind: 'attachment', ref: p.id });
      return;
    }
    // Error fields aren't enumerable, so a bare `{ err }` logs as `{}` and
    // hides the cause (e.g. an OpenRouter 401 from the vision/classifier LLM,
    // which silently kills image tagging + trip auto-filing). Pull the useful
    // fields out explicitly — same pattern as the bot LLM-error log.
    const e = err as { message?: string; status?: number; code?: string };
    logger.error(`indexing error for ${p.filename}: ${e.message ?? String(err)}`, {
      status: e.status,
      code: e.code,
    });
  }
}

/**
 * Re-run extraction for attachments left unindexed by an interrupted upload
 * (process crash / restart mid-extraction). Only rows that requested indexing
 * (`index_requested = 1`) and are older than `minAgeMs` are retried — the age
 * guard avoids racing an upload still in flight during a rolling restart, and
 * the flag skips files that were deliberately never indexed. Extractions run
 * in the background; the returned count is how many were requeued.
 */
export async function requeuePendingExtractions(
  db: Kysely<DB>,
  minAgeMs = 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - minAgeMs).toISOString();
  const rows = await db
    .selectFrom('attachments')
    .selectAll()
    .where('indexed_at', 'is', null)
    .where('index_requested', '=', 1)
    .where('created_at', '<', cutoff)
    .execute();

  for (const row of rows) {
    runInBackground(
      runAttachmentExtraction(db, extractionParamsFor(row)).catch((err) =>
        logger.error('requeued attachment extraction failed', { err, id: row.id }),
      ),
    );
  }

  if (rows.length > 0) {
    logger.info(`requeued ${rows.length} interrupted attachment extraction(s)`);
  }
  return rows.length;
}

function extractionParamsFor(row: AttachmentsTable): ExtractionParams {
  return {
    id: row.id,
    fullPath: absolutePathFor(rowToAttachment(row)),
    mimeType: row.mime_type,
    filename: row.filename,
    scope:
      row.scope_kind === 'group'
        ? { kind: 'group', groupId: row.scope_id }
        : { kind: 'user', userId: row.scope_id },
    uploadedBy: row.uploaded_by,
    originEmailThreadId: row.origin_email_thread_id ?? undefined,
  };
}

/** ai-backlog runner: re-run a held-back file's extraction now that AI may
 *  run. A file deleted since is skipped. */
export async function rerunHeldBackExtraction(db: Kysely<DB>, attachmentId: string): Promise<void> {
  const row = await db.selectFrom('attachments').selectAll().where('id', '=', attachmentId).executeTakeFirst();
  if (!row) return;
  await runAttachmentExtraction(db, extractionParamsFor(row));
}

export async function getAttachment(
  db: Kysely<DB>,
  id: string,
): Promise<Attachment | null> {
  const row = await db
    .selectFrom('attachments')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToAttachment(row) : null;
}

export async function listAttachmentsForGroup(
  db: Kysely<DB>,
  groupId: string,
): Promise<Attachment[]> {
  const rows = await db
    .selectFrom('attachments')
    .selectAll()
    .where('scope_kind', '=', 'group')
    .where('scope_id', '=', groupId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToAttachment);
}

/**
 * Every group attachment visible to a user: the union across all groups
 * they belong to. Mirrors the `/me/*` aggregation contract used by tasks,
 * lists, saves, and trips — any group member sees every file in the group.
 */
export async function listAttachmentsForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<Attachment[]> {
  const rows = await db
    .selectFrom('attachments')
    .innerJoin('group_members', 'group_members.group_id', 'attachments.scope_id')
    .where('attachments.scope_kind', '=', 'group')
    .where('group_members.user_id', '=', userId)
    .selectAll('attachments')
    .orderBy('attachments.created_at', 'desc')
    .execute();
  return rows.map(rowToAttachment);
}

/**
 * Delete an attachment: drop its FTS chunks so retrieval forgets it,
 * remove the row, and unlink the on-disk file — but only when no other
 * attachment row still references the same `path`. Sharing
 * (`copyAttachmentToGroup`) creates sibling rows that point at the same
 * file on disk, so unlinking unconditionally would break the shared copy.
 * Returns false when the id doesn't exist.
 */
export async function deleteAttachment(
  db: Kysely<DB>,
  id: string,
): Promise<boolean> {
  const att = await getAttachment(db, id);
  if (!att) return false;

  await removeAttachmentChunks(db, id);
  await db.deleteFrom('attachments').where('id', '=', id).execute();

  const sharers = await db
    .selectFrom('attachments')
    .select('id')
    .where('path', '=', att.path)
    .limit(1)
    .execute();
  if (sharers.length === 0) {
    try {
      await fs.unlink(absolutePathFor(att));
    } catch (err) {
      // ENOENT is benign (file already gone); log anything else.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error('attachment unlink error', { err, id });
      }
    }
  }
  return true;
}

/**
 * A direct upload (chat, WhatsApp, the mobile picker) is the user's own
 * explicit act of keeping something — never touched here. Only mail's
 * ADR 0071 auto-import pipeline (`origin_email_thread_id` set) produces
 * INCIDENTAL attachments nobody chose to keep (a marketing logo, a coupon
 * banner, alongside the genuinely useful PDF), and by the time this sweep
 * would run, that pipeline's real value — tasks/events/facts it staged —
 * is already durable elsewhere; the raw file copy is a byproduct. Pinning
 * (the existing "keep this" signal, `setAttachmentPinned`) exempts a row
 * indefinitely, same as a direct upload.
 *
 * Reuses `deleteAttachment` rather than a bespoke bulk delete so the
 * path-sharing safety (don't unlink a file another row still references)
 * and FTS-chunk cleanup can't drift from the single-row delete path.
 */
export async function expireIncidentalAttachments(db: Kysely<DB>): Promise<number> {
  const cutoff = new Date(
    Date.now() - env.ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60_000,
  ).toISOString();
  const rows = await db
    .selectFrom('attachments')
    .select('id')
    .where('origin_email_thread_id', 'is not', null)
    .where('pinned', '=', 0)
    .where('created_at', '<', cutoff)
    .execute();
  let n = 0;
  for (const row of rows) {
    if (await deleteAttachment(db, row.id)) n += 1;
  }
  return n;
}

/**
 * A boarding pass / hotel confirmation's whole purpose is getting the family
 * through the trip — once the last leg it's attached to has landed, or the
 * last stay has checked out, the attachment has no more ongoing reason to
 * occupy storage than a delivered parcel does (ADR 0135's `dropArrivedDeliveries`
 * reasoning, applied to the source file rather than a derived tile fact).
 *
 * Unlike `expireIncidentalAttachments`, this runs on the ATTACHMENT'S
 * OWN DATE, not upload age or origin — a directly-uploaded boarding-pass
 * screenshot is just as done as an emailed one once the flight lands, and
 * this sweep reaches both. Pinning still exempts a row indefinitely.
 *
 * The link is `travel_legs.source_doc_id` / `accommodations.source_doc_id`
 * (set by `classifyAndAutoFileAttachment`, ADR 0158) — the attachment that
 * PRODUCED the leg/stay. A single itinerary PDF backing several legs (a
 * round trip) survives until the LATEST one passes: an attachment expires
 * only when EVERY leg/accommodation referencing it is either past the grace
 * window or belongs to a trip the user already deleted (ADR 0171) — a
 * `deleted_at` trip's own dates no longer count as "still needed" even if
 * they're in the future, since the user already said they don't want it.
 */
export async function expireExpiredItineraryAttachments(db: Kysely<DB>): Promise<number> {
  const cutoff = new Date(
    Date.now() - env.ATTACHMENT_ITINERARY_GRACE_DAYS * 24 * 60 * 60_000,
  ).toISOString();

  // Driven from the (few) legs and stays that name a source file, not from
  // every attachment: this runs every proactive tick, and an EXISTS per
  // attachment row scanned the whole attachments table each time.
  const linkedToTrip = (eb: ExpressionBuilder<DB, 'attachments'>) =>
    eb(
      'attachments.id',
      'in',
      eb
        .selectFrom('travel_legs')
        .select('travel_legs.source_doc_id as id')
        .where('travel_legs.source_doc_id', 'is not', null)
        .union(
          eb
            .selectFrom('accommodations')
            .select('accommodations.source_doc_id as id')
            .where('accommodations.source_doc_id', 'is not', null),
        ),
    );

  const stillNeededLeg = (eb: ExpressionBuilder<DB, 'attachments'>) =>
    eb.exists(
      eb
        .selectFrom('travel_legs')
        .innerJoin('trips', 'trips.id', 'travel_legs.trip_id')
        .select('travel_legs.id')
        .whereRef('travel_legs.source_doc_id', '=', 'attachments.id')
        .where('trips.deleted_at', 'is', null)
        // An arrival is on its airport's clock (ADR 0240): compare instants.
        .where(sql<boolean>`${textInstant('travel_legs.arrive_at')} >= ${cutoff}::timestamptz`),
    );

  const stillNeededStay = (eb: ExpressionBuilder<DB, 'attachments'>) =>
    eb.exists(
      eb
        .selectFrom('accommodations')
        .innerJoin('trips', 'trips.id', 'accommodations.trip_id')
        .select('accommodations.id')
        .whereRef('accommodations.source_doc_id', '=', 'attachments.id')
        .where('trips.deleted_at', 'is', null)
        // A checkout is a day; the cutoff's day still counts as inside.
        .where('accommodations.checkout_date', '>=', cutoff.slice(0, 10)),
    );

  const rows = await db
    .selectFrom('attachments')
    .select('id')
    .where('pinned', '=', 0)
    .where((eb) => linkedToTrip(eb))
    .where((eb) => eb.not(stillNeededLeg(eb)))
    .where((eb) => eb.not(stillNeededStay(eb)))
    .execute();

  let n = 0;
  for (const row of rows) {
    if (await deleteAttachment(db, row.id)) n += 1;
  }
  return n;
}

export async function copyAttachmentToGroup(
  db: Kysely<DB>,
  source: Attachment,
  groupId: string,
  uploadedBy: string,
  tzOffsetMinutes?: number,
): Promise<Attachment> {
  const id = newId('a');
  const now = new Date().toISOString();
  const row: AttachmentsTable = {
    id,
    scope_kind: 'group',
    scope_id: groupId,
    uploaded_by: uploadedBy,
    filename: source.filename,
    mime_type: source.mimeType,
    size: source.size,
    path: source.path,
    summary: source.summary ?? null,
    extracted_text: source.extractedText ?? null,
    image_meta: source.imageMeta ? JSON.stringify(source.imageMeta) : null,
    pinned: 0,
    indexed_at: source.indexedAt ?? null,
    created_at: now,
  };
  // The copy belongs to the target group, so its text is sealed under THAT
  // group's key; `row` stays plaintext for the value returned to the caller.
  await db
    .insertInto('attachments')
    .values({
      ...row,
      ...(await sealAttachmentText(groupId, {
        summary: row.summary,
        extracted_text: row.extracted_text,
        image_meta: row.image_meta,
      })),
    })
    .execute();
  const copy = rowToAttachment(row);

  // Index the new copy so its chunks live under the new id (queries
  // filter by attachment_id, so we need fresh rows even though the text
  // is identical).
  if (source.extractedText || source.summary || source.imageMeta) {
    await indexAttachmentChunks(db, copy.id);
  }

  // Re-run classification for the target group so trips/events/etc. are
  // created there too. The extracted text is already on the source, so no
  // re-extraction is needed.
  if (source.extractedText && !(await canUseAi(db, uploadedBy))) {
    await queueAiWork(db, { userId: uploadedBy, kind: 'attachment', ref: copy.id });
  } else if (source.extractedText) {
    void classifyAndAutoFileAttachment(db, {
      attachmentId: copy.id,
      groupId,
      uploadedBy,
      filename: source.filename,
      extractedText: source.extractedText,
      uploaderTzOffsetMinutes: tzOffsetMinutes,
    }).catch((err) => logger.error('classify-on-share error', { err }));
  }

  return copy;
}

export async function setAttachmentPinned(
  db: Kysely<DB>,
  id: string,
  pinned: boolean,
): Promise<void> {
  await db
    .updateTable('attachments')
    .set({ pinned: pinned ? 1 : 0 })
    .where('id', '=', id)
    .execute();
}

/**
 * Patch the editable text fields of an attachment row: `tags` (rewrites
 * the `tags` array inside image_meta and refreshes the leading
 * "Tags: ..." line in summary so BM25 picks up the change), and
 * `summary` (verbatim replacement of the human-visible blurb). Either
 * field can be set independently. Returns the fresh Attachment.
 */
export async function patchAttachmentMeta(
  db: Kysely<DB>,
  id: string,
  patch: { tags?: string[]; summary?: string | null },
): Promise<Attachment | null> {
  const row = await db
    .selectFrom('attachments')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return null;

  let nextImageMeta: string | null = row.image_meta;
  let nextSummary: string | null = row.summary;

  if (patch.tags !== undefined) {
    const normalized = Array.from(
      new Set(patch.tags.map(normalizeImageTag).filter((t): t is string => t !== null)),
    ).slice(0, MAX_IMAGE_TAGS);
    // Update image_meta.tags (preserve other fields).
    const parsed = parseImageMeta(row.image_meta);
    const merged = { ...(parsed ?? {}), tags: normalized };
    nextImageMeta = JSON.stringify(merged);

    // Rewrite the leading "Tags: ..." line of summary so BM25 stays
    // in lockstep. If the summary's first line was a Tags: line, drop
    // it; then prepend the fresh one (or omit when normalized is empty).
    const baseSummary = stripLeadingTagsLine(nextSummary ?? '');
    if (normalized.length > 0) {
      nextSummary = baseSummary ? `Tags: ${normalized.join(', ')}\n${baseSummary}` : `Tags: ${normalized.join(', ')}`;
    } else {
      nextSummary = baseSummary || null;
    }
  }

  if (patch.summary !== undefined) {
    nextSummary = patch.summary && patch.summary.trim() ? patch.summary.trim() : null;
  }

  await db
    .updateTable('attachments')
    .set(await sealAttachmentText(row.scope_id, { image_meta: nextImageMeta, summary: nextSummary }))
    .where('id', '=', id)
    .execute();
  return getAttachment(db, id);
}

function stripLeadingTagsLine(s: string): string {
  if (!s) return '';
  const nl = s.indexOf('\n');
  const first = nl === -1 ? s : s.slice(0, nl);
  if (/^Tags:\s/i.test(first)) {
    return nl === -1 ? '' : s.slice(nl + 1);
  }
  return s;
}

/**
 * The derived text of an attachment (what was read out of it, and what was
 * said about it) is as sensitive as the file, so it is sealed under the same
 * owner (ADR 0201). Absent fields stay absent; null and '' are left alone.
 */
export async function sealAttachmentText(
  owner: string,
  fields: Partial<Record<'summary' | 'extracted_text' | 'image_meta' | 'answerable_questions', string | null>>,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [col, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[col] = await sealField(owner, `attachments:${col}`, value);
  }
  return out;
}

export function absolutePathFor(att: Attachment): string {
  return path.join(env.DATA_DIR, att.path);
}
