/**
 * ADR 0062 — user-facing FTS search (`searchHits`). Verifies the FTS path over
 * the migration-020 tsvectors: one hit of each entity type, cross-group scope
 * limited to the searcher's memberships, and the visibility rules (bot-only
 * messages excluded, a non-member group's data excluded).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { createGroup } from '@/services/groups.service.js';
import { createList } from '@/services/lists.service.js';
import { postMessage } from '@/services/messages.service.js';
import { createSave } from '@/services/saves.service.js';
import { searchHits } from '@/services/search.service.js';
import { createTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function seedFile(
  db: Kysely<DB>,
  o: { id: string; groupId: string; userId: string; filename: string; text: string },
): Promise<void> {
  await db
    .insertInto('attachments')
    .values({
      id: o.id,
      scope_kind: 'group',
      scope_id: o.groupId,
      uploaded_by: o.userId,
      filename: o.filename,
      mime_type: 'text/plain',
      size: o.text.length,
      path: `x/${o.id}.txt`,
      summary: null,
      extracted_text: o.text,
      image_meta: null,
      pinned: 0,
      indexed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
  await indexAttachmentChunks(db, o.id);
}

describe('searchHits (ADR 0062 FTS)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns one hit of each entity type for a matching term', async () => {
    const john = await createUser(db, 'john');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });

    await postMessage(db, { groupId: family.id, senderId: john, body: 'the plumber is coming Tuesday' });
    await createTask(db, { groupId: family.id, createdBy: john, title: 'call the plumber' });
    const list = await createList(db, { groupId: family.id, name: 'Plumber contacts', createdBy: john });
    await db
      .insertInto('list_items')
      .values({ id: 'li_1', list_id: list.id, text: 'plumber phone number', checked: 0, created_at: new Date().toISOString() })
      .execute();
    await createSave(db, { groupId: family.id, createdBy: john, kind: 'link', title: 'Best plumber website', url: 'https://x', tags: [] });
    await seedFile(db, { id: 'a_1', groupId: family.id, userId: john, filename: 'plumber-invoice.txt', text: 'plumber invoice total due' });

    const out = await searchHits(db, {
      userId: john,
      groupId: family.id,
      crossGroup: false,
      query: 'plumber',
    });

    const types = new Set(out.hits.map((h) => h.entityType));
    expect(types).toContain('message');
    expect(types).toContain('task');
    expect(types).toContain('list');
    expect(types).toContain('save');
    expect(types).toContain('file');
    expect(out.scope).toBe('this-group');
    // Every hit carries the group + an in-app href.
    for (const h of out.hits) {
      expect(h.groupId).toBe(family.id);
      expect(h.href.length).toBeGreaterThan(0);
    }
  });

  it('excludes bot-only (chord_visible=0) messages', async () => {
    const john = await createUser(db, 'john');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await db
      .insertInto('messages')
      .values({
        id: 'm_hidden',
        group_id: family.id,
        sender_id: null,
        kind: 'bot',
        body: 'internal plumber directive',
        chord_visible: 0,
        mentions_bot: 0,
        mentions_others: 0,
        auto_mirror: 0,
        is_proactive: 0,
        created_at: new Date().toISOString(),
      })
      .execute();

    const out = await searchHits(db, { userId: john, groupId: family.id, crossGroup: false, query: 'plumber' });
    expect(out.hits.some((h) => h.entityType === 'message')).toBe(false);
  });

  it('cross-group search spans the user’s groups but not a group they’re not in', async () => {
    const john = await createUser(db, 'john');
    const stranger = await createUser(db, 'stranger');
    const mine = await createGroup(db, { name: 'Mine', kind: 'group', createdBy: john });
    const theirs = await createGroup(db, { name: 'Theirs', kind: 'group', createdBy: stranger });

    await createTask(db, { groupId: mine.id, createdBy: john, title: 'find a plumber' });
    await createTask(db, { groupId: theirs.id, createdBy: stranger, title: 'their plumber task' });

    const out = await searchHits(db, { userId: john, groupId: mine.id, crossGroup: true, query: 'plumber' });
    expect(out.scope).toBe('all-groups');
    const groupIds = new Set(out.hits.map((h) => h.groupId));
    expect(groupIds).toContain(mine.id);
    expect(groupIds).not.toContain(theirs.id);
  });

  it('empty / too-short query returns no hits', async () => {
    const john = await createUser(db, 'john');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await createTask(db, { groupId: family.id, createdBy: john, title: 'the plumber' });
    // "a" cleans to nothing (min 3 chars) → no tsquery → no hits.
    const out = await searchHits(db, { userId: john, groupId: family.id, crossGroup: false, query: 'a' });
    expect(out.hits).toHaveLength(0);
  });
});
