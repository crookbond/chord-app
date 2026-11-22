/**
 * Remote email images fetched when the mail arrives (ADR 0225).
 *
 * ADR 0136's proxy hides who is reading but not that they read: the fetch
 * happens when the mail is opened, so its timing is the read receipt. Fetching
 * every message's images at sync instead makes the fetch a fact about delivery.
 * Every message looks opened, at a time the reader did not choose, from our
 * address — and opening it later sends the sender nothing at all.
 *
 * The reader is unchanged. It still asks the proxy route for each image; the
 * route answers from this store when it can and fetches live when it cannot.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Kysely } from 'kysely';

import { checkSender, linkHostsFromHtml, remoteImageUrlsInHtml, type SenderAuth } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { readBlob, writeBlob } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { type FetchedImage, fetchRemoteImage, parseImageUrl } from './image-proxy.js';
import { autoLoadsImages } from './image-senders.js';
import { knownDomains } from './sender-check/annotate.js';

/** A newsletter can carry hundreds of image references; past this the rest
 *  load when the mail is opened. */
const MAX_IMAGES_PER_MESSAGE = 40;
const FETCH_CONCURRENCY = 4;
const PRUNE_BATCH = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ImageFetcher = (url: URL, maxBytes: number) => Promise<FetchedImage | null>;

export interface ImagePreloadResult {
  /** Messages gone through (and marked) this pass. */
  messages: number;
  /** Images stored this pass. */
  stored: number;
}

/** One name for an image, shared by the pass that stores it and the route that
 *  serves it: the parsed address, so two spellings of one URL are one entry. */
export function imageUrlHash(url: URL): string {
  return createHash('sha256').update(url.toString()).digest('hex');
}

function userDir(userId: string): string {
  return path.join(env.DATA_DIR, 'email-images', userId);
}

function imagePath(userId: string, urlHash: string): string {
  return path.join(userDir(userId), urlHash);
}

function preloadEnabled(): boolean {
  return env.EMAIL_IMAGE_PROXY && env.EMAIL_IMAGE_PRELOAD;
}

/** The stored copy of an image, or null when there is none to serve. */
export async function readPreloadedImage(
  db: Kysely<DB>,
  userId: string,
  url: URL,
): Promise<FetchedImage | null> {
  if (!preloadEnabled()) return null;
  return readStoredImage(db, userId, imageUrlHash(url));
}

/** A stored image by its key, or null (no row, or its file is gone). */
async function readStoredImage(
  db: Kysely<DB>,
  userId: string,
  urlHash: string,
): Promise<FetchedImage | null> {
  const row = await db
    .selectFrom('email_image_cache')
    .select('content_type')
    .where('user_id', '=', userId)
    .where('url_hash', '=', urlHash)
    .executeTakeFirst();
  if (!row) return null;
  try {
    return { body: await readBlob(imagePath(userId, urlHash)), contentType: row.content_type };
  } catch (err) {
    // A row without its file (a restored database, a cleared data dir) must
    // not stop the image loading: the caller fetches it live instead.
    logger.warn('preloaded email image unreadable', { userId, err: (err as Error).message });
    return null;
  }
}

async function pruneExpired(db: Kysely<DB>, userId: string, cutoff: string): Promise<void> {
  const old = await db
    .selectFrom('email_image_cache')
    .select('url_hash')
    .where('user_id', '=', userId)
    .where('fetched_at', '<', cutoff)
    .limit(PRUNE_BATCH)
    .execute();
  if (old.length === 0) return;
  const hashes = old.map((r) => r.url_hash);
  await db
    .deleteFrom('email_image_cache')
    .where('user_id', '=', userId)
    .where('url_hash', 'in', hashes)
    .execute();
  await mapConcurrent(hashes, 8, (h) => fs.unlink(imagePath(userId, h)).catch(() => undefined));
}

/**
 * Fetch and store the remote images of this user's newest unprocessed mail.
 *
 * Each message is gone through once, however it went: a fetch that failed is
 * not retried here, because the proxy still fetches it when the mail is opened.
 */
export async function preloadEmailImages(
  db: Kysely<DB>,
  userId: string,
  fetcher: ImageFetcher = fetchRemoteImage,
): Promise<ImagePreloadResult> {
  if (!preloadEnabled()) return { messages: 0, stored: 0 };
  // A reader who blocks images has asked for nothing to be fetched on their
  // behalf; a fetch at delivery still tells the sender the address is live.
  if (!(await autoLoadsImages(db, userId))) return { messages: 0, stored: 0 };

  const cutoff = new Date(Date.now() - env.EMAIL_IMAGE_PRELOAD_DAYS * DAY_MS).toISOString();
  await pruneExpired(db, userId, cutoff);

  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'body_html', 'gmail_label_ids', 'from_name', 'from_email', 'reply_to', 'auth_results', 'attachments_json'])
    .where('user_id', '=', userId)
    .where('images_preloaded_at', 'is', null)
    .where('body_html', 'is not', null)
    .where('internal_date', '>=', cutoff)
    .orderBy('internal_date', 'desc')
    .limit(env.EMAIL_IMAGE_PRELOAD_BATCH)
    .execute();
  if (rows.length === 0) return { messages: 0, stored: 0 };

  await fs.mkdir(userDir(userId), { recursive: true });
  let stored = 0;
  const known = await knownDomains(db, userId);

  for (const row of rows) {
    const labels = Array.isArray(row.gmail_label_ids) ? row.gmail_label_ids : [];
    // Junk is the one sender who must not learn the address is live - and
    // neither is mail that is not from who it says (ADR 0294), which the
    // provider's filter let through.
    const skip =
      labels.includes('SPAM') ||
      labels.includes('TRASH') ||
      (!labels.includes('SENT') && suspectSender(row, known));
    if (!skip) {
      try {
        stored += await preloadMessage(db, userId, row.body_html ?? '', fetcher);
      } catch (err) {
        logger.warn('email image preload failed for a message', {
          userId,
          messageId: row.id,
          err: (err as Error).message,
        });
      }
    }
    await db
      .updateTable('email_messages')
      .set({ images_preloaded_at: new Date().toISOString() })
      .where('id', '=', row.id)
      .execute();
  }
  return { messages: rows.length, stored };
}

