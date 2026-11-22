/**
 * Content encryption at rest, assembled (ADR 0201).
 *
 * `attachContentCrypto(base)` returns the Kysely handle the rest of the app
 * uses: it opens sealed values on the way out of every query. Writing sealed
 * values is explicit (`sealField`, `writeBlob`) and only happens when
 * `CONTENT_ENCRYPTION` is on, so the code can ship before the switch is
 * flipped and a backfill can follow it.
 */
import fs from 'node:fs/promises';

import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../schema.js';
import { KeyDestroyedError, KeyStore, NoKeyError } from './content-keys.js';
import { ContentDecryptPlugin } from './decrypt-plugin.js';
import { deriveKey, isSealedFile, JSON_CTX_SUFFIX, openFile, sealFile, sealText } from './envelope.js';
import { providerFromConfig, type KeyProvider } from './key-provider.js';

export interface ContentCrypto {
  store: KeyStore;
  plugin: ContentDecryptPlugin;
  /** The handle WITHOUT the decrypt plugin: what a backfill reads raw values through. */
  raw: Kysely<DB>;
  /** The handle the app uses, with the plugin. */
  handle: Kysely<DB>;
  /**
   * Where keys are loaded and created. It has its own connections on purpose:
   * Kysely runs a plugin's transformResult while still holding the query's
   * connection, so loading a key through the app's own pool would need a second
   * connection from it and can deadlock or exhaust it under load.
   */
  keys: Kysely<DB>;
}

/**
 * The handles in play, newest last. There is normally one; tests that open a
 * second database (a clone) push another, and closing it restores the first,
 * so blob and seal helpers always talk to the database the caller is using.
 */
const attached: ContentCrypto[] = [];
let enabled = env.CONTENT_ENCRYPTION;

export interface AttachOptions {
  /** A handle on its own small pool, used only for key lookups. */
  keyDb: Kysely<DB>;
  provider?: KeyProvider;
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * Builds the configured provider the first time a key is wrapped or unwrapped.
 * Opening the database must not need a KEK: migrations and every script open
 * it, and with encryption never switched on there is nothing to unwrap.
 */
class LazyKeyProvider implements KeyProvider {
  private inner: KeyProvider | null = null;

  resolve(): KeyProvider {
    this.inner ??= providerFromConfig({
      provider: env.CONTENT_KEY_PROVIDER,
      kek: env.CONTENT_KEK,
      gcpKeyName: env.GCP_KMS_KEY_NAME,
      nodeEnv: env.NODE_ENV,
    });
    return this.inner;
  }

