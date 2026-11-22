/**
 * Calendar disconnect → reconnect safety net:
 *   - pushDirtyEvents must not lose events when the token dies mid-push. It
 *     CLAIMS dirty rows (local_dirty=0) before fetching an access token; if that
 *     fetch fails (dead token), the rows must be un-claimed so a later sync,
 *     after the user reconnects, still drains them.
 *   - maybeNudgeCalendarReconnect warns a connected user once when their token
 *     is dead, skips the healthy / never-connected / already-warned cases.
 * Google is mocked at the fetch seam.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { maybeNudgeCalendarReconnect } from '@/services/proactive.service.js';
import { persistRefreshToken } from '@/services/google/oauth.service.js';
import { pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const CAL_SCOPE = 'https://www.googleapis.com/auth/calendar';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const invalidGrant = () =>
  vi.fn(async () => jsonRes({ error: 'invalid_grant', error_description: 'revoked' }, 400));

let db: Kysely<DB>;
const savedKey = process.env.MASTER_KEY;
const saved = { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };

beforeEach(async () => {
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
  _resetCryptoCacheForTests();
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = 'test-client';
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = 'test-secret';
  db = await openTestDb();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedKey;
  _resetCryptoCacheForTests();
  (env as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = saved.id;
  (env as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = saved.secret;
  await closeTestDb(db);
});

describe('pushDirtyEvents — token dies after claiming', () => {
  it('restores local_dirty so the event still syncs after reconnect', async () => {
    const userId = await createUser(db, 'race');
    await persistRefreshToken(db, userId, 'rt', CAL_SCOPE); // connected + write scope
    const groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;

    const now = new Date().toISOString();
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const eventId = newId('e');
    await db
      .insertInto('events')
      .values({
        id: eventId,
        group_id: groupId,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Made while offline',
        starts_at: future,
        created_at: now,
        updated_at: now,
        created_by: userId,
        status: 'confirmed',
        sequence: 0,
        local_dirty: 1, // pending push to Google
        ical_uid: 'uid-race',
      })
      .execute();

    vi.stubGlobal('fetch', invalidGrant()); // token refresh fails

    await expect(pushDirtyEvents(db, userId)).rejects.toBeTruthy();

    const ev = await db
      .selectFrom('events')
      .select('local_dirty')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow();
    expect(ev.local_dirty).toBe(1); // un-claimed — a later sync will drain it
  });
});

describe('maybeNudgeCalendarReconnect', () => {
  it('warns once when a connected user’s token is dead, then throttles', async () => {
    const userId = await createUser(db, 'dead');
    await ensurePersonalGroup(db, userId);
    await persistRefreshToken(db, userId, 'rt', CAL_SCOPE); // sets google_connected_at
    vi.stubGlobal('fetch', invalidGrant());

    expect(await maybeNudgeCalendarReconnect(db, userId)).toBe(true);

    const msg = await db
      .selectFrom('messages')
      .innerJoin('message_cards', 'message_cards.message_id', 'messages.id')
      .select(['messages.body', 'message_cards.cards_json'])
      .where('messages.kind', '=', 'bot')
      .where('messages.is_proactive', '=', 1)
      .executeTakeFirstOrThrow();
    expect(msg.body).toMatch(/disconnected/i);
    expect(msg.cards_json).toContain('reconnect=calendar');

    const u = await db
      .selectFrom('users')
      .select('calendar_reconnect_nudged_at')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(u.calendar_reconnect_nudged_at).not.toBeNull();

    // Second pass: already warned → no second message.
    expect(await maybeNudgeCalendarReconnect(db, userId)).toBe(false);
    const all = await db
      .selectFrom('messages')
      .select('id')
      .where('is_proactive', '=', 1)
      .execute();
    expect(all.length).toBe(1);
  });

  it('does not warn a healthy connection', async () => {
    const userId = await createUser(db, 'ok');
    await ensurePersonalGroup(db, userId);
    await persistRefreshToken(db, userId, 'rt', CAL_SCOPE);
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes({ access_token: 'at', expires_in: 3600 })));

    expect(await maybeNudgeCalendarReconnect(db, userId)).toBe(false);
  });

  it('does not warn a user who was never connected', async () => {
    const userId = await createUser(db, 'never');
    await ensurePersonalGroup(db, userId);
    // No persistRefreshToken → google_connected_at is null.
    expect(await maybeNudgeCalendarReconnect(db, userId)).toBe(false);
  });
});
