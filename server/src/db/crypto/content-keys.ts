/**
 * Per-owner data keys (ADR 0201).
 *
 * An owner is whoever the data belongs to: a user id for mail, a group id for
 * files shared into a group. Each gets one random 256-bit key, stored only in
 * wrapped form. Unwrapped keys live in a small in-process cache so the common
 * path is a Map lookup, not a KMS round trip: the cache is what keeps
 * encryption from being felt.
 *
 * Destroying an owner's key is how their data is erased. The wrapped key is
 * nulled and the cache entry evicted; every ciphertext they own is then
 * unrecoverable, including in backups.
 */
import { randomBytes } from 'node:crypto';

import { sql, type Kysely } from 'kysely';

import type { DB } from '../schema.js';
import type { KeyProvider } from './key-provider.js';

export class KeyDestroyedError extends Error {
  constructor(readonly owner: string) {
    super(`data key for ${owner} has been destroyed`);
  }
}

/** Reading a value whose owner has no key at all: the value is not ours, or its key is gone. */
export class NoKeyError extends Error {
  constructor(readonly owner: string) {
    super(`no data key for ${owner}`);
  }
}

interface CacheEntry {
  dek: Buffer;
  expiresAt: number;
}

export interface KeyStoreOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export class KeyStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly now: () => number;
  /** How often the provider was actually asked. Read by the performance tests. */
  unwraps = 0;
  wraps = 0;

  constructor(
    readonly provider: KeyProvider,
    private readonly opts: KeyStoreOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * The owner's key. Writers pass `create` so the first write mints it; readers
   * never do, or a string that merely looks sealed (a chat message starting
   * "enc1.") would create key rows for owners that do not exist.
   * Concurrent callers share one load.
   */
  async getDek(db: Kysely<DB>, owner: string, create = true): Promise<Buffer> {
    const hit = this.cache.get(owner);
    if (hit && hit.expiresAt > this.now()) {
      // Refresh recency so the Map's insertion order is an LRU order.
      this.cache.delete(owner);
      this.cache.set(owner, hit);
      return hit.dek;
    }
    const flight = `${create ? 'w' : 'r'}:${owner}`;
    const pending = this.inflight.get(flight);
    if (pending) return pending;
    const load = this.load(db, owner, create).finally(() => this.inflight.delete(flight));
    this.inflight.set(flight, load);
    return load;
  }

  private remember(owner: string, dek: Buffer): void {
    this.cache.delete(owner);
    this.cache.set(owner, { dek, expiresAt: this.now() + this.opts.ttlMs });
    while (this.cache.size > this.opts.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async load(db: Kysely<DB>, owner: string, create: boolean): Promise<Buffer> {
    const row = await db
      .selectFrom('content_keys')
      .select(['wrapped_dek', 'destroyed_at'])
      .where('owner', '=', owner)
      .executeTakeFirst();
    if (row) {
      if (row.destroyed_at || !row.wrapped_dek) throw new KeyDestroyedError(owner);
      this.unwraps++;
      const dek = await this.provider.unwrap(row.wrapped_dek);
      this.remember(owner, dek);
      return dek;
    }
    if (!create) throw new NoKeyError(owner);

    const fresh = randomBytes(32);
    this.wraps++;
    const wrapped = await this.provider.wrap(fresh);
    // Two processes can both find no row. The loser's insert is ignored and it
    // adopts the winner's key, so exactly one key ever exists per owner.
    await sql`INSERT INTO content_keys (owner, wrapped_dek, provider, created_at)
              VALUES (${owner}, ${wrapped}, ${this.provider.id}, ${new Date().toISOString()})
              ON CONFLICT (owner) DO NOTHING`.execute(db);
    const stored = await db
      .selectFrom('content_keys')
      .select(['wrapped_dek', 'destroyed_at'])
      .where('owner', '=', owner)
      .executeTakeFirstOrThrow();
    if (stored.destroyed_at || !stored.wrapped_dek) throw new KeyDestroyedError(owner);
    if (stored.wrapped_dek.equals(wrapped)) {
      this.remember(owner, fresh);
      return fresh;
    }
    this.unwraps++;
    const dek = await this.provider.unwrap(stored.wrapped_dek);
    this.remember(owner, dek);
    return dek;
  }

  /** Erase an owner's data by destroying the only key that opens it. */
  async destroy(db: Kysely<DB>, owner: string): Promise<boolean> {
    const res = await db
      .updateTable('content_keys')
      .set({ wrapped_dek: null, destroyed_at: new Date().toISOString() })
      .where('owner', '=', owner)
      .where('destroyed_at', 'is', null)
      .executeTakeFirst();
    this.cache.delete(owner);
    this.inflight.delete(owner);
    return Number(res.numUpdatedRows) > 0;
  }

  /** Drop every cached key, e.g. between tests or after a KEK rotation. */
  clearCache(): void {
    this.cache.clear();
    this.inflight.clear();
  }

  get cachedOwners(): number {
    return this.cache.size;
  }
}
