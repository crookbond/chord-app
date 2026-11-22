/**
 * ADR 0085 - the two search surfaces must agree on what "matches".
 *
 * They are separate implementations by necessity (one returns a flat ranked
 * list for the search box, the other a per-category DTO for the bot), so the
 * only thing keeping them honest is the shared rule: a row matches when the
 * query's FTS tokens hit its tsvector OR the raw query appears literally.
 *
 * These tests exist to fail loudly if one path drifts from the other.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { storageCategoryId } from '@/services/email/classification.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { addItem, createList } from '@/services/lists.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { createTask } from '@/services/tasks.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function scenario(): Promise<{ userId: string; personalId: string; groupId: string }> {
  const userId = await createUser(db, 'alice');
  const personal = await ensurePersonalGroup(db, userId);
  const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId });

  await insertMessage(db, {
    groupId: group.id,
    senderId: userId,
    body: 'the plumber is coming Tuesday about the leak',
  });
  await insertMessage(db, {
    groupId: group.id,
    senderId: userId,
    body: 'flight UA512 lands at six',
  });
  await createTask(db, {
    groupId: group.id,
    title: 'Call the plumbers back',
    createdBy: userId,
  });
  await createSaveWithDedup(db, {
    groupId: group.id,
    kind: 'link',
    title: 'Plumbing quotes',
    createdBy: userId,
    tags: [],
  });
  const list = await createList(db, { groupId: group.id, name: 'Repairs', createdBy: userId });
  await addItem(db, list.id, 'book a plumber');

  return { userId, personalId: personal.id, groupId: group.id };
}

/** Ids the bot path matched, per shared type. */
function botIds(r: Awaited<ReturnType<typeof searchEverything>>) {
  return {
    message: new Set(r.messages.map((m) => m.id)),
    task: new Set(r.tasks.concat(r.reminders).map((t) => t.id)),
    save: new Set(r.saves.map((s) => s.id)),
    list: new Set(r.lists.map((l) => l.listId)),
    email: new Set(r.emails.map((e) => e.id)),
  };
}

/** Ids the user-facing path matched, per shared type. */
function iconIds(r: Awaited<ReturnType<typeof searchHits>>) {
  const pick = (t: string) =>
    new Set(r.hits.filter((h) => h.entityType === t).map((h) => h.entityId));
  return {
    message: pick('message'),
    task: pick('task'),
    save: pick('save'),
    list: pick('list'),
    email: pick('email'),
  };
}

async function bothPaths(userId: string, personalId: string, query: string) {
  const bot = await searchEverything(db, {
    userId,
    groupId: personalId,
    crossGroup: true,
    query,
    perCategory: 25,
  });
  const icon = await searchHits(db, {
    userId,
    groupId: personalId,
    crossGroup: true,
    query,
    limit: 50,
  });
  return { bot: botIds(bot), icon: iconIds(icon) };
}

describe('search parity between the bot tool and the search box', () => {
  it('agrees on a stemmed match ("plumbers" finds "plumber")', async () => {
    const { userId, personalId } = await scenario();

    const { bot, icon } = await bothPaths(userId, personalId, 'plumbers');

    // The point of the convergence: stemming used to be FTS-only, so the bot
    // path returned nothing here while the box returned the message.
    expect(bot.message.size).toBeGreaterThan(0);
    expect([...bot.message].sort()).toEqual([...icon.message].sort());
    expect([...bot.task].sort()).toEqual([...icon.task].sort());
  });

  it('agrees on a multi-word query, which literal matching alone would miss', async () => {
    const { userId, personalId } = await scenario();

    const { bot, icon } = await bothPaths(userId, personalId, 'plumber leak');

    expect(bot.message.size).toBeGreaterThan(0);
    expect([...bot.message].sort()).toEqual([...icon.message].sort());
  });

  it('agrees on a short literal code that FTS cannot tokenize', async () => {
    const { userId, personalId } = await scenario();

    // "512" is under the 3-char keyword floor AND is a substring inside the
    // token "ua512", so neither path can find it via FTS - the literal arm is
    // the only thing that works, and both must have it.
    const { bot, icon } = await bothPaths(userId, personalId, '512');

    expect(bot.message.size).toBe(1);
    expect([...bot.message].sort()).toEqual([...icon.message].sort());
  });

  it('agrees across saves and lists too', async () => {
    const { userId, personalId } = await scenario();

    const { bot, icon } = await bothPaths(userId, personalId, 'plumbing');

    expect([...bot.save].sort()).toEqual([...icon.save].sort());
  });

  it('agrees that a nonsense query matches nothing', async () => {
    const { userId, personalId } = await scenario();

    const { bot, icon } = await bothPaths(userId, personalId, 'xylophonecatastrophe');

    expect(bot.message.size).toBe(0);
    expect(icon.message.size).toBe(0);
    expect(bot.task.size).toBe(0);
    expect(icon.task.size).toBe(0);
  });

  it('agrees that a below-floor query matches nothing, on both paths', async () => {
    const { userId, personalId } = await scenario();

    // The literal arm must not become "match everything". A one-character
    // query, or one made only of stopwords, would otherwise make %a% / %the%
    // hit almost every row - this is the regression that adding the literal
    // arm caused, so it is pinned on both paths.
    for (const query of ['a', 'the']) {
      const { bot, icon } = await bothPaths(userId, personalId, query);
      expect(bot.message.size, query).toBe(0);
      expect(icon.message.size, query).toBe(0);
      expect(bot.task.size, query).toBe(0);
      expect(icon.task.size, query).toBe(0);
    }
  });

  it('still returns nothing for an empty query on either path', async () => {
    const { userId, personalId } = await scenario();

    const { bot, icon } = await bothPaths(userId, personalId, '   ');

    expect(bot.message.size).toBe(0);
    expect(icon.message.size).toBe(0);
  });

  it('agrees on a category-name match with no literal text overlap', async () => {
    // Same shared-rule promise as the rest of this file, extended to the
    // classifier-replaces-keyword branch: both surfaces must resolve
    // "school" to the same category subtree, not just the same FTS/literal
    // predicate.
    const { userId, personalId } = await scenario();
    const catId = storageCategoryId(userId, 'mk:school-forms');
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: catId,
        user_id: userId,
        parent_id: null,
        title: 'School forms',
        depth: 0,
        sort_order: 0,
        color: null,
        icon: null,
        gmail_label_id: null,
        updated_at: now,
      })
      .execute();
    const threadId = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        gmail_thread_id: threadId,
        subject: 'Permission slip due Friday',
        snippet: 'please sign and return',
        from_email: 'office@example.org',
        is_archived: 0,
        gmail_label_ids: JSON.stringify(['INBOX']),
        category_id: catId,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const { bot, icon } = await bothPaths(userId, personalId, 'school');

    expect(bot.email.size).toBe(1);
    expect([...bot.email]).toEqual([threadId]);
    expect([...bot.email].sort()).toEqual([...icon.email].sort());
  });
});
