/**
 * Lexemes are memoised (a message asks for thousands, and mail repeats its
 * vocabulary). The memo must be invisible: same bytes as computing each one
 * fresh, and never shared between keys.
 */
import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildCodeGramsVector, buildGramsVector, buildWordsVector } from '../blind-index.js';

const TEXT =
  'Your order has shipped. Tracking number 1Z999AA10123456784 arrives Thursday; ' +
  'the shipping confirmation, the delivery window and the return policy are attached.';

describe('lexeme memo', () => {
  it('a warm memo yields exactly what a cold computation does', () => {
    const key = randomBytes(32);
    const cold = buildWordsVector(key, TEXT);
    const warm = buildWordsVector(key, TEXT);
    // Same bytes under a NEW key instance: nothing of the first is reused.
    const fresh = buildWordsVector(Buffer.from(key), TEXT);
    expect(warm).toBe(cold);
    expect(fresh).toBe(cold);
    expect(cold.length).toBeGreaterThan(50);
  });

  it('is the documented HMAC, not something else: a known gram lands as x + first 4 bytes', () => {
    const key = randomBytes(32);
    const vec = buildGramsVector(key, 'abcd');
    for (const gram of ['abc', 'bcd']) {
      const h = createHmac('sha256', key).update('g').update(':').update(gram).digest();
      expect(vec).toContain(`x${h.subarray(0, 4).toString('hex')}`);
    }
    // ...still true once the memo is warm.
    expect(buildGramsVector(key, 'abcd')).toBe(vec);
  });

  it('never shares lexemes between keys', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    const va = buildWordsVector(a, TEXT);
    const vb = buildWordsVector(b, TEXT);
    expect(vb).not.toBe(va);
    // Interleaved use does not cross the streams.
    expect(buildWordsVector(a, TEXT)).toBe(va);
    expect(buildWordsVector(b, TEXT)).toBe(vb);
    expect(buildCodeGramsVector(a, TEXT)).not.toBe(buildCodeGramsVector(b, TEXT));
  });

  it('kinds do not collide: the word "abc" and the gram "abc" are different lexemes', () => {
    const key = randomBytes(32);
    const asWord = buildWordsVector(key, 'abc');
    const asGram = buildGramsVector(key, 'abc');
    const h = (kind: string) =>
      `x${createHmac('sha256', key).update(kind).update(':').update('abc').digest().subarray(0, 4).toString('hex')}`;
    expect(asWord).toContain(h('w'));
    expect(asGram).toContain(h('g'));
    expect(h('w')).not.toBe(h('g'));
  });
});
