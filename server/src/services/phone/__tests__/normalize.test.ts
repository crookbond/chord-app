/**
 * ADR 0064/0065 — E.164 normalization + the phone HMAC. Pure, no DB.
 */
import { describe, expect, it } from 'vitest';

import { hashPhone, normalizeE164 } from '../normalize.js';

describe('normalizeE164', () => {
  it('canonicalizes valid international numbers to +<digits>', () => {
    expect(normalizeE164('+15551234567')).toBe('+15551234567');
    expect(normalizeE164('+1 (555) 123-4567')).toBe('+15551234567');
    expect(normalizeE164('  +1-555-123-4567 ')).toBe('+15551234567');
    expect(normalizeE164('+44 20 7946 0958')).toBe('+442079460958');
    // 00 IDD prefix maps to +.
    expect(normalizeE164('0015551234567')).toBe('+15551234567');
  });

  it('rejects ambiguous or malformed input', () => {
    expect(normalizeE164('5551234567')).toBeNull(); // no country code
    expect(normalizeE164('555-1234')).toBeNull();
    expect(normalizeE164('+0123456789')).toBeNull(); // country code can't start with 0
    expect(normalizeE164('+1234')).toBeNull(); // too short
    expect(normalizeE164('+1234567890123456')).toBeNull(); // > 15 digits
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('   ')).toBeNull();
    expect(normalizeE164('not a phone')).toBeNull();
  });
});

describe('hashPhone', () => {
  it('is deterministic and format-independent', () => {
    const a = hashPhone('+15551234567');
    const b = hashPhone('+1 (555) 123-4567');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different numbers', () => {
    expect(hashPhone('+15551234567')).not.toBe(hashPhone('+15551234568'));
  });

  it('throws on un-normalizable input rather than hashing garbage', () => {
    expect(() => hashPhone('5551234567')).toThrow();
  });
});
