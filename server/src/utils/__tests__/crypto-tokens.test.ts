import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetCryptoCacheForTests, openToken, sealToken } from '../crypto-tokens.js';

const SAVED_KEY = process.env.MASTER_KEY;

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = value;
  _resetCryptoCacheForTests();
}

describe('crypto-tokens', () => {
  beforeEach(() => {
    setKey(randomBytes(32).toString('base64'));
  });
  afterEach(() => {
    setKey(SAVED_KEY);
  });

  it('round-trips a token', () => {
    const plain = '1//0gabc-deadbeef-refreshtoken-payload';
    const sealed = sealToken(plain);
    expect(sealed.ciphertext.length).toBeGreaterThan(0);
    expect(sealed.iv.length).toBe(12);
    expect(sealed.tag.length).toBe(16);
    expect(openToken(sealed)).toBe(plain);
  });

  it('produces different ciphertext for the same plaintext (random iv)', () => {
    const plain = 'same-input';
    const a = sealToken(plain);
    const b = sealToken(plain);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a tampered tag', () => {
    const sealed = sealToken('payload');
    sealed.tag[0] ^= 0xff;
    expect(() => openToken(sealed)).toThrow();
  });

  it('rejects decryption under a different key', () => {
    const sealed = sealToken('payload');
    setKey(randomBytes(32).toString('base64'));
    expect(() => openToken(sealed)).toThrow();
  });

  it('throws if MASTER_KEY is unset', () => {
    setKey(undefined);
    expect(() => sealToken('x')).toThrow(/MASTER_KEY is not set/);
  });

  it('throws if MASTER_KEY decodes to the wrong length', () => {
    setKey(Buffer.from('too-short').toString('base64'));
    expect(() => sealToken('x')).toThrow(/must decode to 32 bytes/);
  });
});
