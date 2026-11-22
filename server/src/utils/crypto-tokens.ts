/**
 * AES-256-GCM helpers for encrypting Google refresh tokens at rest (ADR 0014).
 *
 * The plaintext refresh token is the only secret here. We persist three blobs:
 * the IV (12 bytes, random per encryption), the ciphertext, and the auth tag
 * (16 bytes). Decryption verifies the tag, so any tamper / wrong-key attempt
 * throws.
 *
 * MASTER_KEY is a base64-encoded 32-byte key from `env.MASTER_KEY`. We resolve
 * it lazily so test code that never touches encryption can run without the
 * env var set; production code paths call `assertCryptoReady()` at boot.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  // MASTER_KEY* are read from process.env at use, not from `env` (parsed once at
  // import), so tests can swap the key; env.ts declares them for documentation.
  // A wrapped key wins over a plain one, and is never silently skipped: if it is configured but
  // the boot step has not unwrapped it yet, sealing under the plain key would write blobs the
  // wrapped key cannot open (and would hide that the migration is half done).
  if (process.env.MASTER_KEY_WRAPPED) {
    throw new Error(
      'MASTER_KEY_WRAPPED is set but has not been unwrapped: call bootCrypto() (db/crypto/master-key) at startup before sealing or opening tokens.',
    );
  }
  const raw = process.env.MASTER_KEY ?? '';
  if (!raw) {
    throw new Error(
      'MASTER_KEY is not set. Generate one with `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"` and add to .env.local.',
    );
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('MASTER_KEY is not valid base64');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(`MASTER_KEY must decode to ${KEY_BYTES} bytes; got ${buf.length}`);
  }
  cachedKey = buf;
  return buf;
}

export interface SealedToken {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function sealToken(plaintext: string): SealedToken {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function openToken(sealed: SealedToken): string {
  const key = loadKey();
  if (sealed.iv.length !== IV_BYTES) {
    throw new Error(`refresh-token IV must be ${IV_BYTES} bytes`);
  }
  if (sealed.tag.length !== TAG_BYTES) {
    throw new Error(`refresh-token auth tag must be ${TAG_BYTES} bytes`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  const plaintext = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

/**
 * Use a master key that was obtained another way (unwrapped from Cloud KMS at boot, ADR 0210).
 * Validated like an env value; this module cannot fetch it itself because it sits below the
 * key providers in the import order.
 */
export function installMasterKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`MASTER_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}`);
  }
  cachedKey = Buffer.from(key);
}

/**
 * Boot-time check: AUTH_MODE='google' deployments must have a usable
 * MASTER_KEY. Call from server startup so a misconfigured prod env fails
 * loudly instead of failing on the first sign-in.
 */
export function assertCryptoReady(): void {
  if (env.AUTH_MODE !== 'google') return;
  cachedKey = null;
  loadKey();
}

/** Test helper — clears the cached key so tests can swap MASTER_KEY between cases. */
export function _resetCryptoCacheForTests(): void {
  cachedKey = null;
}
