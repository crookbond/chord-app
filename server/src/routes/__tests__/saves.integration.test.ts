/**
 * GET /me/saves read every save in every group the user is in, unbounded.
 * It now returns a page, newest first, with `?before=` for the next one.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, type Save } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { ME_SAVES_DEFAULT_LIMIT } from '@/routes/saves.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

describe('GET /me/saves', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let tok: string;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'sam');
    tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
    groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  async function addSaves(n: number): Promise<void> {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const rows = Array.from({ length: n }, (_, i) => ({
      id: newId('sv'),
      group_id: groupId,
      kind: 'place' as const,
      title: `Place ${i}`,
      url: null,
      note: null,
      tags: '[]',
      trip_label: null,
      source_raw_context: null,
      created_by: userId,
      created_at: new Date(base + i * 60_000).toISOString(),
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await db.insertInto('saves').values(rows.slice(i, i + 200)).execute();
    }
  }

  const get = async (query = ''): Promise<Save[]> => {
    const res = await fetch(`${base}${API.meSaves}${query}`, { headers: { [SESSION_HEADER]: tok } });
    expect(res.status).toBe(200);
    return (await res.json()) as Save[];
  };

  it('returns at most a page, newest first, and pages with ?before=', async () => {
    await addSaves(ME_SAVES_DEFAULT_LIMIT + 20);
    const first = await get();
    expect(first).toHaveLength(ME_SAVES_DEFAULT_LIMIT);
    expect(first[0]!.title).toBe(`Place ${ME_SAVES_DEFAULT_LIMIT + 19}`);
    const rest = await get(`?before=${encodeURIComponent(first.at(-1)!.createdAt)}`);
    expect(rest).toHaveLength(20);
    expect(rest[0]!.title).toBe('Place 19');
  });

  it('honours a smaller ?limit=', async () => {
    await addSaves(5);
    expect(await get('?limit=2')).toHaveLength(2);
  });
});
