/**
 * Client-side contact normalization + hashing (ADR 0065).
 *
 * Device numbers are normalized to E.164 (libphonenumber, so national formats
 * like "(555) 111-2222" resolve using the device region) and HMAC-SHA256'd
 * with the shared pepper fetched from `GET /me/phone`. Raw names/numbers never
 * leave the phone - only the contact's display name + hex hashes are uploaded.
 *
 * The hex output MUST match the server's `hashPhone` (node crypto HMAC over
 * the identical E.164 string); @noble/hashes is the pure-JS equivalent that
 * runs under Hermes.
 */
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import parsePhoneNumberFromString, { type CountryCode } from 'libphonenumber-js';

export interface DeviceContactInput {
  name: string;
  phoneNumbers: string[];
}

export interface HashedContact {
  name: string;
  phoneHashes: string[];
}

/** Server contract cap - ResolveContactsRequest allows ≤20 hashes per contact. */
const MAX_HASHES_PER_CONTACT = 20;
/** Server contract cap - ≤5000 contacts per upload. */
const MAX_CONTACTS = 5000;

/**
 * Best-effort device region for numbers stored without a country code.
 * Locale strings look like "en-US" / "en_IN"; no region → US (fine for the
 * F&F cohort; international numbers in address books carry their own `+`).
 */
export function deviceRegion(): CountryCode {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? '';
    const m = /[-_]([A-Za-z]{2})\b/.exec(locale);
    if (m) return m[1].toUpperCase() as CountryCode;
  } catch {
    /* Intl unavailable - fall through */
  }
  return 'US';
}

/** Normalize one raw device number to E.164, or null when unresolvable. */
export function normalizeDeviceNumber(raw: string, region: CountryCode): string | null {
  const parsed = parsePhoneNumberFromString(raw, region);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number;
}

export function hashE164(e164: string, pepper: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(pepper), utf8ToBytes(e164)));
}

/**
 * Turn raw device contacts into the upload payload: E.164-normalize each
 * number for the device region, hash with the shared pepper, drop contacts
 * with no resolvable number, dedupe hashes within a contact.
 */
export function buildContactUpload(
  contacts: DeviceContactInput[],
  pepper: string,
  region: CountryCode = deviceRegion(),
): HashedContact[] {
  const out: HashedContact[] = [];
  for (const c of contacts) {
    const name = c.name.trim();
    if (!name) continue;
    const hashes = new Set<string>();
    for (const raw of c.phoneNumbers) {
      const e164 = normalizeDeviceNumber(raw, region);
      if (e164) hashes.add(hashE164(e164, pepper));
      if (hashes.size >= MAX_HASHES_PER_CONTACT) break;
    }
    if (hashes.size > 0) out.push({ name, phoneHashes: [...hashes] });
    if (out.length >= MAX_CONTACTS) break;
  }
  return out;
}
