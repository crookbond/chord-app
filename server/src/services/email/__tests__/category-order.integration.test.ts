/**
 * ADR 0266 — the user's own order for the AI view's email categories: set by
 * press-and-drag (PUT /me/email/category-order) or in chat
 * (set_email_category_order), both through `setCategoryOrder`.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API, SESSION_HEADER, applyCategoryOrder, dropIndex, pinToTop, pinnedAfterMove } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { getCategoryOrder, setCategoryOrder } from '@/services/email/category-order.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { hashSessionToken } from '@/utils/session-token.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  // The email routes 404 unless Gmail is enabled; set here, not left to a
  // developer's local .env.
  return { env: { ...mod.env, RATE_LIMIT_ENABLED: false, GMAIL_ENABLED: true } };
});

let db: Kysely<DB>;
let userId: string;

async function addCategory(title: string, parentId: string | null = null): Promise<string> {
  const id = `${userId}:mk:${title.toLowerCase().replace(/\W+/g, '-')}`;
  await db
    .insertInto('email_categories')
    .values({ id, user_id: userId, parent_id: parentId, title, updated_at: new Date().toISOString() })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'orderer');
  const finance = await addCategory('Finance');
  await addCategory('Credit card statements', finance);
  await addCategory('School');
  await addCategory('Travel');
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('setCategoryOrder', () => {
  it('keeps named categories on top, in the user\'s words matched to the real titles', async () => {
    expect(await setCategoryOrder(db, userId, ['finance', ' SCHOOL '], 'top')).toEqual({
      ok: true,
      order: ['Finance', 'School'],
    });
    expect(await getCategoryOrder(db, userId)).toEqual(['Finance', 'School']);
  });

  it('"top" puts new ones first and keeps earlier pins below them', async () => {
    await setCategoryOrder(db, userId, ['Finance', 'School'], 'top');
    expect(await setCategoryOrder(db, userId, ['Travel'], 'top')).toEqual({
      ok: true,
      order: ['Travel', 'Finance', 'School'],
    });
  });

  it('"replace" makes the list the whole order, and empty clears it', async () => {
    await setCategoryOrder(db, userId, ['Finance', 'School'], 'top');
    expect(await setCategoryOrder(db, userId, ['School', 'Travel'], 'replace')).toEqual({
      ok: true,
      order: ['School', 'Travel'],
    });
    expect(await setCategoryOrder(db, userId, [], 'replace')).toEqual({ ok: true, order: [] });
    expect(await getCategoryOrder(db, userId)).toEqual([]);
  });

  it('finds a category at any depth', async () => {
    expect(await setCategoryOrder(db, userId, ['Credit card statements'], 'top')).toEqual({
      ok: true,
      order: ['Credit card statements'],
    });
  });

  it('refuses a name it cannot match, offers close names, and stores nothing', async () => {
    await setCategoryOrder(db, userId, ['Travel'], 'top');
    const out = await setCategoryOrder(db, userId, ['Fin'], 'top');
    expect(out).toMatchObject({ ok: false, reason: 'not_found', name: 'Fin', candidates: ['Finance'] });
    expect(await getCategoryOrder(db, userId)).toEqual(['Travel']);
  });

  it('lets "Unsorted" be placed, since Cards shows it as a group', async () => {
    expect(await setCategoryOrder(db, userId, ['unsorted'], 'top')).toEqual({ ok: true, order: ['Unsorted'] });
  });

  it("never matches another user's categories", async () => {
    const other = await createUser(db, 'someone-else');
    await db
      .insertInto('email_categories')
      .values({ id: `${other}:mk:hobbies`, user_id: other, parent_id: null, title: 'Hobbies', updated_at: new Date().toISOString() })
      .execute();
    expect(await setCategoryOrder(db, userId, ['Hobbies'], 'top')).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('set_email_category_order tool', () => {
  let groupId: string;
  beforeEach(async () => {
    groupId = (await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId })).id;
  });
  const call = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_email_category_order', args },
    });

  it('is personal-chat only', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('set_email_category_order')).toBe(true);
  });

  it('"keep Finance and School on top" saves them first', async () => {
    const out = await call({ categories: ['Finance', 'School'] });
    expect(out.data).toEqual({ ok: true, order: ['Finance', 'School'] });
    expect(await getCategoryOrder(db, userId)).toEqual(['Finance', 'School']);
  });

  it('reads the order and every category when nothing is given', async () => {
    await call({ categories: ['School'] });
    const out = await call({});
    expect(out.data).toMatchObject({ ok: true, read: true, order: ['School'] });
    expect((out.data as { categories: string[] }).categories).toEqual(
      expect.arrayContaining(['Finance', 'School', 'Travel', 'Unsorted']),
    );
  });

  it('clear goes back to the default order', async () => {
    await call({ categories: ['School'] });
    await call({ clear: true });
    expect(await getCategoryOrder(db, userId)).toEqual([]);
  });

  it('reports a name it cannot match instead of saving a guess', async () => {
    const out = await call({ categories: ['Finances and money'] });
    expect(out.data).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await getCategoryOrder(db, userId)).toEqual([]);
  });
});

describe('category order routes', () => {
  let server: http.Server;
  let base: string;
  let tok: string;
  beforeEach(async () => {
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tok = newId('t');
    const now = new Date().toISOString();
    await db.insertInto('sessions').values({ token: hashSessionToken(tok), user_id: userId, created_at: now, last_seen_at: now }).execute();
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const req = (method: string, body?: unknown, token: string | null = tok) =>
    fetch(`${base}${API.meEmailCategoryOrder}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { [SESSION_HEADER]: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('401s without a session', async () => {
    expect((await req('GET', undefined, null)).status).toBe(401);
  });

  it('saves a dragged order and reads it back', async () => {
    const put = await req('PUT', { titles: ['School', 'Finance'] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ titles: ['School', 'Finance'] });
    expect(await (await req('GET')).json()).toEqual({ titles: ['School', 'Finance'] });
  });

  it('400s on a title that is not one of theirs', async () => {
    expect((await req('PUT', { titles: ['Nope'] })).status).toBe(400);
    expect((await req('PUT', {})).status).toBe(400);
  });
});

describe('ordering rules (kernel)', () => {
  const cards = ['Travel', 'Finance', 'Shopping', 'School'];
  it('puts pinned first in pinned order and keeps the rest as they were', () => {
    expect(applyCategoryOrder(cards, (t) => t, ['school', 'Finance'])).toEqual([
      'School',
      'Finance',
      'Travel',
      'Shopping',
    ]);
  });
  it('a pin for a category not on screen changes nothing else', () => {
    expect(applyCategoryOrder(cards, (t) => t, ['Hobbies'])).toEqual(cards);
  });
  it('pinToTop de-duplicates, newest first', () => {
    expect(pinToTop(['Finance', 'School'], ['school', 'Travel'])).toEqual(['school', 'Travel', 'Finance']);
  });
  it('works out where a dragged card lands from how far it moved', () => {
    // Four cards 50 tall with 8 between them.
    const slots = [0, 58, 116, 174].map((y) => ({ y, h: 50 }));
    expect(dropIndex(slots, 3, -120)).toBe(1); // up past two cards
    expect(dropIndex(slots, 0, 70)).toBe(1); // down past one
    expect(dropIndex(slots, 1, 5)).toBe(1); // a nudge stays put
    expect(dropIndex(slots, 2, -1000)).toBe(0); // dragged off the top
    expect(dropIndex(slots, 0, 1000)).toBe(3); // dragged off the bottom
  });

  it('a dragged card pins itself and everything above where it landed', () => {
    // School dragged from the bottom to second place.
    expect(pinnedAfterMove(cards, 3, 1)).toEqual(['Travel', 'School']);
    // Travel dragged from the top down to third place.
    expect(pinnedAfterMove(cards, 0, 2)).toEqual(['Finance', 'Shopping', 'Travel']);
  });
});
