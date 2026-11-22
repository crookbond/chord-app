/**
 * Per-owner data keys against a real database (ADR 0201): creation under
 * concurrency, the cache, destruction, and the decrypt plugin's behaviour when
 * a value cannot be opened. The failure paths are the point.
 */
import { randomBytes } from 'node:crypto';

import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '../../schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { contentCrypto } from '../index.js';
import { KeyDestroyedError, KeyStore, NoKeyError } from '../content-keys.js';
import { openText, sealText } from '../envelope.js';
import { KeyProviderError, LocalKeyProvider, type KeyProvider } from '../key-provider.js';

let db: Kysely<DB>;
let raw: Kysely<DB>;
let keys: Kysely<DB>;
let store: KeyStore;

beforeEach(async () => {
  db = await openTestDb();
  ({ raw, store, keys } = contentCrypto());
});
afterEach(async () => {
  await closeTestDb(db);
});

/** A provider that counts how often it is asked, and can be made to fail. */
class CountingProvider implements KeyProvider {
  readonly id = 'local';
  wraps = 0;
  unwraps = 0;
  down = false;
  private readonly inner = new LocalKeyProvider(Buffer.alloc(32, 9));
  wrap(dek: Buffer): Promise<Buffer> {
    if (this.down) return Promise.reject(new KeyProviderError('KMS unavailable'));
    this.wraps++;
    return this.inner.wrap(dek);
  }
  unwrap(w: Buffer): Promise<Buffer> {
    if (this.down) return Promise.reject(new KeyProviderError('KMS unavailable'));
    this.unwraps++;
    return this.inner.unwrap(w);
  }
}

const keyRows = async (owner: string) =>
  db.selectFrom('content_keys').selectAll().where('owner', '=', owner).execute();

async function setAboutMe(userId: string, value: string): Promise<void> {
  await sql`UPDATE users SET about_me = ${value} WHERE id = ${userId}`.execute(raw);
}

describe('creating a key', () => {
  it('a burst of first uses shares one key and one row', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });

    const deks = await Promise.all(Array.from({ length: 50 }, () => s.getDek(keys, 'u_burst')));

    expect(new Set(deks.map((k) => k.toString('hex'))).size).toBe(1);
    expect(provider.wraps).toBe(1);
    expect(await keyRows('u_burst')).toHaveLength(1);
  });

  it('two processes racing to create the same owner end up with ONE key', async () => {
    // Separate stores stand in for separate processes: neither sees the
    // other's cache, so both find no row and both try to insert.
    const a = new KeyStore(new CountingProvider(), { ttlMs: 60_000, maxEntries: 100 });
    const b = new KeyStore(new CountingProvider(), { ttlMs: 60_000, maxEntries: 100 });

    const [ka, kb] = await Promise.all([a.getDek(keys, 'u_race'), b.getDek(keys, 'u_race')]);

    expect(ka.equals(kb)).toBe(true);
    expect(await keyRows('u_race')).toHaveLength(1);

    // And whatever either sealed, the other can open.
    const sealed = await sealText(a, keys, 'u_race', 'ctx', 'written by a');
    expect(await openText(b, keys, sealed)).toBe('written by a');
  });

  it('stores only the wrapped key, never the key itself', async () => {
    const dek = await store.getDek(keys, 'u_wrapped');
    const [row] = await keyRows('u_wrapped');
    expect(row!.wrapped_dek).not.toBeNull();
    expect(row!.wrapped_dek!.includes(dek)).toBe(false);
    expect(row!.provider).toBe('local');
    expect(row!.destroyed_at).toBeNull();
  });

  it('gives different owners different keys', async () => {
    const [a, b] = await Promise.all([store.getDek(keys, 'u_one'), store.getDek(keys, 'u_two')]);
    expect(a.equals(b)).toBe(false);
  });
});

describe('reading never creates a key', () => {
  it('opening for an owner with no key fails and writes nothing', async () => {
    await expect(store.getDek(keys, 'u_ghost', false)).rejects.toThrow(NoKeyError);
    expect(await keyRows('u_ghost')).toHaveLength(0);
  });

  it('a string that only LOOKS sealed reads back as typed and mints no key', async () => {
    // A user can type anything into a chat message. If reading it created a
    // key for the owner it names, anyone could fill the table.
    const userId = await createUser(db, 'typist');
    const lookalike = 'enc1.u_attacker.email_messages:body_text.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await setAboutMe(userId, lookalike);

    const row = await db.selectFrom('users').select('about_me').where('id', '=', userId).executeTakeFirstOrThrow();

    expect(row.about_me).toBe(lookalike);
    expect(await keyRows('u_attacker')).toHaveLength(0);
    expect(contentCrypto().plugin.unopenable).toBeGreaterThan(0);
  });
});

