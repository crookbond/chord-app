/**
 * ADR 0091 — the two Settings writes behind the briefing.
 *
 * Both matter for reasons the service tests don't cover: the weather route has
 * to 400 rather than silently keep the old location when a place doesn't
 * geocode, and the channel route has to be membership-gated — it addresses a
 * binding by an opaque key, so an un-scoped lookup would let anyone mute
 * anyone's briefing.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { listBriefingChannels } from '@/services/connectors/briefing-channels.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return {
    env: { ...mod.env, WEATHER_PROVIDER: 'mock', GEOIP_DB_PATH: '', RATE_LIMIT_ENABLED: false },
  };
});

async function mintToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = newId('t');
  const now = new Date().toISOString();
  await db
    .insertInto('sessions')
    .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
    .execute();
  return token;
}

describe('briefing settings routes', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'sam');
    tok = await mintToken(db, userId);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  function put(path: string, body: unknown, token = tok): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: token },
      body: JSON.stringify(body),
    });
  }

  describe('PUT /me/weather-location', () => {
    it('401s without a session', async () => {
      const res = await fetch(`${base}${API.meWeatherLocation}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ place: 'Brooklyn' }),
      });
      expect(res.status).toBe(401);
    });

    it('stores the resolved place and reports it back', async () => {
      const res = await put(API.meWeatherLocation, { place: 'Brooklyn' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ place: 'Brooklyn', source: 'user' });
    });

    it('400s on a place that does not geocode instead of silently keeping the old one', async () => {
      await put(API.meWeatherLocation, { place: 'Brooklyn' });
      const res = await put(API.meWeatherLocation, { place: 'nowhere' });
      expect(res.status).toBe(400);
      const row = await db
        .selectFrom('users')
        .select('weather_place')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row.weather_place).toBe('Brooklyn');
    });

    it('an empty place clears the override back to automatic', async () => {
      await put(API.meWeatherLocation, { place: 'Brooklyn' });
      const res = await put(API.meWeatherLocation, { place: '' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ place: null, source: null });
    });

    it('surfaces the resolved place in GET /me/settings', async () => {
      await put(API.meWeatherLocation, { place: 'Brooklyn' });
      const res = await fetch(`${base}${API.meSettings}`, {
        headers: { [SESSION_HEADER]: tok },
      });
      const body = (await res.json()) as { weatherPlace: string; weatherPlaceSource: string };
      expect(body.weatherPlace).toBe('Brooklyn');
      expect(body.weatherPlaceSource).toBe('user');
    });
  });

  describe('PUT/DELETE /me/location (ADR 0258)', () => {
    const del = (token = tok) =>
      fetch(`${base}${API.meLocation}`, { method: 'DELETE', headers: { [SESSION_HEADER]: token } });

    it('401s without a session', async () => {
      const res = await fetch(`${base}${API.meLocation}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lat: 1, lon: 1 }),
      });
      expect(res.status).toBe(401);
    });

    it('400s on coordinates that are not on Earth', async () => {
      expect((await put(API.meLocation, { lat: 95, lon: 0 })).status).toBe(400);
      expect((await put(API.meLocation, { lat: 0, lon: 190 })).status).toBe(400);
      expect((await put(API.meLocation, { lat: 'north', lon: 0 })).status).toBe(400);
    });

    it("takes the phone's fix as the weather location and shows it in /me/settings", async () => {
      const res = await put(API.meLocation, { lat: 41.3879, lon: 2.1699, place: 'Barcelona' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, applied: true, place: 'Barcelona', source: 'device' });
      const settings = (await (
        await fetch(`${base}${API.meSettings}`, { headers: { [SESSION_HEADER]: tok } })
      ).json()) as { weatherPlace: string; weatherPlaceSource: string };
      expect(settings).toMatchObject({ weatherPlace: 'Barcelona', weatherPlaceSource: 'device' });
    });

    it('leaves an explicit Settings choice alone', async () => {
      await put(API.meWeatherLocation, { place: 'Brooklyn' });
      const res = await put(API.meLocation, { lat: 35.6762, lon: 139.6503, place: 'Tokyo' });
      expect(await res.json()).toMatchObject({ applied: false, place: 'Brooklyn', source: 'user' });
    });

    it('DELETE forgets the fix and hands the weather back to the automatic tiers', async () => {
      await put(API.meLocation, { lat: 41.3879, lon: 2.1699, place: 'Barcelona' });
      expect((await del()).status).toBe(200);
      const row = await db
        .selectFrom('users')
        .select(['weather_place', 'weather_device_place'])
        .where('id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ weather_place: null, weather_device_place: null });
    });
  });

  describe('PUT /me/briefing-channels/:id', () => {
    async function bindFor(uid: string): Promise<string> {
      const groupId = (await ensurePersonalGroup(db, uid)).id;
      await bindChannel(db, 'whatsapp', `whatsapp:+1347555${uid.slice(-4)}`, groupId, 'whatsapp');
      const [chan] = await listBriefingChannels(db, uid);
      return chan.id;
    }

    it('mutes and un-mutes the caller own channel', async () => {
      const id = await bindFor(userId);
      expect((await put(API.meBriefingChannel(id), { optedOut: true })).status).toBe(200);
      expect((await listBriefingChannels(db, userId))[0].optedOut).toBe(true);
      expect((await put(API.meBriefingChannel(id), { optedOut: false })).status).toBe(200);
      expect((await listBriefingChannels(db, userId))[0].optedOut).toBe(false);
    });

    it("404s on someone else's channel rather than muting it", async () => {
      const otherId = await createUser(db, 'mallory');
      const theirChannel = await bindFor(otherId);
      const res = await put(API.meBriefingChannel(theirChannel), { optedOut: true });
      expect(res.status).toBe(404);
      expect((await listBriefingChannels(db, otherId))[0].optedOut).toBe(false);
    });

    it('404s on a malformed id rather than throwing', async () => {
      const res = await put(API.meBriefingChannel('not-a-real-id'), { optedOut: true });
      expect(res.status).toBe(404);
    });

    it('400s when optedOut is missing', async () => {
      const id = await bindFor(userId);
      expect((await put(API.meBriefingChannel(id), {})).status).toBe(400);
    });
  });
});
