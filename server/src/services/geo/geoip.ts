/**
 * ADR 0091 — city lookup from a request IP, against a LOCAL GeoLite2 file.
 *
 * The point of a local `.mmdb` rather than an IP-lookup API is that the
 * address never leaves this process: we resolve it, keep the city, and drop
 * the IP. Nothing is stored and nothing is sent to a third party.
 *
 * The database is optional. Absent or unreadable → every lookup returns null
 * and callers fall back to the timezone tier, so local dev and CI need no
 * file and no license key.
 */
import fs from 'node:fs';

import type { CityResponse, Reader } from 'maxmind';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';

export interface GeoCity {
  place: string;
  lat: number;
  lon: number;
}

let reader: Reader<CityResponse> | null = null;
let loaded = false;

/**
 * Open the database once. Failures are logged at info, not warn — running
 * without GeoIP is a supported configuration, not a degraded one.
 */
async function getReader(): Promise<Reader<CityResponse> | null> {
  if (loaded) return reader;
  loaded = true;
  const p = env.GEOIP_DB_PATH.trim();
  if (!p) return null;
  try {
    if (!fs.existsSync(p)) {
      logger.info('geoip: database not found, IP location disabled', { path: p });
      return null;
    }
    const maxmind = await import('maxmind');
    reader = await maxmind.open<CityResponse>(p);
    logger.info('geoip: database loaded', { path: p });
  } catch (err) {
    logger.info('geoip: database unreadable, IP location disabled', { err });
    reader = null;
  }
  return reader;
}

/** Loopback, private, link-local and CGNAT ranges — no useful geography. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^::ffff:/, '');
  if (!v || v === '::1' || v === 'localhost') return true;
  if (v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true;
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 100.64/10 — carrier-grade NAT, resolves to the carrier not the user.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * City + coordinates for an IP, or null when unknown. Never throws — a
 * weather location is never worth failing a request over.
 */
export async function cityForIp(ip: string | undefined): Promise<GeoCity | null> {
  if (!ip || isPrivateAddress(ip)) return null;
  const r = await getReader();
  if (!r) return null;
  try {
    const res = r.get(ip);
    const lat = res?.location?.latitude;
    const lon = res?.location?.longitude;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    const place =
      res?.city?.names?.en ??
      res?.subdivisions?.[0]?.names?.en ??
      res?.country?.names?.en ??
      null;
    if (!place) return null;
    return { place, lat, lon };
  } catch (err) {
    logger.info('geoip: lookup failed', { err });
    return null;
  }
}

/** Test seam — forget the cached reader so a new GEOIP_DB_PATH takes effect. */
export function resetGeoipForTests(): void {
  reader = null;
  loaded = false;
}