/** The same checks the reader runs, minus history: enough to say "danger". */
function suspectSender(
  row: {
    from_name: string | null;
    from_email: string | null;
    reply_to: string | null;
    auth_results: SenderAuth | null;
    attachments_json?: { filename: string }[] | null;
    body_html: string | null;
  },
  known: string[],
): boolean {
  return (
    checkSender({
      fromName: row.from_name,
      fromEmail: row.from_email,
      replyTo: row.reply_to,
      auth: row.auth_results,
      toEmails: [],
      ccEmails: [],
      ownAddresses: [],
      linkHosts: linkHostsFromHtml(row.body_html),
      attachmentNames: Array.isArray(row.attachments_json) ? row.attachments_json.map((a) => a.filename) : [],
      knownDomains: known,
    }).level === 'danger'
  );
}

async function preloadMessage(
  db: Kysely<DB>,
  userId: string,
  html: string,
  fetcher: ImageFetcher,
): Promise<number> {
  const targets = new Map<string, URL>();
  for (const raw of remoteImageUrlsInHtml(html)) {
    const url = parseImageUrl(raw);
    if (url) targets.set(imageUrlHash(url), url);
    if (targets.size >= MAX_IMAGES_PER_MESSAGE) break;
  }
  if (targets.size === 0) return 0;

  const have = await db
    .selectFrom('email_image_cache')
    .select('url_hash')
    .where('user_id', '=', userId)
    .where('url_hash', 'in', [...targets.keys()])
    .execute();
  for (const h of have) targets.delete(h.url_hash);

  let remaining = env.EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES;
  let stored = 0;
  await mapConcurrent([...targets], FETCH_CONCURRENCY, async ([urlHash, url]) => {
    if (remaining <= 0) return;
    const image = await fetcher(url, remaining);
    // Re-checked after the fetch: several run at once against one budget.
    if (!image || image.body.length > remaining) return;
    remaining -= image.body.length;
    await storeImage(db, userId, urlHash, image);
    stored += 1;
  });
  return stored;
}

async function storeImage(
  db: Kysely<DB>,
  userId: string,
  urlHash: string,
  image: FetchedImage,
): Promise<void> {
  await writeBlob(userId, imagePath(userId, urlHash), image.body);
  await db
    .insertInto('email_image_cache')
    .values({
      user_id: userId,
      url_hash: urlHash,
      content_type: image.contentType,
      bytes: image.body.length,
      fetched_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'url_hash']).doUpdateSet({
        content_type: image.contentType,
        bytes: image.body.length,
        fetched_at: new Date().toISOString(),
      }),
    )
    .execute();
}

/** The store key of a message's own `cid:` image: a different namespace from
 *  remote URLs, so the two can never name the same entry. */
function inlineImageHash(messageRowId: string, contentId: string): string {
  return createHash('sha256').update(`cid:${messageRowId}:${contentId}`).digest('hex');
}

/**
 * A message's inline (`cid:`) image from the same sealed store, or null.
 * Kept under the same switches and retention as preloaded remote images.
 */
export async function readStoredInlineImage(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
  contentId: string,
): Promise<FetchedImage | null> {
  if (!preloadEnabled()) return null;
  return readStoredImage(db, userId, inlineImageHash(messageRowId, contentId));
}

/** Remember an inline image fetched from the provider, so the next render
 *  of that message does not fetch it again. Never throws. */
export async function storeInlineImage(
  db: Kysely<DB>,
  userId: string,
  messageRowId: string,
  contentId: string,
  image: FetchedImage,
): Promise<void> {
  if (!preloadEnabled() || image.body.length > env.EMAIL_IMAGE_PRELOAD_MAX_MESSAGE_BYTES) return;
  try {
    // The preload pass prunes only for readers who auto-load remote images;
    // inline images are stored for everyone, so expire them here too.
    await pruneExpired(db, userId, new Date(Date.now() - env.EMAIL_IMAGE_PRELOAD_DAYS * DAY_MS).toISOString());
    await storeImage(db, userId, inlineImageHash(messageRowId, contentId), image);
  } catch (err) {
    logger.warn('inline email image not stored', { userId, err: (err as Error).message });
  }
}

const running = new Set<string>();

/**
 * Start a preload pass without waiting for it. A sync must not take as long as
 * the slowest image host in the mailbox, and two syncs close together must not
 * fetch the same images twice.
 */
export function startImagePreload(db: Kysely<DB>, userId: string): void {
  if (!preloadEnabled() || running.has(userId)) return;
  running.add(userId);
  void preloadEmailImages(db, userId)
    .catch((err: unknown) => {
      logger.warn('email image preload pass failed', { userId, err: (err as Error).message });
    })
    .finally(() => running.delete(userId));
}

/** Remove every stored image of a deleted account. */
export async function deletePreloadedImages(userId: string): Promise<void> {
  await fs.rm(userDir(userId), { recursive: true, force: true });
}