describe('the cache', () => {
  it('serves repeat lookups without asking the provider again', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });
    await s.getDek(keys, 'u_c');
    const cold = provider.unwraps + provider.wraps;
    for (let i = 0; i < 1000; i++) await s.getDek(keys, 'u_c');
    expect(provider.unwraps + provider.wraps).toBe(cold);
  });

  it('asks again only after the TTL, and not before', async () => {
    const provider = new CountingProvider();
    let now = 1_000;
    const s = new KeyStore(provider, { ttlMs: 10_000, maxEntries: 100, now: () => now });
    await s.getDek(keys, 'u_ttl');
    const before = provider.unwraps;

    now += 9_999;
    await s.getDek(keys, 'u_ttl');
    expect(provider.unwraps).toBe(before);

    now += 2;
    await s.getDek(keys, 'u_ttl');
    expect(provider.unwraps).toBe(before + 1);
  });

  it('is bounded: the least recently used owner is evicted first', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 3 });
    for (const o of ['u_1', 'u_2', 'u_3']) await s.getDek(keys, o);
    await s.getDek(keys, 'u_1'); // touch: u_2 is now the oldest
    await s.getDek(keys, 'u_4');
    expect(s.cachedOwners).toBe(3);

    const before = provider.unwraps;
    await s.getDek(keys, 'u_1'); // still cached
    await s.getDek(keys, 'u_3'); // still cached
    expect(provider.unwraps).toBe(before);
    await s.getDek(keys, 'u_2'); // evicted: one unwrap
    expect(provider.unwraps).toBe(before + 1);
  });

  it('clearing it forces the next read back to the provider', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });
    await s.getDek(keys, 'u_x');
    const before = provider.unwraps;
    s.clearCache();
    await s.getDek(keys, 'u_x');
    expect(provider.unwraps).toBe(before + 1);
  });
});

describe('destroying a key erases the data', () => {
  it('sealed values can no longer be opened, by anyone, from any cache', async () => {
    const sealed = await sealText(store, keys, 'u_gone', 'ctx', 'private');
    expect(await openText(store, keys, sealed)).toBe('private');

    expect(await store.destroy(keys, 'u_gone')).toBe(true);

    await expect(openText(store, keys, sealed)).rejects.toThrow(KeyDestroyedError);
    // A second process with a cold cache reaches the same answer from the row.
    const cold = new KeyStore(new CountingProvider(), { ttlMs: 60_000, maxEntries: 10 });
    await expect(openText(cold, keys, sealed)).rejects.toThrow(KeyDestroyedError);
  });

  it('cannot be undone by writing again: a destroyed owner never gets a new key', async () => {
    await store.getDek(keys, 'u_dead');
    await store.destroy(keys, 'u_dead');
    await expect(sealText(store, keys, 'u_dead', 'ctx', 'x')).rejects.toThrow(KeyDestroyedError);
    expect(await keyRows('u_dead')).toHaveLength(1);
  });

  it('keeps a tombstone and removes the wrapped key', async () => {
    await store.getDek(keys, 'u_tomb');
    await store.destroy(keys, 'u_tomb');
    const [row] = await keyRows('u_tomb');
    expect(row!.wrapped_dek).toBeNull();
    expect(row!.destroyed_at).not.toBeNull();
  });

  it('is idempotent, and reports whether it did anything', async () => {
    await store.getDek(keys, 'u_twice');
    expect(await store.destroy(keys, 'u_twice')).toBe(true);
    expect(await store.destroy(keys, 'u_twice')).toBe(false);
    expect(await store.destroy(keys, 'u_never_existed')).toBe(false);
  });

  it("leaves every other owner's data readable", async () => {
    const keep = await sealText(store, keys, 'u_keep', 'ctx', 'still here');
    await sealText(store, keys, 'u_drop', 'ctx', 'goodbye');
    await store.destroy(keys, 'u_drop');
    expect(await openText(store, keys, keep)).toBe('still here');
  });
});

