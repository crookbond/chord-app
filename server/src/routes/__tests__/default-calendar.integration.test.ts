/**
 * ADR 0256 — GET/PUT /me/calendar/default, the Settings half of the default
 * calendar. Same writer as the `set_default_calendar` bot tool.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false } };
});

const FAMILY_ID = 'family07746485221481824228@group.calendar.google.com';

describe('default calendar routes', () => {
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
    tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: userId,
        provider: 'google',
        google_calendar_id: FAMILY_ID,
        summary: 'Family',
        access_role: 'owner',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 1,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  const call = (method: string, body?: unknown, token: string | null = tok) =>
    fetch(`${base}${API.meDefaultCalendar}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { [SESSION_HEADER]: token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('401s without a session', async () => {
    expect((await call('GET', undefined, null)).status).toBe(401);
    expect((await call('PUT', { calendarId: FAMILY_ID }, null)).status).toBe(401);
  });

  it('reads the primary when nothing is set', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calendarId: null, label: 'primary' });
  });

  it('sets, reads back and resets the default', async () => {
    const put = await call('PUT', { calendarId: FAMILY_ID });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ calendarId: FAMILY_ID, label: 'Family' });
    expect(await (await call('GET')).json()).toEqual({ calendarId: FAMILY_ID, label: 'Family' });

    const reset = await call('PUT', { calendarId: null });
    expect(await reset.json()).toEqual({ calendarId: null, label: 'primary' });
  });

  it('400s on a calendar that is not one of theirs to write to', async () => {
    const res = await call('PUT', { calendarId: 'someone-else@group.calendar.google.com' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_writable' });
  });

  it('400s on a malformed body', async () => {
    expect((await call('PUT', {})).status).toBe(400);
  });
});
