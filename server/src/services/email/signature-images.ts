/**
 * ADR 0326 - pictures in an email signature.
 *
 * A signature pasted from Outlook, Apple Mail or Word carries its logo inside
 * the HTML (`data:`) or as a reference to the clipboard (`cid:`, `file:`), and
 * neither reaches a recipient. The app uploads each picture here; Chord keeps
 * the bytes and the signature links to them at a public, unguessable address,
 * which is what a recipient's mail app fetches.
 */
import { createHash } from 'node:crypto';

import type { Kysely } from 'kysely';
import { nanoid } from 'nanoid';
import sharp from 'sharp';

import { API } from '@chord/kernel';

import { env } from '../../config/env.js';
import { readBlob } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { absolutePathFor, getAttachment } from '../attachments.service.js';
import { webOrigin } from '../stripe.service.js';

/** The largest picture kept, after shrinking. A signature logo is tens of kilobytes. */
export const SIGNATURE_IMAGE_MAX_BYTES = 1_000_000;
/** The largest picture accepted for shrinking (what fits in a 2 MB JSON body). */
export const SIGNATURE_IMAGE_UPLOAD_MAX_BYTES = 1_450_000;
/** How many different pictures one user may keep. */
export const SIGNATURE_IMAGES_PER_USER = 100;

const ID = /^[A-Za-z0-9_-]{20,40}$/;

/** The picture type the bytes really are; never what the client said. No SVG. */
export function sniffImageType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Where pictures are served from: the public site in production, else the
 *  address the app reached this server at (so a dev preview loads them). */
export function signatureImageBase(requestOrigin?: string | null): string {
  const site = webOrigin();
  if (env.NODE_ENV === 'production' && site) return site;
  return (requestOrigin || site || `http://127.0.0.1:${env.SERVER_PORT}`).replace(/\/$/, '');
}

export function signatureImageUrl(id: string, base: string): string {
  return `${base}${API.signatureImage(id)}`;
}

/** True for an address this server hands out for a signature picture. */
export function isSignatureImageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const id = u.pathname.slice(API.signatureImage('').length);
    return u.pathname.startsWith(API.signatureImage('')) && ID.test(id);
  } catch {
    return false;
  }
}

export type StoreSignatureImageResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'too_large' | 'not_an_image' | 'too_many' };

/** Keep a picture for this user. The same picture twice is one row. */
/** A signature picture wider than this, or heavier than SHRINK_OVER, is drawn
 *  smaller: a logo in a signature, not a photo at full size. */
export const SIGNATURE_IMAGE_MAX_WIDTH = 800;
const SHRINK_OVER = 300_000;

async function shrink(bytes: Buffer, mime: string): Promise<{ bytes: Buffer; mime: string }> {
  // An animated GIF would lose its animation.
  if (mime === 'image/gif' && bytes.length <= SIGNATURE_IMAGE_MAX_BYTES) return { bytes, mime };
  try {
    const meta = await sharp(bytes).metadata();
    if ((meta.width ?? 0) <= SIGNATURE_IMAGE_MAX_WIDTH && bytes.length <= SHRINK_OVER) return { bytes, mime };
    const resized = sharp(bytes).rotate().resize({ width: SIGNATURE_IMAGE_MAX_WIDTH, withoutEnlargement: true });
    const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer();
    if (png.length <= SHRINK_OVER || meta.hasAlpha) return { bytes: png, mime: 'image/png' };
    return { bytes: await resized.jpeg({ quality: 85 }).toBuffer(), mime: 'image/jpeg' };
  } catch {
    return { bytes, mime };
  }
}

export async function storeSignatureImage(
  db: Kysely<DB>,
  userId: string,
  input: Buffer,
): Promise<StoreSignatureImageResult> {
  if (input.length > SIGNATURE_IMAGE_UPLOAD_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const sniffed = sniffImageType(input);
  if (!sniffed) return { ok: false, reason: 'not_an_image' };
  const { bytes, mime } = await shrink(input, sniffed);
  if (bytes.length > SIGNATURE_IMAGE_MAX_BYTES) return { ok: false, reason: 'too_large' };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = await db
    .selectFrom('signature_images')
    .select('id')
    .where('user_id', '=', userId)
    .where('sha256', '=', sha256)
    .executeTakeFirst();
  if (existing) return { ok: true, id: existing.id };
  const count = await db
    .selectFrom('signature_images')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  if (Number(count.n) >= SIGNATURE_IMAGES_PER_USER) return { ok: false, reason: 'too_many' };
  const id = nanoid(24);
  const row = await db
    .insertInto('signature_images')
    .values({ id, user_id: userId, mime, bytes, sha256, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(['user_id', 'sha256']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (row) return { ok: true, id: row.id };
  // Two uploads of the same picture at once: the other one won.
  const winner = await db
    .selectFrom('signature_images')
    .select('id')
    .where('user_id', '=', userId)
    .where('sha256', '=', sha256)
    .executeTakeFirstOrThrow();
  return { ok: true, id: winner.id };
}

/**
 * A picture the user sent in chat, kept as a signature picture (the chat way
 * to do what "Add picture" does in Settings). Only an image in this chat, or
 * the user's own upload, may be used - the rule `look_at_attachment` follows.
 */
export async function signaturePictureFromAttachment(
  db: Kysely<DB>,
  opts: { attachmentId: string; groupId: string; userId: string; requestOrigin?: string | null },
): Promise<{ ok: true; url: string } | { ok: false; reason: 'not_found' | 'not_an_image' | 'too_large' | 'too_many' }> {
  const att = await getAttachment(db, opts.attachmentId);
  const visible =
    !!att &&
    ((att.scope.kind === 'group' && att.scope.groupId === opts.groupId) ||
      (att.scope.kind === 'user' && att.scope.userId === opts.userId));
  if (!att || !visible) return { ok: false, reason: 'not_found' };
  if (!att.mimeType.startsWith('image/')) return { ok: false, reason: 'not_an_image' };
  const out = await storeSignatureImage(db, opts.userId, await readBlob(absolutePathFor(att)));
  if (!out.ok) return out;
  return { ok: true, url: signatureImageUrl(out.id, signatureImageBase(opts.requestOrigin)) };
}

/** A picture's tag in a signature. */
export function signaturePictureTag(url: string): string {
  return `<img src="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" alt="" style="max-width: 300px">`;
}

export async function readSignatureImage(
  db: Kysely<DB>,
  id: string,
): Promise<{ mime: string; bytes: Buffer } | null> {
  if (!ID.test(id)) return null;
  const row = await db
    .selectFrom('signature_images')
    .select(['mime', 'bytes'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row ?? null;
}
