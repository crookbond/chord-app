/**
 * Phone normalization + hashing (ADR 0064 / 0065).
 *
 * `normalizeE164` produces the canonical `+`<digits> form both sides of the
 * contact-resolution contract agree on: the mobile client normalizes device
 * numbers (libphonenumber) to E.164 before hashing, and the server stores the
 * verified number in the same shape. As long as both yield the identical
 * string, `hashPhone` matches. We keep the server normalizer intentionally
 * small (no libphonenumber dependency): it canonicalizes already-E.164 input
 * (a `+`-prefixed number, or a `00`-prefixed international form) and rejects
 * anything ambiguous — a bare national number with no country code can't be
 * resolved without a region, so we don't guess.
 */
import { createHmac } from 'node:crypto';

import { env } from '../../config/env.js';

/**
 * Canonicalize to E.164 (`+` followed by 8–15 digits), or null when the input
 * isn't unambiguously an international number. Strips spaces, dashes, parens,
 * dots; maps a leading `00` to `+`. A leading country-code digit of 0 is
 * invalid (E.164 country codes are 1–9).
 */
export function normalizeE164(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  // Common IDD prefix: 00<cc> → +<cc>.
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  const hasPlus = s.startsWith('+');
  // Keep only digits.
  const digits = s.replace(/\D+/g, '');
  if (!hasPlus) return null; // no country code → can't resolve without a region
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith('0')) return null; // country codes never start with 0
  return `+${digits}`;
}

/** The number Chord is reachable at on WhatsApp (ADR 0253), or null when the
 * deployment has not published one. Validated, so a typo in config hides the
 * entry instead of rendering a broken link. */
export function publicWhatsappNumber(): string | null {
  return normalizeE164(env.WHATSAPP_PUBLIC_NUMBER);
}

/**
 * Deterministic keyed hash of an E.164 number — the value matched against
 * uploaded, client-hashed contacts (ADR 0065). HMAC-SHA256 with
 * `CONTACT_HASH_PEPPER`; the client folds in the same pepper. Not
 * enclave-grade privacy (the pepper ships in the app) — see ADR 0065.
 *
 * Input is normalized first, so `hashPhone('+1 (555) 123-4567')` ===
 * `hashPhone('+15551234567')`. Throws on un-normalizable input so a caller
 * never silently hashes garbage into a non-matching value.
 */
export function hashPhone(e164OrRaw: string): string {
  const normalized = normalizeE164(e164OrRaw);
  if (!normalized) {
    throw new Error(`hashPhone: not a valid E.164 number: ${JSON.stringify(e164OrRaw)}`);
  }
  return createHmac('sha256', env.CONTACT_HASH_PEPPER).update(normalized).digest('hex');
}
