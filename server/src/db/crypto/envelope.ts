/**
 * Sealed text and sealed files (ADR 0201).
 *
 * Text:  enc1.<owner>.<ctx>.<base64url(iv | ciphertext | tag)>
 * Files: CHENC1\n | u8 ownerLen | owner | iv | ciphertext | tag
 *
 * Both are self-describing: the owner is inside, so a reader needs no extra
 * argument to find the right key, and a column can hold sealed and plaintext
 * values side by side while a backfill runs. `ctx` names what the value is
 * (`email_messages:body_text`). It and the owner are bound in as additional
 * authenticated data, so a value cannot be re-labelled as another column or
 * moved to another owner without failing authentication.
 *
 * What this does NOT protect against: someone with database write access
 * swapping one sealed value for another of the same owner and column. That
 * needs the key to fix and is a tampering threat, not a disclosure one.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';

import type { DB } from '../schema.js';
import type { KeyStore } from './content-keys.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;
export const TEXT_PREFIX = 'enc1.';
const FILE_MAGIC = Buffer.from('CHENC1\n', 'latin1');

export class SealError extends Error {}

function aad(owner: string, ctx: string): Buffer {
  return Buffer.from(`${owner}|${ctx}`, 'utf8');
}

function checkLabel(kind: string, v: string): void {
  if (!v || v.includes('.') || v.includes('|')) {
    throw new SealError(`${kind} must be non-empty and contain no "." or "|": ${JSON.stringify(v)}`);
  }
}

export function isSealedText(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(TEXT_PREFIX);
}

export function isSealedFile(buf: Buffer): boolean {
  return buf.length > FILE_MAGIC.length && buf.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC);
}

/** Key derived from an owner's data key for a different purpose (e.g. the blind index). */
export function deriveKey(dek: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', dek, Buffer.alloc(0), `chord:${purpose}`, 32));
}

function encrypt(dek: Buffer, plain: Buffer, ad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  cipher.setAAD(ad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

function decrypt(dek: Buffer, blob: Buffer, ad: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new SealError('sealed value is truncated');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SealError('sealed value failed authentication (wrong key, or altered)');
  }
}

export async function sealText(
  store: KeyStore,
  db: Kysely<DB>,
  owner: string,
  ctx: string,
  plaintext: string,
): Promise<string> {
  checkLabel('owner', owner);
  checkLabel('ctx', ctx);
  const dek = await store.getDek(db, owner);
  const blob = encrypt(dek, Buffer.from(plaintext, 'utf8'), aad(owner, ctx));
  return `${TEXT_PREFIX}${owner}.${ctx}.${blob.toString('base64url')}`;
}

function parseText(sealed: string): { owner: string; ctx: string; blob: Buffer } {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'enc1') throw new SealError('malformed sealed text');
  return { owner: parts[1]!, ctx: parts[2]!, blob: Buffer.from(parts[3]!, 'base64url') };
}

export function sealedOwner(sealed: string): string {
  return parseText(sealed).owner;
}

/**
 * A jsonb column stores the sealed text as a JSON string scalar, and what the
 * application wants back is the parsed value, not that string. A context
 * ending in this marker tells the read plugin to parse after opening.
 */
export const JSON_CTX_SUFFIX = '~json';

export function sealedContext(sealed: string): string {
  return parseText(sealed).ctx;
}

export async function openText(store: KeyStore, db: Kysely<DB>, sealed: string): Promise<string> {
  const { owner, ctx, blob } = parseText(sealed);
  const dek = await store.getDek(db, owner, false);
  return decrypt(dek, blob, aad(owner, ctx)).toString('utf8');
}

export async function sealFile(
  store: KeyStore,
  db: Kysely<DB>,
  owner: string,
  plain: Buffer,
): Promise<Buffer> {
  checkLabel('owner', owner);
  const ownerBytes = Buffer.from(owner, 'utf8');
  if (ownerBytes.length > 255) throw new SealError('owner id is too long');
  const dek = await store.getDek(db, owner);
  const blob = encrypt(dek, plain, aad(owner, 'file'));
  return Buffer.concat([FILE_MAGIC, Buffer.from([ownerBytes.length]), ownerBytes, blob]);
}

export async function openFile(store: KeyStore, db: Kysely<DB>, sealed: Buffer): Promise<Buffer> {
  if (!isSealedFile(sealed)) throw new SealError('not a sealed file');
  const at = FILE_MAGIC.length;
  const ownerLen = sealed[at]!;
  const owner = sealed.subarray(at + 1, at + 1 + ownerLen).toString('utf8');
  const blob = sealed.subarray(at + 1 + ownerLen);
  const dek = await store.getDek(db, owner, false);
  return decrypt(dek, blob, aad(owner, 'file'));
}
