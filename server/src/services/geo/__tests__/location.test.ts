/**
 * ADR 0091 — deriving a weather location without a location permission.
 *
 * The rule that matters most is precedence: an explicit Settings choice must
 * survive travel, which is exactly the moment both automatic tiers move.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { isPrivateAddress } from '@/services/geo/geoip.js';
import {
  cityFromTimezone,
  declineWeatherDrift,
  detectWeatherDrift,
  haversineKm,
  recordWeatherDriftPrompt,
  resolveWeatherLocation,
  seedLocationFromIp,
  setUserWeatherLocation,
} from '@/services/geo/location.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: 'mock', GEOIP_DB_PATH: '' } };
});

let db: Kysely<DB>;
let userId: string;

async function setTz(tz: string | null): Promise<void> {
  await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'sam');
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('cityFromTimezone', () => {
  it('takes the last segment and un-underscores it', () => {
    expect(cityFromTimezone('America/New_York')).toBe('New York');
    expect(cityFromTimezone('Europe/London')).toBe('London');
    expect(cityFromTimezone('Asia/Kolkata')).toBe('Kolkata');
  });

  it('handles three-segment zones', () => {
    expect(cityFromTimezone('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(cityFromTimezone('America/Indiana/Indianapolis')).toBe('Indianapolis');
  });

  it('refuses zones that name no city rather than geocoding nonsense', () => {
    expect(cityFromTimezone('UTC')).toBeNull();
    expect(cityFromTimezone('GMT')).toBeNull();
    expect(cityFromTimezone('Etc/GMT+5')).toBeNull();
    expect(cityFromTimezone(null)).toBeNull();
    expect(cityFromTimezone(undefined)).toBeNull();
  });
});

describe('isPrivateAddress', () => {
  it('rejects loopback, private and link-local ranges', () => {
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.5', '172.16.0.1', '169.254.1.1']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });

  it('rejects carrier-grade NAT — it locates the carrier, not the user', () => {
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    // 100.0.0.1 is ordinary public space, just outside the CGNAT block.
    expect(isPrivateAddress('100.0.0.1')).toBe(false);
  });

  it('accepts ordinary public addresses', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
  });
});

describe('tier precedence', () => {
  it('falls back to the timezone when there is no IP fix', async () => {
    await setTz('America/New_York');
    const loc = await resolveWeatherLocation(db, userId);
    expect(loc?.source).toBe('tz');
    expect(loc?.place).toBe('New York');
  });

  it('returns nothing when the zone names no city and nothing was set', async () => {
    await setTz('UTC');
    expect(await resolveWeatherLocation(db, userId)).toBeNull();
  });

  it("an explicit choice survives a timezone change — that's the point", async () => {
    await setTz('America/New_York');
    await setUserWeatherLocation(db, userId, 'Miami');
    await setTz('Europe/London');
    const loc = await resolveWeatherLocation(db, userId);
    expect(loc?.place).toBe('Miami');
    expect(loc?.source).toBe('user');
  });

  it('an explicit choice is not overwritten by an IP seed', async () => {
    await setUserWeatherLocation(db, userId, 'Miami');
    await seedLocationFromIp(db, userId, '8.8.8.8');
    const loc = await resolveWeatherLocation(db, userId);
    expect(loc?.place).toBe('Miami');
    expect(loc?.source).toBe('user');
  });

  it('a private address contributes nothing, so local dev falls through to tz', async () => {
    await setTz('Europe/London');
    await seedLocationFromIp(db, userId, '127.0.0.1');
    const loc = await resolveWeatherLocation(db, userId);
    expect(loc?.source).toBe('tz');
  });

  it('a missing GeoLite2 database is not an error', async () => {
    await expect(seedLocationFromIp(db, userId, '8.8.8.8')).resolves.toBeUndefined();
  });

  it('caches the timezone fix so it is not re-geocoded every briefing', async () => {
    await setTz('Europe/London');
    await resolveWeatherLocation(db, userId);
    const row = await db
      .selectFrom('users')
      .select(['weather_place', 'weather_place_source', 'weather_lat'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.weather_place).toBe('London');
    expect(row.weather_place_source).toBe('tz');
    expect(row.weather_lat).not.toBeNull();
  });
});

describe('setUserWeatherLocation', () => {
  it('returns null for a place that does not geocode, so the route can 400', async () => {
    expect(await setUserWeatherLocation(db, userId, 'nowhere')).toBeNull();
  });

  it('stores the resolved place, which is what Settings shows back', async () => {
    const loc = await setUserWeatherLocation(db, userId, 'Brooklyn');
    expect(loc).toMatchObject({ place: 'Brooklyn', source: 'user' });
  });
});

describe('haversineKm', () => {
  it('is ~0 for the same point and ~5570km NYC→London', () => {
    const nyc = { lat: 40.7128, lon: -74.006 };
    const london = { lat: 51.5074, lon: -0.1278 };
    expect(haversineKm(nyc, nyc)).toBeCloseTo(0, 5);
    expect(haversineKm(nyc, london)).toBeGreaterThan(5000);
    expect(haversineKm(nyc, london)).toBeLessThan(6000);
  });
});

describe('detectWeatherDrift (ADR 0148)', () => {
  // The mock weather provider geocodes any name to NYC coords, so the
  // timezone tier always "detects" ~NYC. Stored coords set directly.
  const NYC = { lat: 40.7128, lon: -74.006 };
  const LONDON = { lat: 51.5074, lon: -0.1278 };
  const TOKYO = { lat: 35.6762, lon: 139.6503 };

  async function setStored(place: string, at: { lat: number; lon: number }): Promise<void> {
    await db
      .updateTable('users')
      .set({ weather_place: place, weather_lat: at.lat, weather_lon: at.lon })
      .where('id', '=', userId)
      .execute();
  }

  async function setIpStash(
    place: string,
    at: { lat: number; lon: number },
    ageMs = 0,
  ): Promise<void> {
    await db
      .updateTable('users')
      .set({
        weather_ip_place: place,
        weather_ip_lat: at.lat,
        weather_ip_lon: at.lon,
        weather_ip_at: new Date(Date.now() - ageMs).toISOString(),
      })
      .where('id', '=', userId)
      .execute();
  }

  it('no stored location → nothing to ask', async () => {
    await setTz('Europe/London');
    expect(await detectWeatherDrift(db, userId)).toBeNull();
  });

  it('stored location near the fresh fix → no drift', async () => {
    await setTz('America/New_York');
    await setStored('New York', NYC);
    expect(await detectWeatherDrift(db, userId)).toBeNull();
  });

  it('stored location far from the timezone city → drift', async () => {
    await setTz('America/New_York');
    await setStored('London', LONDON);
    const drift = await detectWeatherDrift(db, userId);
    expect(drift?.storedPlace).toBe('London');
    expect(drift?.km).toBeGreaterThan(5000);
  });

  it('a fresh IP stash beats the timezone tier', async () => {
    await setTz('America/New_York'); // tz tier would say ~NYC
    await setStored('New York', NYC);
    await setIpStash('Tokyo', TOKYO); // but the IP says Tokyo
    const drift = await detectWeatherDrift(db, userId);
    expect(drift?.detectedPlace).toBe('Tokyo');
    expect(drift?.km).toBeGreaterThan(9000);
  });

  it('a stale IP stash is ignored and the timezone tier is used', async () => {
    await setTz('America/New_York');
    await setStored('New York', NYC);
    await setIpStash('Tokyo', TOKYO, 10 * 24 * 60 * 60 * 1000); // 10 days old
    expect(await detectWeatherDrift(db, userId)).toBeNull();
  });

  it('does not re-ask right after a prompt about the same place', async () => {
    await setTz('America/New_York');
    await setStored('London', LONDON);
    const first = await detectWeatherDrift(db, userId);
    expect(first).not.toBeNull();
    await recordWeatherDriftPrompt(db, userId, {
      lat: first!.detectedLat,
      lon: first!.detectedLon,
    });
    expect(await detectWeatherDrift(db, userId)).toBeNull();
  });

  it('"keep it" suppresses the same spot but a move elsewhere re-triggers', async () => {
    await setTz('America/New_York');
    await setStored('London', LONDON);
    const first = await detectWeatherDrift(db, userId);
    await recordWeatherDriftPrompt(db, userId, {
      lat: first!.detectedLat,
      lon: first!.detectedLon,
    });
    await declineWeatherDrift(db, userId);
    // Still near the declined spot (tz tier → ~NYC) — stays quiet.
    expect(await detectWeatherDrift(db, userId)).toBeNull();
    // Now the IP says Tokyo — a genuinely new place, so ask again.
    await setIpStash('Tokyo', TOKYO);
    const again = await detectWeatherDrift(db, userId);
    expect(again?.detectedPlace).toBe('Tokyo');
  });
});
