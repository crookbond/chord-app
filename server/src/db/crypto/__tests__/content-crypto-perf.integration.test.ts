/**
 * Encryption must not be felt (ADR 0201). These budgets are what "nothing
 * should slow down" means in numbers: the cipher itself, the key cache that
 * keeps KMS off the hot path, the read plugin's cost on queries that carry no
 * sealed values (which is every query today), and the cost when they do.
 *
 * The limits are deliberately generous, roughly 10x what was measured, so they
 * catch a regression of kind (a key fetch per value, a per-row query, an
 * accidental O(n^2)) without flaking on a busy machine. Each test also prints
 * its measurement (`PERF ...`) so a slow-but-passing change is still visible.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '../../schema.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';
import { scaled } from '@/__test-helpers__/perf.js';
import { contentCrypto, readBlob, setContentEncryption, writeBlob } from '../index.js';
import { KeyStore } from '../content-keys.js';
import { openFile, openText, sealFile, sealText } from '../envelope.js';
import { LocalKeyProvider, type KeyProvider } from '../key-provider.js';

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

const ms = (t0: number) => performance.now() - t0;
const report = (label: string, value: string) => console.log(`PERF ${label}: ${value}`);

async function median(runs: number, fn: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(ms(t0));
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

class CountingProvider implements KeyProvider {
  readonly id = 'local';
  wraps = 0;
  unwraps = 0;
  private readonly inner = new LocalKeyProvider(Buffer.alloc(32, 5));
  wrap(d: Buffer) {
    this.wraps++;
    return this.inner.wrap(d);
  }
  unwrap(w: Buffer) {
    this.unwraps++;
    return this.inner.unwrap(w);
  }
}

const TWO_KB = 'The plumber is coming Tuesday about the leak under the kitchen sink. '.repeat(30).slice(0, 2048);

async function bulkUsers(n: number, about: (i: number) => string | Promise<string>): Promise<string[]> {
  const ids: string[] = [];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const id = `u_perf_${i}`;
    ids.push(id);
    rows.push({
      id,
      username: id,
      display_name: id,
      created_at: new Date().toISOString(),
      shadow: 0,
      about_me: await about(i),
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    await raw.insertInto('users').values(rows.slice(i, i + 200)).execute();
  }
  return ids;
}

describe('the cipher', () => {
  it('seals and opens 2 KB values at tens of thousands per second', async () => {
    await store.getDek(keys, 'u_hot');
    const N = 3000;

    const t0 = performance.now();
    const sealed: string[] = [];
    for (let i = 0; i < N; i++) sealed.push(await sealText(store, keys, 'u_hot', 'email_messages:body_text', TWO_KB));
    const sealMs = ms(t0);
    const t1 = performance.now();
    for (const s of sealed) await openText(store, keys, s);
    const openMs = ms(t1);

    report('seal 2KB', `${((sealMs / N) * 1000).toFixed(1)} us/op`);
    report('open 2KB', `${((openMs / N) * 1000).toFixed(1)} us/op`);
    expect(sealMs / N).toBeLessThan(scaled(0.5)); // ms per op
    expect(openMs / N).toBeLessThan(scaled(0.5));
  });

  it('a 200 KB body (the largest we index) costs well under a millisecond-scale budget', async () => {
    const big = 'x'.repeat(200_000);
    await store.getDek(keys, 'u_big');
    const t = await median(15, async () => openText(store, keys, await sealText(store, keys, 'u_big', 'c', big)));
    report('seal+open 200KB', `${t.toFixed(2)} ms`);
    expect(t).toBeLessThan(scaled(25));
  });
});

describe('the key cache keeps the key provider off the hot path', () => {
  it('500 sequential seals for one owner ask the provider at most once', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });
    for (let i = 0; i < 500; i++) await sealText(s, keys, 'u_seq', 'c', 'x');
    expect(provider.wraps + provider.unwraps).toBe(1);
  });

  it('200 concurrent opens across 20 owners cost 20 key loads, not 200', async () => {
    const provider = new CountingProvider();
    const writer = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });
    const owners = Array.from({ length: 20 }, (_, i) => `u_conc_${i}`);
    const sealed = await Promise.all(owners.map((o) => sealText(writer, keys, o, 'c', 'payload')));

    const reader = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 100 });
    const before = provider.unwraps;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 200 }, (_, i) => openText(reader, keys, sealed[i % 20]!)));
    const took = ms(t0);

    report('200 concurrent opens, 20 cold owners', `${took.toFixed(0)} ms`);
    expect(provider.unwraps - before).toBe(20);
    expect(took).toBeLessThan(scaled(2000));
  });

  it('a warm key lookup is a map read', async () => {
    await store.getDek(keys, 'u_warm');
    const N = 20_000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await store.getDek(keys, 'u_warm');
    const took = ms(t0);
    report('warm getDek', `${((took / N) * 1000).toFixed(2)} us/op`);
    expect(took / N).toBeLessThan(scaled(0.05));
  });

  it('100 first-time owners are created within a second or two, then are warm', async () => {
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) await store.getDek(keys, `u_first_${i}`);
    const cold = ms(t0);
    const t1 = performance.now();
    for (let i = 0; i < 100; i++) await store.getDek(keys, `u_first_${i}`);
    const warm = ms(t1);
    report('100 cold owners', `${cold.toFixed(0)} ms (warm ${warm.toFixed(1)} ms)`);
    expect(cold).toBeLessThan(scaled(5000));
    expect(warm).toBeLessThan(scaled(50));
  });
});

describe('the read plugin', () => {
  it('adds no measurable cost to a result with nothing sealed', async () => {
    await bulkUsers(1000, () => TWO_KB.slice(0, 200));

    const viaPlugin = await median(9, () => db.selectFrom('users').selectAll().execute());
    const viaRaw = await median(9, () => raw.selectFrom('users').selectAll().execute());

    report('1000 plain rows', `plugin ${viaPlugin.toFixed(1)} ms vs raw ${viaRaw.toFixed(1)} ms`);
    expect(viaPlugin).toBeLessThan(viaRaw * 1.5 + scaled(20));
  });

  it('opens 1000 sealed values in a single query in well under a second', async () => {
    const sealedTexts = await Promise.all(
      Array.from({ length: 1000 }, (_, i) => sealText(store, keys, `u_perf_${i}`, 'users:about_me', TWO_KB)),
    );
    await bulkUsers(1000, (i) => sealedTexts[i]!);
    store.clearCache();
    const opened0 = contentCrypto().plugin.opened;

    const t0 = performance.now();
    const rows = await db.selectFrom('users').select(['id', 'about_me']).execute();
    const took = ms(t0);

    report('1000 rows, 1000 different owners, cold cache', `${took.toFixed(0)} ms`);
    expect(contentCrypto().plugin.opened - opened0).toBe(1000);
    expect(rows.every((r) => r.about_me === TWO_KB)).toBe(true);
    expect(took).toBeLessThan(scaled(5000));
  });

  it('opens 1000 sealed values for ONE owner (a mailbox) with a warm key at a few ms per hundred', async () => {
    await store.getDek(keys, 'u_mailbox');
    const sealedTexts = await Promise.all(
      Array.from({ length: 1000 }, () => sealText(store, keys, 'u_mailbox', 'users:about_me', TWO_KB)),
    );
    await bulkUsers(1000, (i) => sealedTexts[i]!);

    const viaPlugin = await median(7, () => db.selectFrom('users').select(['id', 'about_me']).execute());
    const viaRaw = await median(7, () => raw.selectFrom('users').select(['id', 'about_me']).execute());

    report('1000 sealed values, one owner', `plugin ${viaPlugin.toFixed(0)} ms vs raw ${viaRaw.toFixed(0)} ms`);
    expect(viaPlugin - viaRaw).toBeLessThan(scaled(400));
  });

  it('a 50-row page (what a list screen loads) pays well under 10 ms to open', async () => {
    await store.getDek(keys, 'u_page');
    const sealedTexts = await Promise.all(
      Array.from({ length: 50 }, () => sealText(store, keys, 'u_page', 'users:about_me', TWO_KB)),
    );
    await bulkUsers(50, (i) => sealedTexts[i]!);

    const viaPlugin = await median(15, () => db.selectFrom('users').select(['id', 'about_me']).execute());
    const viaRaw = await median(15, () => raw.selectFrom('users').select(['id', 'about_me']).execute());

    report('50-row page', `+${(viaPlugin - viaRaw).toFixed(1)} ms`);
    expect(viaPlugin - viaRaw).toBeLessThan(scaled(25));
  });
});

describe('the write path', () => {
  it('sealing 1000 values before insert costs a fraction of the insert itself', async () => {
    await store.getDek(keys, 'u_write');
    const plainIds = await (async () => {
      const t0 = performance.now();
      await bulkUsers(1000, () => TWO_KB);
      return ms(t0);
    })();
    await raw.deleteFrom('users').execute();

    const t1 = performance.now();
    const sealed = await Promise.all(
      Array.from({ length: 1000 }, () => sealText(store, keys, 'u_write', 'users:about_me', TWO_KB)),
    );
    const sealMs = ms(t1);
    await bulkUsers(1000, (i) => sealed[i]!);
    const total = ms(t1);

    report('insert 1000 x 2KB', `plain ${plainIds.toFixed(0)} ms; sealed ${total.toFixed(0)} ms (seal alone ${sealMs.toFixed(0)} ms)`);
    expect(sealMs).toBeLessThan(scaled(600));
    expect(total).toBeLessThan(plainIds * 3 + scaled(500));
  });
});

describe('files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chord-perf-'));
  });
  afterEach(async () => {
    setContentEncryption(false);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a 5 MB attachment round-trips sealed within a small multiple of a plain one', async () => {
    const data = randomBytes(5 * 1024 * 1024);
    const plainFile = path.join(dir, 'plain.bin');
    const sealedFile = path.join(dir, 'sealed.bin');
    await store.getDek(keys, 'g_perf');

    const plain = await median(5, async () => {
      setContentEncryption(false);
      await writeBlob('g_perf', plainFile, data);
      return readBlob(plainFile);
    });
    const sealed = await median(5, async () => {
      setContentEncryption(true);
      await writeBlob('g_perf', sealedFile, data);
      return readBlob(sealedFile);
    });

    report('5MB write+read', `plain ${plain.toFixed(0)} ms vs sealed ${sealed.toFixed(0)} ms`);
    expect((await readBlob(sealedFile)).equals(data)).toBe(true);
    expect(sealed).toBeLessThan(plain * 8 + scaled(200));
    expect(sealed).toBeLessThan(scaled(1000));
  });

  it('sealing is linear in size: 10x the bytes is not 100x the time', async () => {
    await store.getDek(keys, 'g_lin');
    const small = randomBytes(1 * 1024 * 1024);
    const large = randomBytes(10 * 1024 * 1024);
    const tSmall = await median(5, () => sealFile(store, keys, 'g_lin', small));
    const tLarge = await median(5, () => sealFile(store, keys, 'g_lin', large));
    report('seal 1MB / 10MB', `${tSmall.toFixed(1)} ms / ${tLarge.toFixed(1)} ms`);
    expect(tLarge).toBeLessThan(tSmall * 30 + scaled(30));
  });

  it('opening a sealed file needs the key once, however many files there are', async () => {
    const provider = new CountingProvider();
    const s = new KeyStore(provider, { ttlMs: 60_000, maxEntries: 10 });
    const sealed = await Promise.all(Array.from({ length: 50 }, () => sealFile(s, keys, 'g_files', randomBytes(50_000))));
    const before = provider.wraps + provider.unwraps;
    for (const f of sealed) await openFile(s, keys, f);
    expect(provider.wraps + provider.unwraps).toBe(before);
  });
});
