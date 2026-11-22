/**
 * ADR 0091 / 0258 — where to ask for a user's weather.
 *
 * Four tiers, best available wins. ADR 0258 added the first: the app asks for
 * the phone's approximate location and, when the user allows it, uses that.
 * Everything below it is what happens when they have not.
 *
 *   0. `device` — the phone's (or browser's) own fix, only when allowed.
 *               Accurate, and kept to about a kilometre.
 *   1. `ip`   — GeoLite2 against the request address. Metro-accurate, resolved
 *               from a local file so the address never leaves the server. The
 *               IP itself is never persisted; only the city it produced.
 *   2. `tz`   — the city inside the IANA zone name. Coarse (America/New_York
 *               spans Boston to Miami), so it only fills in when the IP tier
 *               has nothing.
 *   3. `user` — an explicit Settings choice. Authoritative, and never
 *               overwritten by either automatic tier — an explicit answer has
 *               to survive travel, which is exactly when IP and tz both move.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import { getWeatherProvider } from '../weather/index.js';
import { cityForIp } from './geoip.js';

export type LocationSource = 'device' | 'ip' | 'tz' | 'user';

export interface WeatherLocation {
  place: string;
  lat: number;
  lon: number;
  source: LocationSource;
}

/**
 * The city buried in an IANA zone name: `America/Argentina/Buenos_Aires` →
 * "Buenos Aires". Zones that name a region rather than a city (`UTC`, `GMT`,
 * `Etc/...`) yield null rather than a nonsense geocode.
 */
export function cityFromTimezone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  const parts = tz.split('/');
  if (parts.length < 2) return null;
  if (parts[0] === 'Etc') return null;
  const last = parts[parts.length - 1].replace(/_/g, ' ').trim();
  return last.length > 1 ? last : null;
}

export interface StoredLocation {
  weather_lat: number | null;
  weather_lon: number | null;
  weather_place: string | null;
  weather_place_source: string | null;
  last_tz: string | null;
}

async function load(db: Kysely<DB>, userId: string): Promise<StoredLocation | undefined> {
  return await db
    .selectFrom('users')
    .select(['weather_lat', 'weather_lon', 'weather_place', 'weather_place_source', 'last_tz'])
    .where('id', '=', userId)
    .executeTakeFirst();
}

function toLocation(row: StoredLocation): WeatherLocation | null {
  if (typeof row.weather_lat !== 'number' || typeof row.weather_lon !== 'number') return null;
  if (!row.weather_place) return null;
  return {
    place: row.weather_place,
    lat: row.weather_lat,
    lon: row.weather_lon,
    source: (row.weather_place_source as LocationSource | null) ?? 'tz',
  };
}

async function persist(
  db: Kysely<DB>,
  userId: string,
  loc: WeatherLocation,
): Promise<void> {
  await db
    .updateTable('users')
    .set({
      weather_lat: loc.lat,
      weather_lon: loc.lon,
      weather_place: loc.place,
      weather_place_source: loc.source,
      // The stored location just changed, so any open drift question is moot.
      // (ADR 0148 — `set_weather_location` and clear go through here too.)
      weather_prompt_at: null,
      weather_prompt_lat: null,
      weather_prompt_lon: null,
      weather_prompt_declined: 0,
    })
    .where('id', '=', userId)
    .execute();
}

/** Great-circle distance in kilometres. Exported for the drift-check tests. */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Record a location derived from a request IP. No-op when the user already
 * chose one — tier 3 outranks tier 1. Best-effort: a failure here must never
 * affect the request that triggered it.
 */
export async function seedLocationFromIp(
  db: Kysely<DB>,
  userId: string,
  ip: string | undefined,
): Promise<void> {
  try {
    const row = await load(db, userId);
    if (!row) return;
    // An explicit choice, or the phone's own fix, outranks an address lookup.
    if (row.weather_place_source === 'user' || row.weather_place_source === 'device') return;
    // Already have an IP-derived fix — don't re-resolve on every request.
    if (row.weather_place_source === 'ip' && row.weather_place) return;
    const hit = await cityForIp(ip);
    if (!hit) return;
    await persist(db, userId, { ...hit, source: 'ip' });
  } catch (err) {
    logger.info('geo: ip seed failed', { err });
  }
}