describe('the decrypt plugin', () => {
  it('opens sealed values anywhere in a result, and leaves plaintext alone', async () => {
    const a = await createUser(db, 'reader-a');
    const b = await createUser(db, 'reader-b');
    await setAboutMe(a, await sealText(store, keys, a, 'users:about_me', 'sealed about me'));
    await setAboutMe(b, 'plain about me');

    const rows = await db.selectFrom('users').select(['id', 'about_me']).where('id', 'in', [a, b]).execute();
    const by = Object.fromEntries(rows.map((r) => [r.id, r.about_me]));
    expect(by[a]).toBe('sealed about me');
    expect(by[b]).toBe('plain about me');
  });

  it('works for raw SQL and inside a transaction', async () => {
    const u = await createUser(db, 'reader-tx');
    await setAboutMe(u, await sealText(store, keys, u, 'users:about_me', 'inside a transaction'));

    const viaSql = await sql<{ about_me: string }>`SELECT about_me FROM users WHERE id = ${u}`.execute(db);
    expect(viaSql.rows[0]!.about_me).toBe('inside a transaction');

    const inTx = await db.transaction().execute((trx) =>
      trx.selectFrom('users').select('about_me').where('id', '=', u).executeTakeFirstOrThrow(),
    );
    expect(inTx.about_me).toBe('inside a transaction');
  });

  it('the raw handle sees ciphertext, which is what a database admin would see', async () => {
    const u = await createUser(db, 'reader-raw');
    await setAboutMe(u, await sealText(store, keys, u, 'users:about_me', 'top secret plans'));

    const seen = await raw.selectFrom('users').select('about_me').where('id', '=', u).executeTakeFirstOrThrow();
    expect(seen.about_me).toMatch(/^enc1\./);
    expect(seen.about_me).not.toContain('secret');
  });

  it('a destroyed key leaves the value as stored instead of failing the whole query', async () => {
    const good = await createUser(db, 'reader-good');
    const bad = await createUser(db, 'reader-bad');
    await setAboutMe(good, await sealText(store, keys, good, 'users:about_me', 'readable'));
    const sealedBad = await sealText(store, keys, bad, 'users:about_me', 'unreadable');
    await setAboutMe(bad, sealedBad);
    await store.destroy(keys, bad);

    const rows = await db.selectFrom('users').select(['id', 'about_me']).where('id', 'in', [good, bad]).execute();
    const by = Object.fromEntries(rows.map((r) => [r.id, r.about_me]));
    expect(by[good]).toBe('readable');
    expect(by[bad]).toBe(sealedBad); // ciphertext, never invented plaintext
  });

  it('an altered value is left as stored and never returns wrong plaintext', async () => {
    const u = await createUser(db, 'reader-tamper');
    const sealed = await sealText(store, keys, u, 'users:about_me', 'original');
    const parts = sealed.split('.');
    const payload = Buffer.from(parts[3]!, 'base64url');
    payload[payload.length - 1] = payload[payload.length - 1]! ^ 1;
    const tampered = `${parts[0]}.${parts[1]}.${parts[2]}.${payload.toString('base64url')}`;
    await setAboutMe(u, tampered);

    const row = await db.selectFrom('users').select('about_me').where('id', '=', u).executeTakeFirstOrThrow();
    expect(row.about_me).toBe(tampered);
    expect(row.about_me).not.toBe('original');
  });

  it('a key PROVIDER outage is an error, not a screen of ciphertext', async () => {
    const provider = new CountingProvider();
    const cold = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 10 });
    const u = await createUser(db, 'reader-outage');
    await setAboutMe(u, await sealText(store, keys, u, 'users:about_me', 'needs the key'));

    // Same keys, but a store with an empty cache whose provider is down.
    provider.down = true;
    await expect(openText(cold, keys, (await raw.selectFrom('users').select('about_me').where('id', '=', u).executeTakeFirstOrThrow()).about_me!)).rejects.toThrow(KeyProviderError);
  });

  it('adds nothing to a result that holds no sealed values', async () => {
    const before = contentCrypto().plugin.opened;
    await createUser(db, 'plain-only');
    await db.selectFrom('users').selectAll().execute();
    expect(contentCrypto().plugin.opened).toBe(before);
  });

  it('never opens a value for a caller who did not select it', async () => {
    const u = await createUser(db, 'reader-narrow');
    await setAboutMe(u, await sealText(store, keys, u, 'users:about_me', 'not asked for'));
    const before = contentCrypto().plugin.opened;

    await db.selectFrom('users').select('id').where('id', '=', u).execute();

    expect(contentCrypto().plugin.opened).toBe(before);
  });
});

it('a fresh random key is 32 bytes and not derived from the owner id', async () => {
  const a = await store.getDek(keys, 'u_entropy_a');
  const b = await store.getDek(keys, 'u_entropy_b');
  expect(a).toHaveLength(32);
  expect(a.equals(b)).toBe(false);
  expect(a.equals(randomBytes(32))).toBe(false);
});
