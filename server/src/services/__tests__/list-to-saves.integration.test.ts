/**
 * ADR 0290 — lists are for ticking off, saves are for keeping, and the bot
 * sees exact counts.
 *
 * The failure (prod, 2026-10-22): "move my entire restaurant list to saves",
 * then "yes", then "that moved two. move all others too". The bot never read
 * the list: it called `save_place` for the names it could see in its prompt
 * snapshot — Khasiyat and Social Hub, then those two again plus Sarvana
 * Bhavan — and stopped. The list was in a shared group, which the personal
 * chat's snapshot did not cover at all, and nothing was ever taken off it.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { SESSION_HEADER, saveKindForListName, saveTagForListName } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { moveListToSaves } from '@/services/list-to-saves.service.js';
import { addItem, createList, getList, setItemChecked } from '@/services/lists.service.js';
import { createSaveWithDedup, listSaves } from '@/services/saves.service.js';
import { newId } from '@/utils/ids.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// The restaurant list from the prod conversation, plus the ones the bot
// never reached.
const RESTAURANTS = [
  'khasiyat @ edison',
  'social hub @ parsipanny',
  'Sarvana Bhavan',
  'Rasika',
  'Veeray',
  'Dosa Grill',
  'Moti Mahal',
  'Junoon',
  'Indian Accent',
  'Adda',
  'Dhamaka',
  'Semma',
];

let db: Kysely<DB>;
let john: string;
let personalId: string;
let familyId: string;
let listId: string;

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John');
  personalId = (await ensurePersonalGroup(db, john)).id;
  familyId = (await createGroup(db, { name: 'Doe Fam', kind: 'group', createdBy: john })).id;
  listId = (await createList(db, { groupId: familyId, name: 'restaurant', createdBy: john })).id;
  for (const r of RESTAURANTS) await addItem(db, listId, r);
});

afterEach(async () => {
  await closeTestDb(db);
});

async function run(groupId: string, name: string, args: Record<string, unknown>) {
  const r = await applyToolCall(db, {
    groupId,
    call: { name, args } as never,
    actorUserId: john,
    provenance: 'test',
    mode: 'commit',
    emit: () => {},
  });
  return r;
}

describe('move_list_to_saves', () => {
  it('moves EVERY item of a shared-group list from the personal chat, and removes the list', async () => {
    const r = await run(personalId, 'move_list_to_saves', { listName: 'restaurant list' });
    const data = r.data as { moved: boolean; newSaves: number; total: number; tag: string };
    expect(data.moved).toBe(true);
    expect(data.total).toBe(RESTAURANTS.length);
    expect(data.tag).toBe('restaurant');

    const saves = await listSaves(db, familyId);
    expect(saves.map((s) => s.title).sort()).toEqual([...RESTAURANTS].sort());
    expect(saves.every((s) => s.kind === 'place' && s.tags.includes('restaurant'))).toBe(true);
    expect(await getList(db, listId)).toBeNull();
    // Saved where the list was, not in the asker's personal group.
    expect(await listSaves(db, personalId)).toHaveLength(0);
  });

  it('does not duplicate a place already saved, but tags it and still empties the list', async () => {
    await createSaveWithDedup(db, {
      groupId: familyId,
      createdBy: john,
      kind: 'place',
      title: 'Sarvana Bhavan',
      tags: ['indian'],
    });
    const r = await run(personalId, 'move_list_to_saves', { listName: 'restaurants' });
    const data = r.data as { newSaves: number; alreadySaved: number };
    expect(data.alreadySaved).toBe(1);
    expect(data.newSaves).toBe(RESTAURANTS.length - 1);
    const saves = await listSaves(db, familyId);
    const sarvana = saves.filter((s) => s.title === 'Sarvana Bhavan');
    expect(sarvana).toHaveLength(1);
    expect(sarvana[0].tags).toEqual(['indian', 'restaurant']);
    expect(await getList(db, listId)).toBeNull();
  });

  it('refuses and moves nothing when the name matches no list', async () => {
    const r = await run(personalId, 'move_list_to_saves', { listName: 'movies' });
    expect((r.data as { moved: boolean; reason: string }).reason).toBe('not_found');
    expect(await getList(db, listId)).not.toBeNull();
    expect(await listSaves(db, familyId)).toHaveLength(0);
  });

  it('asks when the name fits lists in two groups', async () => {
    const other = await createList(db, { groupId: personalId, name: 'Restaurants', createdBy: john });
    await addItem(db, other.id, 'Semma');
    const r = await run(personalId, 'move_list_to_saves', { listName: 'restaurant' });
    const data = r.data as { reason: string; candidates: Array<{ group: string }> };
    expect(data.reason).toBe('ambiguous');
    expect(data.candidates).toHaveLength(2);
    expect(data.candidates.map((c) => c.group)).toContain('Doe Fam');
    expect(await getList(db, listId)).not.toBeNull();
    expect(await getList(db, other.id)).not.toBeNull();

    // The answer names the group; only that list moves.
    const again = await run(personalId, 'move_list_to_saves', {
      listName: 'restaurant',
      groupName: 'doe fam',
    });
    expect((again.data as { moved: boolean }).moved).toBe(true);
    expect(await getList(db, listId)).toBeNull();
    expect(await getList(db, other.id)).not.toBeNull();
  });

  it('a shared group cannot reach a list in the asker’s other groups', async () => {
    const elsewhere = (await createGroup(db, { name: 'Book club', kind: 'group', createdBy: john })).id;
    const r = await run(elsewhere, 'move_list_to_saves', { listName: 'restaurant' });
    expect((r.data as { reason: string }).reason).toBe('not_found');
    expect(await getList(db, listId)).not.toBeNull();
  });
});

describe('moveListToSaves', () => {
  it('keeps ticked items, turns a URL line into a link, and keeps a long line in the note', async () => {
    const list = await createList(db, { groupId: familyId, name: 'Places to eat list', createdBy: john });
    const done = await addItem(db, list.id, 'Been there already');
    await setItemChecked(db, done.item.id, true);
    await addItem(db, list.id, 'https://example.com/best-dosa');
    const long = 'Long description '.repeat(20).trim();
    await addItem(db, list.id, long);

    const r = await moveListToSaves(db, { listId: list.id, actorUserId: john, kind: 'place' });
    expect(r?.tag).toBe('places to eat');
    const saves = await listSaves(db, familyId);
    const link = saves.find((s) => s.url === 'https://example.com/best-dosa');
    expect(link?.kind).toBe('link');
    expect(saves.find((s) => s.title === 'Been there already')).toBeTruthy();
    const longSave = saves.find((s) => s.note === long);
    expect(longSave?.title.length).toBe(200);
  });
});

describe('saving the same thing again adds its tag', () => {
  it('a repeat save_place with a category gains the tag and makes no duplicate', async () => {
    await run(personalId, 'save_place', { name: 'Rasika', tags: ['indian'] });
    await run(personalId, 'save_place', { name: 'rasika', tags: ['date night'] });
    const saves = await listSaves(db, personalId);
    expect(saves).toHaveLength(1);
    expect(saves[0].tags).toEqual(['indian', 'date night']);
  });
});

describe('the bot sees exact counts across the user’s groups', () => {
  async function personalPrompt(): Promise<string> {
    const triggerMessageId = newId('m');
    await db
      .insertInto('messages')
      .values({
        id: triggerMessageId,
        group_id: personalId,
        sender_id: john,
        kind: 'text',
        body: 'how many restaurants do I have?',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 1,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      })
      .execute();
    const messages = await buildLlmContext(db, {
      groupId: personalId,
      isPersonal: true,
      triggerMessageId,
      triggeringUserId: john,
      attachments: [],
      useNativeTools: true,
    });
    return String(messages[0]?.content).split("Group's record")[1]?.split('\n\n')[0] ?? '';
  }

  it('a shared-group list shows in the personal chat with its group and its full count', async () => {
    const snapshot = await personalPrompt();
    // 12 items, of which the snapshot can only name 8 — the count is still 12.
    expect(snapshot).toMatch(/"restaurant" \[Doe Fam\] — 12 open/);
    expect(snapshot).toContain('+4 more');
  });

  it('save counts are exact past the 30 sampled rows, by kind and by tag', async () => {
    await moveListToSaves(db, { listId, actorUserId: john, kind: 'place' });
    for (let i = 0; i < 35; i++) {
      await createSaveWithDedup(db, {
        groupId: personalId,
        createdBy: john,
        kind: 'link',
        title: `article ${i}`,
        url: `https://example.com/a/${i}`,
        tags: [],
      });
    }
    const snapshot = await personalPrompt();
    expect(snapshot).toMatch(/Saves \(47\):/);
    expect(snapshot).toContain('by kind: link 35, place 12');
    expect(snapshot).toContain('by tag: restaurant 12');
  });
});

describe('POST /lists/:id/move-to-saves', () => {
  let server: http.Server;
  let base: string;

  async function mintToken(userId: string): Promise<string> {
    const token = newId('t');
    const now = new Date().toISOString();
    await db
      .insertInto('sessions')
      .values({ token: hashSessionToken(token), user_id: userId, created_at: now, last_seen_at: now })
      .execute();
    return token;
  }

  beforeEach(async () => {
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('a member moves the list; a non-member gets 404 and nothing moves', async () => {
    const stranger = await createUser(db, 'stranger');
    const strangerRes = await fetch(`${base}/api/v1/lists/${listId}/move-to-saves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: await mintToken(stranger) },
      body: '{}',
    });
    expect(strangerRes.status).toBe(404);
    expect(await getList(db, listId)).not.toBeNull();

    const res = await fetch(`${base}/api/v1/lists/${listId}/move-to-saves`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SESSION_HEADER]: await mintToken(john) },
      body: JSON.stringify({ kind: 'place' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { moved: number; tag: string };
    expect(body.moved).toBe(RESTAURANTS.length);
    expect(await getList(db, listId)).toBeNull();
  });
});

describe('list name helpers', () => {
  it('tags a moved list with its name, minus the word "list"', () => {
    expect(saveTagForListName('Restaurant list')).toBe('restaurant');
    expect(saveTagForListName('  Places To Eat ')).toBe('places to eat');
    expect(saveTagForListName('List')).toBe('list');
  });

  it('guesses media for watch/read lists, a place otherwise', () => {
    expect(saveKindForListName('Books to read')).toBe('media');
    expect(saveKindForListName('Movies to watch')).toBe('media');
    expect(saveKindForListName('Articles')).toBe('link');
    expect(saveKindForListName('Restaurants')).toBe('place');
    expect(saveKindForListName('Weekend ideas')).toBe('place');
  });
});
