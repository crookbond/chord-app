/**
 * ADR 0091 — the set_weather_location tool: a voice path to the same explicit
 * weather override that Settings writes via PUT /me/weather-location.
 *
 * - a place that geocodes is stored with source 'user' (which suppresses the
 *   automatic IP/timezone tiers).
 * - an empty string clears the override.
 * - a place that does not geocode returns ok:false and writes nothing, so the
 *   model cannot report success (ADR 0102).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: 'mock', GEOIP_DB_PATH: '' } };
});

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function weatherRow(): Promise<{ place: string | null; source: string | null }> {
  const row = await db
    .selectFrom('users')
    .select(['weather_place', 'weather_place_source'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return { place: row?.weather_place ?? null, source: row?.weather_place_source ?? null };
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john', 'John Doe');
  const g = await createGroup(db, { name: 'John', kind: 'personal', createdBy: userId });
  groupId = g.id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('set_weather_location tool', () => {
  it('stores a geocoded place as an explicit (user) choice', async () => {
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_weather_location', args: { place: 'Madrid' } },
    });

    expect(res.data).toMatchObject({ ok: true, place: 'Madrid', source: 'user' });
    expect(await weatherRow()).toEqual({ place: 'Madrid', source: 'user' });
  });

  it('an empty string clears the override', async () => {
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_weather_location', args: { place: 'Madrid' } },
    });

    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_weather_location', args: { place: '  ' } },
    });

    expect(res.data).toMatchObject({ ok: true, place: null });
    expect(await weatherRow()).toEqual({ place: null, source: null });
  });

  it('keepCurrent:true dismisses the drift prompt without touching the place', async () => {
    // Stand in for a live drift question having been asked.
    await db
      .updateTable('users')
      .set({
        weather_place: 'Seville',
        weather_place_source: 'user',
        weather_lat: 37.38,
        weather_lon: -5.97,
        weather_prompt_lat: 40.42,
        weather_prompt_lon: -3.7,
        weather_prompt_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();

    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_weather_location', args: { keepCurrent: true } },
    });

    expect(res.data).toMatchObject({ ok: true, kept: true });
    expect(await weatherRow()).toEqual({ place: 'Seville', source: 'user' });
    const row = await db
      .selectFrom('users')
      .select(['weather_prompt_declined'])
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(Number(row?.weather_prompt_declined)).toBe(1);
  });

  it('a place that does not geocode returns ok:false and writes nothing', async () => {
    // The mock weather provider returns null for "nowhere".
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_weather_location', args: { place: 'nowhere' } },
    });

    expect(res.data).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await weatherRow()).toEqual({ place: null, source: null });
  });
});
