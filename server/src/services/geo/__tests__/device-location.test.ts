/**
 * ADR 0258 - the app asks for the phone's location and, when the user allows
 * it, uses it. Below it the IP and time-zone tiers stay as the fallback; above
 * it an explicit Settings choice still wins, because that has to survive travel.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import {
  applyDeviceLocation,
  clearDeviceLocation,
  detectWeatherDrift,
  resolveWeatherLocation,
  seedLocationFromIp,
  setUserWeatherLocation,
} from '@/services/geo/location.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: 'mock', GEOIP_DB_PATH: '' } };
});

// An IP lookup that always finds Tokyo, so we can see what it does NOT overwrite.
vi.mock('@/services/geo/geoip.js', async (orig) => ({
  ...(await orig<typeof import('@/services/geo/geoip.js')>()),
  cityForIp: vi.fn(async () => ({ place: 'Tokyo', lat: 35.6762, lon: 139.6503 })),
}));

const NYC = { lat: 40.7128, lon: -74.006 };
const TOKYO = { lat: 35.6762, lon: 139.6503 };

let db: Kysely<DB>;
let userId: string;

const row = () =>
  db
    .selectFrom('users')
    .select([
      'weather_place',
      'weather_lat',
      'weather_lon',
      'weather_place_source',
      'weather_device_place',
      'weather_device_lat',
      'weather_device_at',
    ])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
const setTz = (tz: string) =>
  db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'sam');
});
afterEach(async () => closeTestDb(db));

describe('applyDeviceLocation', () => {
  it("becomes the weather location, kept to about a kilometre, under the phone's own name", async () => {
    const out = await applyDeviceLocation(db, userId, { lat: 41.38791234, lon: 2.16992345, place: 'Barcelona' });
    expect(out.applied).toBe(true);
    expect(out.location).toEqual({ place: 'Barcelona', lat: 41.39, lon: 2.17, source: 'device' });
    expect(await row()).toMatchObject({
      weather_place: 'Barcelona',
      weather_lat: 41.39,
      weather_lon: 2.17,
      weather_place_source: 'device',
    });
  });

  it('names a fix that arrived without a name by the time-zone city when that is near, else plainly', async () => {
    await setTz('America/New_York');
    expect((await applyDeviceLocation(db, userId, { lat: 40.73, lon: -73.99 })).location?.place).toBe('New York');
    // Far from the zone's city: a browser in Tokyo on a New York clock is not "New York".
    expect((await applyDeviceLocation(db, userId, TOKYO)).location?.place).toBe('Your location');
  });

  it('beats a location the IP or time zone chose', async () => {
    await setTz('Europe/London');
    await resolveWeatherLocation(db, userId); // tz tier fills in
    expect((await row()).weather_place_source).toBe('tz');
    await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    expect(await row()).toMatchObject({ weather_place: 'Tokyo', weather_place_source: 'device' });
  });

  it('follows the phone when it moves, but leaves a fix that has not moved alone', async () => {
    await applyDeviceLocation(db, userId, { ...NYC, place: 'New York' });
    const same = await applyDeviceLocation(db, userId, { lat: 40.72, lon: -74.0, place: 'New York' });
    expect(same.applied).toBe(false);
    const moved = await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    expect(moved.applied).toBe(true);
    expect((await row()).weather_place).toBe('Tokyo');
  });

  it("never overwrites an explicit choice - that has to survive travel - but remembers the fix", async () => {
    await setUserWeatherLocation(db, userId, 'Miami');
    const out = await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    expect(out.applied).toBe(false);
    expect(out.location).toMatchObject({ place: 'Miami', source: 'user' });
    expect(await row()).toMatchObject({
      weather_place: 'Miami',
      weather_place_source: 'user',
      weather_device_place: 'Tokyo',
    });
  });

  it('refuses coordinates that are not on Earth', async () => {
    expect((await applyDeviceLocation(db, userId, { lat: 95, lon: 0 })).location).toBeNull();
    expect((await applyDeviceLocation(db, userId, { lat: Number.NaN, lon: 0 })).location).toBeNull();
    expect((await row()).weather_place).toBeNull();
  });
});

describe('the fallback tiers around it', () => {
  it('an IP lookup does not overwrite the phone', async () => {
    await applyDeviceLocation(db, userId, { ...NYC, place: 'New York' });
    await seedLocationFromIp(db, userId, '8.8.8.8'); // would say Tokyo
    expect((await row()).weather_place).toBe('New York');
  });

  it('the IP still seeds a location for someone who never allowed the phone', async () => {
    await seedLocationFromIp(db, userId, '8.8.8.8');
    expect(await row()).toMatchObject({ weather_place: 'Tokyo', weather_place_source: 'ip' });
  });

  it('turning location off hands the weather back to the fallback tiers', async () => {
    await applyDeviceLocation(db, userId, { ...NYC, place: 'New York' });
    await clearDeviceLocation(db, userId);
    expect(await row()).toMatchObject({ weather_place: null, weather_device_place: null });
    // ...and the IP tier can seed again.
    await seedLocationFromIp(db, userId, '8.8.8.8');
    expect((await row()).weather_place_source).toBe('ip');
  });

  it('turning it off leaves an explicit choice in place', async () => {
    await setUserWeatherLocation(db, userId, 'Miami');
    await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    await clearDeviceLocation(db, userId);
    expect(await row()).toMatchObject({ weather_place: 'Miami', weather_device_place: null });
  });
});

describe('"you seem to have moved" (ADR 0148) uses the phone first', () => {
  it('asks about an explicit location the phone now disagrees with', async () => {
    await setTz('America/New_York'); // the tz tier alone would say ~NYC
    await setUserWeatherLocation(db, userId, 'Miami');
    await db
      .updateTable('users')
      .set({ weather_lat: 25.76, weather_lon: -80.19 })
      .where('id', '=', userId)
      .execute();
    await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    const drift = await detectWeatherDrift(db, userId);
    expect(drift).toMatchObject({ storedPlace: 'Miami', detectedPlace: 'Tokyo' });
  });

  it('ignores a phone fix that is days old', async () => {
    await setTz('America/New_York');
    await setUserWeatherLocation(db, userId, 'Brooklyn');
    await applyDeviceLocation(db, userId, { ...TOKYO, place: 'Tokyo' });
    await db
      .updateTable('users')
      .set({ weather_device_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() })
      .where('id', '=', userId)
      .execute();
    expect(await detectWeatherDrift(db, userId)).toBeNull();
  });
});