  get id(): string {
    return this.resolve().id;
  }
  wrap(dek: Buffer): Promise<Buffer> {
    return this.resolve().wrap(dek);
  }
  unwrap(wrapped: Buffer): Promise<Buffer> {
    return this.resolve().unwrap(wrapped);
  }
}

export function attachContentCrypto(base: Kysely<DB>, opts: AttachOptions): Kysely<DB> {
  let provider = opts.provider;
  if (!provider) {
    const lazy = new LazyKeyProvider();
    // Switched on means a misconfiguration should stop the process at boot, not
    // surface on the first sealed write. Switched off, sealed data left over
    // from an earlier run still opens, and a missing key is reported then.
    if (enabled) lazy.resolve();
    provider = lazy;
  }
  const store = new KeyStore(provider, {
    ttlMs: opts.ttlMs ?? env.CONTENT_DEK_TTL_MS,
    maxEntries: opts.maxEntries ?? env.CONTENT_DEK_CACHE_MAX,
  });
  const plugin = new ContentDecryptPlugin(store, () => opts.keyDb);
  const handle = base.withPlugin(plugin);
  // Closing the app handle closes the key pool with it, so a script that
  // awaits db.destroy() still lets the process exit.
  const destroy = handle.destroy.bind(handle);
  handle.destroy = async () => {
    await destroy();
    await opts.keyDb.destroy();
  };
  attached.push({ store, plugin, raw: base, handle, keys: opts.keyDb });
  return handle;
}

/** Forget a handle that is being closed, so helpers fall back to the previous one. */
export function detachContentCrypto(db: Kysely<DB>): void {
  const i = attached.findIndex((a) => a.handle === db || a.raw === db);
  if (i >= 0) attached.splice(i, 1);
}

export function contentCrypto(): ContentCrypto {
  const active = attached[attached.length - 1];
  if (!active) throw new Error('content crypto is not attached: open the database through openDb()');
  return active;
}

export function hasContentCrypto(): boolean {
  return attached.length > 0;
}

export function contentEncryptionEnabled(): boolean {
  return enabled;
}

/** Runtime switch, mainly for tests. The env var only sets the starting value. */
export function setContentEncryption(on: boolean): void {
  enabled = on;
}

/**
 * Seal a value for storage when encryption is on; otherwise return it as is.
 * `null` and `undefined` pass through: an absent value stays absent, so
 * `IS NULL` checks keep meaning what they meant.
 */
export async function sealField<T extends string | null | undefined>(
  owner: string,
  ctx: string,
  value: T,
): Promise<T | string> {
  // An empty string is left alone as well: several columns give '' a meaning of
  // its own ("parsed, no invite"), and there is nothing in it to protect.
  if (!enabled || value === null || value === undefined || value === '') return value;
  const { store, keys } = contentCrypto();
  return sealText(store, keys, owner, ctx, value);
}

/**
 * Seal JSON for a jsonb column. Takes the JSON text and returns the JSON text to
 * store: the same text when encryption is off (or when there is nothing worth
 * sealing: null, `[]`, `{}`), otherwise a JSON string scalar holding the sealed
 * text, which the read plugin opens and parses back.
 */
export async function sealJsonField(
  owner: string,
  ctx: string,
  jsonText: string | null | undefined,
): Promise<string | null> {
  if (!enabled || jsonText === null || jsonText === undefined) return jsonText ?? null;
  if (jsonText === '[]' || jsonText === '{}' || jsonText === 'null') return jsonText;
  const { store, keys } = contentCrypto();
  return JSON.stringify(await sealText(store, keys, owner, `${ctx}${JSON_CTX_SUFFIX}`, jsonText));
}

const indexKeys = new WeakMap<Buffer, Buffer>();

/**
 * The key an owner's blind index is built with, derived from their data key so
 * there is nothing more to store. `create` false returns null for an owner who
 * has no key yet (nothing of theirs is indexed, so nothing can match).
 */
export async function indexKeyFor(owner: string, create?: true): Promise<Buffer>;
export async function indexKeyFor(owner: string, create: boolean): Promise<Buffer | null>;
export async function indexKeyFor(owner: string, create = true): Promise<Buffer | null> {
  const { store, keys } = contentCrypto();
  let dek: Buffer;
  try {
    dek = await store.getDek(keys, owner, create);
  } catch (err) {
    // A read of an owner with no usable key finds nothing rather than failing the whole query.
    if (!create && (err instanceof NoKeyError || err instanceof KeyDestroyedError)) return null;
    throw err;
  }
  let k = indexKeys.get(dek);
  if (!k) {
    k = deriveKey(dek, 'blind-index-v1');
    indexKeys.set(dek, k);
  }
  return k;
}

/**
 * Seal a small binary value (a search vector, ADR 0276) under its owner, the
 * same envelope files use. Raw bytes when encryption is off. A vector says
 * what its text is about, so it is protected like the text.
 */
export async function sealBytes(owner: string, data: Buffer): Promise<Buffer> {
  if (!enabled) return data;
  const { store, keys } = contentCrypto();
  return sealFile(store, keys, owner, data);
}

/** Open a value written by `sealBytes`. Unsealed bytes come back unchanged. */
export async function openBytes(data: Buffer): Promise<Buffer> {
  if (!isSealedFile(data)) return data;
  const { store, keys } = contentCrypto();
  return openFile(store, keys, data);
}

/** Write a file, sealed when encryption is on. */
export async function writeBlob(owner: string, fullPath: string, data: Buffer): Promise<void> {
  if (!enabled) {
    await fs.writeFile(fullPath, data);
    return;
  }
  const { store, keys } = contentCrypto();
  await fs.writeFile(fullPath, await sealFile(store, keys, owner, data));
}

/** Read a file, opening it if it is sealed. Plaintext files come back unchanged. */
export async function readBlob(fullPath: string): Promise<Buffer> {
  const data = await fs.readFile(fullPath);
  if (!isSealedFile(data)) return data;
  const { store, keys } = contentCrypto();
  return openFile(store, keys, data);
}

/** True when the file on disk is sealed. Reads only the header. */
export async function blobIsSealed(fullPath: string): Promise<boolean> {
  const fh = await fs.open(fullPath, 'r');
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await fh.read(head, 0, 16, 0);
    return isSealedFile(head.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}

export { KeyStore, KeyDestroyedError, NoKeyError } from './content-keys.js';
export { SealError, isSealedText, isSealedFile, sealedOwner, sealText, openText, sealFile, openFile, deriveKey, JSON_CTX_SUFFIX, sealedContext } from './envelope.js';
export { LocalKeyProvider, GcpKmsKeyProvider, KeyProviderError, providerFromConfig } from './key-provider.js';
export type { KeyProvider } from './key-provider.js';
