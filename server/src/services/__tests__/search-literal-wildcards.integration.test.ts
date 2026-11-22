/**
 * `%`, `_` and `\` typed into a search must match themselves on both surfaces.
 *
 * The search box wrote its literal arm as ESCAPE '\' inside a Kysely `sql`
 * template, where the template literal cooks `\'` to a bare quote. Postgres
 * therefore saw ESCAPE '' (no escape character), so the backslashes that
 * `qLike` puts in front of `%` and `_` were matched as literal backslashes and
 * nothing containing those characters was found. The bot tool, which uses
 * Kysely's `ilike` and the default escape, was unaffected, which is how the two
 * surfaces came to disagree (ADR 0085).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addItem, createList } from '@/services/lists.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { createTask } from '@/services/tasks.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let personalId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'alice');
  personalId = (await ensurePersonalGroup(db, userId)).id;
  groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

/** Titles the box returned, and the bot's hits flattened to titles/text. */
async function both(query: string): Promise<{ box: string[]; bot: string[] }> {
  const box = await searchHits(db, {
    userId,
    groupId: personalId,
    crossGroup: true,
    query,
    limit: 50,
  });
  const bot = await searchEverything(db, {
    userId,
    groupId: personalId,
    crossGroup: true,
    query,
    perCategory: 25,
  });
  return {
    box: box.hits.map((h) => h.title).sort(),
    bot: [
      ...bot.messages.map((m) => m.snippet),
      ...bot.tasks.map((t) => t.title),
      ...bot.reminders.map((t) => t.title),
      ...bot.saves.map((s) => s.title),
      ...bot.lists.map((l) => l.listName),
    ].sort(),
  };
}

describe('a literal % on the search box and the bot tool', () => {
  it('finds a chat message containing it, and not one that only looks similar', async () => {
    await insertMessage(db, { groupId, senderId: userId, body: 'coupon gives 50% off the lot' });
    await insertMessage(db, { groupId, senderId: userId, body: 'coupon gives 5000 off the lot' });

    const r = await both('50%');
    expect(r.box).toHaveLength(1);
    expect(r.bot).toHaveLength(1);
  });

  it('finds a task title containing it', async () => {
    await createTask(db, { groupId, title: 'Use the 50% coupon', createdBy: userId });
    await createTask(db, { groupId, title: 'Use the 5000 coupon', createdBy: userId });

    const r = await both('50%');
    expect(r.box).toEqual(['Use the 50% coupon']);
    expect(r.bot).toEqual(['Use the 50% coupon']);
  });

  it('finds a saved item containing it', async () => {
    await createSaveWithDedup(db, {
      groupId,
      kind: 'link',
      title: 'Sale 50% off shoes',
      createdBy: userId,
      tags: [],
    });
    await createSaveWithDedup(db, {
      groupId,
      kind: 'link',
      title: 'Sale 5000 off shoes',
      createdBy: userId,
      tags: [],
    });

    const r = await both('50%');
    expect(r.box).toEqual(['Sale 50% off shoes']);
    expect(r.bot).toEqual(['Sale 50% off shoes']);
  });

  it('finds a list whose item contains it', async () => {
    const list = await createList(db, { groupId, name: 'Shopping', createdBy: userId });
    await addItem(db, list.id, 'anything 50% off');

    const r = await both('50%');
    expect(r.box.length).toBeGreaterThan(0);
    expect(r.bot).toEqual(['Shopping']);
  });
});

describe('a literal _ on the search box and the bot tool', () => {
  it('does not act as a single-character wildcard', async () => {
    // "a_b" has no 3-character token, so full-text search contributes nothing
    // and only the literal arm decides. (A longer query such as snake_case
    // would also match snakeXcase through FTS prefix matching, legitimately.)
    await createTask(db, { groupId, title: 'Rename a_b files', createdBy: userId });
    await createTask(db, { groupId, title: 'Rename axb files', createdBy: userId });

    const r = await both('a_b');
    expect(r.box).toEqual(['Rename a_b files']);
    expect(r.bot).toEqual(['Rename a_b files']);
  });

  it('a lone percent sign does not match every row', async () => {
    await createTask(db, { groupId, title: 'Call the plumber', createdBy: userId });
    await createTask(db, { groupId, title: 'Book the dentist', createdBy: userId });

    const r = await both('%%%');
    expect(r.box).toEqual([]);
    expect(r.bot).toEqual([]);
  });
});

describe('a backslash in the query', () => {
  it('is matched literally and does not throw', async () => {
    await createTask(db, { groupId, title: 'Copy C:\\temp\\report to the share', createdBy: userId });

    const r = await both('C:\\temp');
    expect(r.box).toEqual(['Copy C:\\temp\\report to the share']);
    expect(r.bot).toEqual(['Copy C:\\temp\\report to the share']);
  });
});