/**
 * The user's weather location, resolving and caching a timezone-derived one if
 * nothing better exists yet. Null when there is no usable signal at all.
 *
 * `preloaded` lets a caller that already fetched this same row (e.g. the
 * briefing, which reads `last_tz` off `users` anyway) skip a second trip to
 * a row it just read. Omit it and this fetches its own copy as before.
 */
export async function resolveWeatherLocation(
  db: Kysely<DB>,
  userId: string,
  preloaded?: StoredLocation,
): Promise<WeatherLocation | null> {
  const row = preloaded ?? (await load(db, userId));
  if (!row) return null;

  const stored = toLocation(row);
  if (stored) return stored;

  const city = cityFromTimezone(row.last_tz);
  if (!city) return null;
  const provider = getWeatherProvider();
  if (!provider) return null;

  const hit = await provider.geocode(city);
  if (!hit) return null;
  const loc: WeatherLocation = { ...hit, source: 'tz' };
  await persist(db, userId, loc);
  return loc;
}

/**
 * Set an explicit location from Settings. Returns null when the place does not
 * geocode, so the route can 400 rather than silently keeping the old value.
 */
export async function setUserWeatherLocation(
  db: Kysely<DB>,
  userId: string,
  place: string,
): Promise<WeatherLocation | null> {
  const provider = getWeatherProvider();
  if (!provider) return null;
  const hit = await provider.geocode(place);
  if (!hit) return null;
  const loc: WeatherLocation = { ...hit, source: 'user' };
  await persist(db, userId, loc);
  return loc;
}

/** Clear an explicit choice so the automatic tiers take over again. */
export async function clearUserWeatherLocation(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  await db
    .updateTable('users')
    .set({
      weather_lat: null,
      weather_lon: null,
      weather_place: null,
      weather_place_source: null,
      weather_prompt_at: null,
      weather_prompt_lat: null,
      weather_prompt_lon: null,
      weather_prompt_declined: 0,
    })
    .where('id', '=', userId)
    .execute();
}

// ── ADR 0258: the phone's own location ──────────────────────────────────────
//
// Nothing about a person's whereabouts is stored more finely than a city needs:
// coordinates are rounded to two decimals (about a kilometre) before they are
// kept, and a fix that has not moved is not re-written.

const FIX_ROUNDING = 100;
const SAME_SPOT_KM = 2;
/** A fix older than this is a traveller artifact, not where they are now. */
const DEVICE_FIX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

const round2 = (n: number): number => Math.round(n * FIX_ROUNDING) / FIX_ROUNDING;

export interface DeviceFix {
  lat: number;
  lon: number;
  /** The phone's own reverse-geocoded name, when it has one (a browser does not). */
  place?: string | null;
}

/**
 * A name for a fix that arrived without one: the time-zone city when it is near
 * (the briefing says "in New York", not coordinates), else a plain label.
 */
async function labelFor(
  at: { lat: number; lon: number },
  tz: string | null,
): Promise<string> {
  const city = cityFromTimezone(tz);
  const provider = city ? getWeatherProvider() : null;
  if (city && provider) {
    const hit = await provider.geocode(city);
    if (hit && haversineKm(at, hit) <= 150) return hit.place;
  }
  return 'Your location';
}

/**
 * The phone reported where it is. Becomes the weather location unless the user
 * chose one themselves, which survives travel (ADR 0091): then the fix is only
 * remembered, so the "you seem to have moved" question can use it (ADR 0148).
 */
