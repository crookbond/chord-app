/**
 * Sealed text and files (ADR 0201): what must round-trip, and, more to the
 * point, everything that must FAIL. A cipher that opens things it should not is
 * worse than none, so most of these are attacks and mistakes rather than the
 * happy path. No database: keys are supplied by a stub store.
 */
import { randomBytes } from 'node:crypto';

import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { DB } from '../../schema.js';
import { KeyStore } from '../content-keys.js';
import {
  deriveKey,
  isSealedFile,
  isSealedText,
  openFile,
  openText,
  SealError,
  sealFile,
  sealText,
  sealedOwner,
  TEXT_PREFIX,
} from '../envelope.js';
import { LocalKeyProvider } from '../key-provider.js';

const NO_DB = null as unknown as Kysely<DB>;

/** A store whose keys are fixed per owner, so the cipher is tested on its own. */
class StubStore extends KeyStore {
  private readonly keys = new Map<string, Buffer>();
  constructor() {
    super(new LocalKeyProvider(Buffer.alloc(32, 1)), { ttlMs: 1000, maxEntries: 10 });
  }
  override async getDek(_db: Kysely<DB>, owner: string): Promise<Buffer> {
    let k = this.keys.get(owner);
    if (!k) {
      k = randomBytes(32);
      this.keys.set(owner, k);
    }
    return k;
  }
}

const store = new StubStore();
const seal = (owner: string, ctx: string, text: string) => sealText(store, NO_DB, owner, ctx, text);
const open = (sealed: string) => openText(store, NO_DB, sealed);

describe('sealText', () => {
  it('round-trips, including unicode, emoji, empty and very long text', async () => {
    for (const text of ['', 'plain', 'café — 学校の連絡 🎓', 'x'.repeat(1_000_000), 'line1\nline2\r\n\t"quoted"']) {
      expect(await open(await seal('u_a', 'email_messages:body_text', text))).toBe(text);
    }
  });

  it('carries the marker, owner and context, and nothing of the plaintext', async () => {
    const s = await seal('u_alice', 'email_messages:subject', 'Confirmation code KX8QP2');
    expect(s.startsWith(TEXT_PREFIX)).toBe(true);
    expect(isSealedText(s)).toBe(true);
    expect(sealedOwner(s)).toBe('u_alice');
    expect(s).not.toContain('KX8QP2');
    expect(s).not.toContain('Confirmation');
  });

  it('never seals the same text twice the same way (fresh IV each time)', async () => {
    const a = await seal('u_a', 'ctx', 'same words');
    const b = await seal('u_a', 'ctx', 'same words');
    expect(a).not.toBe(b);
    expect(await open(a)).toBe(await open(b));
  });

  it('is longer than the plaintext only by a fixed overhead', async () => {
    const short = await seal('u_a', 'ctx', 'a');
    const long = await seal('u_a', 'ctx', 'a'.repeat(10_000));
    // 12-byte IV + 16-byte tag, base64url, plus the header. Bounded, so
    // encrypting cannot balloon a column.
    expect(short.length).toBeLessThan(120);
    expect(long.length).toBeLessThan(10_000 * 1.34 + 120);
  });

  it('refuses labels that would break the format or the AAD', async () => {
    await expect(seal('u.a', 'ctx', 'x')).rejects.toThrow(SealError);
    await expect(seal('u_a', 'c.tx', 'x')).rejects.toThrow(SealError);
    await expect(seal('u|a', 'ctx', 'x')).rejects.toThrow(SealError);
    await expect(seal('', 'ctx', 'x')).rejects.toThrow(SealError);
    await expect(seal('u_a', '', 'x')).rejects.toThrow(SealError);
  });
});

