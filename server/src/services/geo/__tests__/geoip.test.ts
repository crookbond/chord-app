/**
 * ADR 0091 — reading a city out of a GeoLite2 lookup.
 *
 * GeoLite2 resolves IP -> location, never the reverse: you cannot look up a
 * postal code, you get one back. These tests drive `cityForIp` against
 * responses shaped exactly like the real database returns, because the parsing
 * is MaxMind's library and the part that can actually be wrong is ours — which
 * name we pick, and what we do when a field is missing.
 *
 * The database file itself is not committed (60MB, licensed), so a live check
 * against the real thing is `npm run geoip:check --workspace=server -- <ip>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `cityForIp` is imported per-test via a dynamic import, after the mocks are
// registered — a static import would bind the real module first.
import { resetGeoipForTests } from '@/services/geo/geoip.js';

/** A real GeoLite2-City response shape for an Upper West Side address. */
const UWS = {
  city: { names: { en: 'New York' } },
  subdivisions: [{ names: { en: 'New York' }, iso_code: 'NY' }],
  country: { names: { en: 'United States' }, iso_code: 'US' },
  postal: { code: '10024' },
  location: { latitude: 40.7864, longitude: -73.9754, time_zone: 'America/New_York' },
};

function withDatabase(get: (ip: string) => unknown): void {
  vi.doMock('@/config/env.js', async (orig) => {
    const mod = (await orig()) as { env: Record<string, unknown> };
    return { env: { ...mod.env, GEOIP_DB_PATH: '/fake/GeoLite2-City.mmdb' } };
  });
  // Only `existsSync` is overridden: replacing the whole module breaks the
  // logger, which mkdirSync's its directory at import time.
  vi.doMock('node:fs', async (orig) => {
    const actual = (await orig()) as { default: typeof import('node:fs') };
    return { default: { ...actual.default, existsSync: () => true } };
  });
  vi.doMock('maxmind', () => ({ open: async () => ({ get }) }));
}

beforeEach(() => {
  vi.resetModules();
  resetGeoipForTests();
});

afterEach(() => {
  vi.doUnmock('@/config/env.js');
  vi.doUnmock('node:fs');
  vi.doUnmock('maxmind');
  resetGeoipForTests();
});

describe('cityForIp', () => {
  it('resolves an Upper West Side address to New York with coordinates', async () => {
    withDatabase(() => UWS);
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');

    const hit = await fn('108.31.44.7');
    expect(hit).toEqual({ place: 'New York', lat: 40.7864, lon: -73.9754 });
  });

  it('uses the city, not the 10024 postal code, as the label', async () => {
    // The postal code is in the response and deliberately unused: "New York"
    // is what belongs in a weather line and in Settings, and the forecast is
    // fetched by lat/lon regardless.
    withDatabase(() => UWS);
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');

    const hit = await fn('108.31.44.7');
    expect(hit?.place).toBe('New York');
    expect(JSON.stringify(hit)).not.toContain('10024');
  });

  it('falls back to the subdivision, then the country, when there is no city', async () => {
    withDatabase(() => ({
      subdivisions: [{ names: { en: 'California' } }],
      country: { names: { en: 'United States' } },
      location: { latitude: 37.7, longitude: -122.4 },
    }));
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');
    expect((await fn('8.8.8.8'))?.place).toBe('California');

    resetGeoipForTests();
    vi.resetModules();
    withDatabase(() => ({
      country: { names: { en: 'Switzerland' } },
      location: { latitude: 47.1, longitude: 8.1 },
    }));
    const { cityForIp: fn2 } = await import('@/services/geo/geoip.js');
    expect((await fn2('8.8.8.8'))?.place).toBe('Switzerland');
  });

  it('returns null without coordinates — a name alone cannot fetch a forecast', async () => {
    withDatabase(() => ({ city: { names: { en: 'New York' } } }));
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');
    expect(await fn('108.31.44.7')).toBeNull();
  });

  it('returns null for an address the database does not know', async () => {
    withDatabase(() => null);
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');
    expect(await fn('203.0.113.9')).toBeNull();
  });

  it('never consults the database for a private address', async () => {
    const get = vi.fn(() => UWS);
    withDatabase(get);
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');

    expect(await fn('192.168.1.10')).toBeNull();
    expect(await fn(undefined)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it('survives a lookup that throws rather than failing the request', async () => {
    withDatabase(() => {
      throw new Error('corrupt database');
    });
    const { cityForIp: fn } = await import('@/services/geo/geoip.js');
    expect(await fn('108.31.44.7')).toBeNull();
  });
});