export async function applyDeviceLocation(
  db: Kysely<DB>,
  userId: string,
  fix: DeviceFix,
): Promise<{ applied: boolean; location: WeatherLocation | null }> {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return { applied: false, location: null };
  if (Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return { applied: false, location: null };
  const row = await load(db, userId);
  if (!row) return { applied: false, location: null };

  const at = { lat: round2(fix.lat), lon: round2(fix.lon) };
  const given = fix.place?.trim().slice(0, 120);
  const place = given || (await labelFor(at, row.last_tz));
  const observation = {
    weather_device_place: place,
    weather_device_lat: at.lat,
    weather_device_lon: at.lon,
    weather_device_at: new Date().toISOString(),
  };
  const stored = toLocation(row);

  if (row.weather_place_source === 'user') {
    await db.updateTable('users').set(observation).where('id', '=', userId).execute();
    return { applied: false, location: stored };
  }
  if (stored && row.weather_place_source === 'device' && haversineKm(stored, at) <= SAME_SPOT_KM) {
    await db.updateTable('users').set(observation).where('id', '=', userId).execute();
    return { applied: false, location: stored };
  }

  const location: WeatherLocation = { place, lat: at.lat, lon: at.lon, source: 'device' };
  await persist(db, userId, location);
  await db.updateTable('users').set(observation).where('id', '=', userId).execute();
  return { applied: true, location };
}

/**
 * The user turned location off (or revoked it in the OS). Forget the fix, and if
 * it was what the weather was using, let the IP and time-zone tiers take over
 * again. An explicit choice is left alone.
 */
export async function clearDeviceLocation(db: Kysely<DB>, userId: string): Promise<void> {
  const row = await load(db, userId);
  if (!row) return;
  await db
    .updateTable('users')
    .set({
      weather_device_place: null,
      weather_device_lat: null,
      weather_device_lon: null,
      weather_device_at: null,
    })
    .where('id', '=', userId)
    .execute();
  if (row.weather_place_source === 'device') await clearUserWeatherLocation(db, userId);
}

// ── ADR 0148: proactive "you seem to have moved" check ──────────────────────
//
// The stored weather location can quietly go wrong: someone travels, or types
// the wrong city once. The signal is a fresh automatic fix — the phone's own
// location when allowed (ADR 0258), else the IP-derived city, else the city
// inside the device timezone — compared to the stored coordinates.
// When they are far apart the morning briefing appends one line asking whether
// to switch; the user answers in chat and `set_weather_location` acts on it.
// Nothing here ever changes the location on its own.

/** IP fix older than this is ignored as a stale traveller artifact. */
const IP_STASH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface WeatherDrift {
  storedPlace: string;
  detectedPlace: string;
  detectedLat: number;
  detectedLon: number;
  km: number;
}

/**
 * Record the last IP-derived city on the user row. Called from `/me/timezone`
 * (launch + every foreground), which is the only place with a request IP —
 * the daily scan that decides whether to prompt has none of its own.
 * Best-effort; never throws.
 */
export async function stashIpObservation(
  db: Kysely<DB>,
  userId: string,
  ip: string | undefined,
): Promise<void> {
  try {
    const hit = await cityForIp(ip);
    if (!hit) return;
    await db
      .updateTable('users')
      .set({
        weather_ip_place: hit.place,
        weather_ip_lat: hit.lat,
        weather_ip_lon: hit.lon,
        weather_ip_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  } catch (err) {
    logger.info('geo: ip observation stash failed', { err });
  }
}

interface DriftRow {
  weather_lat: number | null;
  weather_lon: number | null;
  weather_place: string | null;
  last_tz: string | null;
  weather_ip_place: string | null;
  weather_ip_lat: number | null;
  weather_ip_lon: number | null;
  weather_ip_at: string | null;
  weather_device_place: string | null;
  weather_device_lat: number | null;
  weather_device_lon: number | null;
  weather_device_at: string | null;
  weather_prompt_lat: number | null;
  weather_prompt_lon: number | null;
  weather_prompt_at: string | null;
  weather_prompt_declined: number | null;
}

/**
 * Is the stored weather location far enough from where the user now appears to
 * be that the briefing should ask about it? Returns the two places and the
 * distance, or null when there is nothing to ask (no stored location, no fresh
 * fix, close enough, or we already asked about this spot recently / the user
 * said to keep it). Read-only — call `recordWeatherDriftPrompt` once the
 * question has actually been posted.
 */
export async function detectWeatherDrift(
  db: Kysely<DB>,
  userId: string,
): Promise<WeatherDrift | null> {
  const driftKm = env.WEATHER_DRIFT_KM;
  const row = (await db
    .selectFrom('users')
    .select([
      'weather_lat',
      'weather_lon',
      'weather_place',
      'last_tz',
      'weather_ip_place',
      'weather_ip_lat',
      'weather_ip_lon',
      'weather_ip_at',
      'weather_device_place',
      'weather_device_lat',
      'weather_device_lon',
      'weather_device_at',
      'weather_prompt_lat',
      'weather_prompt_lon',
      'weather_prompt_at',
      'weather_prompt_declined',
    ])
    .where('id', '=', userId)
    .executeTakeFirst()) as DriftRow | undefined;
  if (!row) return null;
  if (
    typeof row.weather_lat !== 'number' ||
    typeof row.weather_lon !== 'number' ||
    !row.weather_place
  ) {
    // Nothing stored yet — the resolve/seed path handles the first fix.
    return null;
  }
  const stored = { lat: row.weather_lat, lon: row.weather_lon };

  // Fresh fix: the phone's own if it is recent, else the stashed IP city if that
  // is, else the timezone city.
  let detected: { place: string; lat: number; lon: number } | null = null;
  const deviceAge = row.weather_device_at ? Date.now() - Date.parse(row.weather_device_at) : Infinity;
  const ipAge = row.weather_ip_at ? Date.now() - Date.parse(row.weather_ip_at) : Infinity;
  if (
    row.weather_device_place &&
    typeof row.weather_device_lat === 'number' &&
    typeof row.weather_device_lon === 'number' &&
    Number.isFinite(deviceAge) &&
    deviceAge <= DEVICE_FIX_MAX_AGE_MS
  ) {
    detected = {
      place: row.weather_device_place,
      lat: row.weather_device_lat,
      lon: row.weather_device_lon,
    };
  } else if (
    row.weather_ip_place &&
    typeof row.weather_ip_lat === 'number' &&
    typeof row.weather_ip_lon === 'number' &&
    Number.isFinite(ipAge) &&
    ipAge <= IP_STASH_MAX_AGE_MS
  ) {
    detected = { place: row.weather_ip_place, lat: row.weather_ip_lat, lon: row.weather_ip_lon };
  } else {
    const city = cityFromTimezone(row.last_tz);
    const provider = city ? getWeatherProvider() : null;
    if (city && provider) {
      const hit = await provider.geocode(city);
      if (hit) detected = hit;
    }
  }
  if (!detected) return null;

  const km = haversineKm(stored, detected);
  if (km <= driftKm) return null;

  // Don't re-ask about the same place: within the re-ask window if the prompt
  // went unanswered, or indefinitely if the user said "keep it" — until a
  // fresh fix lands a real distance from the spot we last asked about.
  if (typeof row.weather_prompt_lat === 'number' && typeof row.weather_prompt_lon === 'number') {
    const nearLastAsk =
      haversineKm(detected, { lat: row.weather_prompt_lat, lon: row.weather_prompt_lon }) <= driftKm;
    if (nearLastAsk) {
      if (Number(row.weather_prompt_declined ?? 0) === 1) return null;
      const askedAge = row.weather_prompt_at
        ? Date.now() - Date.parse(row.weather_prompt_at)
        : Infinity;
      if (askedAge < env.WEATHER_DRIFT_REASK_DAYS * 24 * 60 * 60 * 1000) return null;
    }
  }

  return {
    storedPlace: row.weather_place,
    detectedPlace: detected.place,
    detectedLat: detected.lat,
    detectedLon: detected.lon,
    km: Math.round(km),
  };
}

/** Mark that the drift question has been asked, about `detected`'s coordinates. */
export async function recordWeatherDriftPrompt(
  db: Kysely<DB>,
  userId: string,
  detected: { lat: number; lon: number },
): Promise<void> {
  await db
    .updateTable('users')
    .set({
      weather_prompt_lat: detected.lat,
      weather_prompt_lon: detected.lon,
      weather_prompt_at: new Date().toISOString(),
      weather_prompt_declined: 0,
    })
    .where('id', '=', userId)
    .execute();
}

/**
 * The user answered "keep my current location" to a drift question. Suppress
 * further prompts about that spot; a move elsewhere still re-triggers.
 */
export async function declineWeatherDrift(db: Kysely<DB>, userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({ weather_prompt_declined: 1, weather_prompt_at: new Date().toISOString() })
    .where('id', '=', userId)
    .execute();
}

/**
 * The briefing line, when the stored location looks stale. Records the prompt
 * as a side effect (so a rendered question and the dedup state stay in step).
 * Null when there is nothing to ask.
 */
export async function weatherDriftQuestion(
  db: Kysely<DB>,
  userId: string,
): Promise<string | null> {
  if (!getWeatherProvider()) return null;
  const drift = await detectWeatherDrift(db, userId);
  if (!drift) return null;
  await recordWeatherDriftPrompt(db, userId, {
    lat: drift.detectedLat,
    lon: drift.detectedLon,
  });
  return (
    `📍 Your weather is set to **${drift.storedPlace}**, but you seem to be ` +
    `near **${drift.detectedPlace}** now. Want me to switch it? Reply "yes", ` +
    `tell me the right city, or "keep it" to leave it.`
  );
}