describe('openText refuses what it should', () => {
  it('a single flipped bit anywhere in the ciphertext', async () => {
    const s = await seal('u_a', 'ctx', 'a message that must not be altered');
    const [pre, owner, ctx, payload] = s.split('.');
    const raw = Buffer.from(payload!, 'base64url');
    for (const at of [0, 5, 12, Math.floor(raw.length / 2), raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[at] = bad[at]! ^ 0x01;
      await expect(open(`${pre}.${owner}.${ctx}.${bad.toString('base64url')}`)).rejects.toThrow(SealError);
    }
  });

  it('a truncated value', async () => {
    const s = await seal('u_a', 'ctx', 'hello');
    await expect(open(s.slice(0, -8))).rejects.toThrow(SealError);
    await expect(open(`${TEXT_PREFIX}u_a.ctx.`)).rejects.toThrow(SealError);
  });

  it('a value re-labelled as another column', async () => {
    const s = await seal('u_a', 'email_messages:subject', 'secret');
    const relabelled = s.replace('email_messages:subject', 'email_messages:body_text');
    await expect(open(relabelled)).rejects.toThrow(SealError);
  });

  it("a value moved to another owner, even one with a key", async () => {
    const s = await seal('u_a', 'ctx', 'alice private');
    await seal('u_b', 'ctx', 'warm up bob key');
    await expect(open(s.replace('u_a', 'u_b'))).rejects.toThrow(SealError);
  });

  it('a value from a different key with the same labels', async () => {
    const other = new StubStore();
    const foreign = await sealText(other, NO_DB, 'u_a', 'ctx', 'sealed under another store');
    // Same owner and ctx, but a different data key: must fail, not decode garbage.
    await expect(open(foreign)).rejects.toThrow(SealError);
  });

  it('malformed strings that merely look sealed', async () => {
    for (const bad of ['enc1.', 'enc1.a.b', 'enc1.a.b.c.d', 'enc2.a.b.c', 'enc1.a.b.!!!']) {
      await expect(open(bad)).rejects.toThrow();
    }
  });

  it('does not treat ordinary text as sealed', () => {
    expect(isSealedText('hello')).toBe(false);
    expect(isSealedText('')).toBe(false);
    expect(isSealedText(null)).toBe(false);
    expect(isSealedText(42)).toBe(false);
    expect(isSealedText(' enc1.a.b.c')).toBe(false);
  });
});

describe('sealFile', () => {
  it('round-trips arbitrary bytes, including empty and 5 MB', async () => {
    for (const data of [Buffer.alloc(0), Buffer.from('%PDF-1.7 hello'), randomBytes(5 * 1024 * 1024)]) {
      const sealed = await sealFile(store, NO_DB, 'g_family', data);
      expect(isSealedFile(sealed)).toBe(true);
      expect((await openFile(store, NO_DB, sealed)).equals(data)).toBe(true);
    }
  });

  it('leaves no recognisable plaintext in the sealed bytes', async () => {
    const data = Buffer.from('BitGo invoice total $4,180.00 confirmation KX8QP2');
    const sealed = await sealFile(store, NO_DB, 'g_family', data);
    expect(sealed.includes(Buffer.from('BitGo'))).toBe(false);
    expect(sealed.includes(Buffer.from('KX8QP2'))).toBe(false);
  });

  it('records the owner so a reader needs nothing else', async () => {
    const sealed = await sealFile(store, NO_DB, 'u_carol', Buffer.from('x'));
    expect(sealed.includes(Buffer.from('u_carol'))).toBe(true);
    expect((await openFile(store, NO_DB, sealed)).toString()).toBe('x');
  });

  it('is not mistaken for a plain file, and a plain file is not mistaken for it', async () => {
    expect(isSealedFile(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(isSealedFile(Buffer.alloc(0))).toBe(false);
    expect(isSealedFile(Buffer.from('CHENC1\n'))).toBe(false); // magic alone, no body
    expect(isSealedFile(await sealFile(store, NO_DB, 'g_a', Buffer.from('x')))).toBe(true);
    await expect(openFile(store, NO_DB, Buffer.from('%PDF-1.7'))).rejects.toThrow(SealError);
  });

  it('rejects a flipped bit, a truncated file, and a swapped owner', async () => {
    const data = randomBytes(2000);
    const sealed = await sealFile(store, NO_DB, 'g_a', data);
    for (const at of [sealed.length - 1, sealed.length - 17, 40, sealed.length >> 1]) {
      const bad = Buffer.from(sealed);
      bad[at] = bad[at]! ^ 0x80;
      await expect(openFile(store, NO_DB, bad)).rejects.toThrow(SealError);
    }
    await expect(openFile(store, NO_DB, sealed.subarray(0, sealed.length - 5))).rejects.toThrow(SealError);

    await sealFile(store, NO_DB, 'g_b', Buffer.from('warm'));
    const swapped = Buffer.from(sealed);
    swapped.write('g_b', 'CHENC1\n'.length + 1);
    await expect(openFile(store, NO_DB, swapped)).rejects.toThrow(SealError);
  });

  it('a sealed file cannot be opened as text or the reverse', async () => {
    const sealedFile = await sealFile(store, NO_DB, 'g_a', Buffer.from('x'));
    expect(isSealedText(sealedFile.toString('latin1'))).toBe(false);
    const sealedText = await seal('u_a', 'ctx', 'x');
    await expect(openFile(store, NO_DB, Buffer.from(sealedText))).rejects.toThrow(SealError);
  });
});

describe('deriveKey', () => {
  it('is deterministic per (key, purpose) and different across purposes and keys', () => {
    const dek = randomBytes(32);
    expect(deriveKey(dek, 'index').equals(deriveKey(dek, 'index'))).toBe(true);
    expect(deriveKey(dek, 'index').equals(deriveKey(dek, 'other'))).toBe(false);
    expect(deriveKey(dek, 'index').equals(deriveKey(randomBytes(32), 'index'))).toBe(false);
    expect(deriveKey(dek, 'index').equals(dek)).toBe(false);
    expect(deriveKey(dek, 'index')).toHaveLength(32);
  });
});
