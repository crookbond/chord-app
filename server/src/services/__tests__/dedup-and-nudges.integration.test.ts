/**
 * Covers three follow-ups landed together:
 *
 *   1. List-item dedup — addItem within the same list returns the
 *      existing row instead of inserting a second copy.
 *   2. Save dedup — createSaveWithDedup matches existing rows by URL
 *      (links), title (places/media/contacts), and leaves notes alone.
 *   3. Proactive nudges in buildLlmContext — messages with is_proactive=1
 *      are KEPT in the LLM's history. The bot must see its own nudge when a
 *      user replies to it ("yes, do that"); filtering them out caused the bot
 *      to confabulate context it never had.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB, MessagesTable } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { createGroup } from '@/services/groups.service.js';
import { addItem, createList } from '@/services/lists.service.js';
import { createSaveWithDedup } from '@/services/saves.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

describe('addItem dedup', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns existing item when same text added to the same list', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const list = await createList(db, { groupId: g.id, name: 'Costco', createdBy: uid });

    const first = await addItem(db, list.id, 'milk');
    const second = await addItem(db, list.id, 'milk');
    const third = await addItem(db, list.id, '  Milk ');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.item.id).toBe(first.item.id);
    expect(third.item.id).toBe(first.item.id);
  });

  it('does NOT dedup across different lists in the same group', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const a = await createList(db, { groupId: g.id, name: 'Walmart', createdBy: uid });
    const b = await createList(db, { groupId: g.id, name: 'Errands', createdBy: uid });

    const x = await addItem(db, a.id, 'milk');
    const y = await addItem(db, b.id, 'milk');
    expect(x.created).toBe(true);
    expect(y.created).toBe(true);
    expect(x.item.id).not.toBe(y.item.id);
  });

  it('prefers an unchecked dup over a checked one (re-add un-archives)', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const list = await createList(db, { groupId: g.id, name: 'Costco', createdBy: uid });

    const first = await addItem(db, list.id, 'eggs');
    await db
      .updateTable('list_items')
      .set({ checked: 1 })
      .where('id', '=', first.item.id)
      .execute();
    const again = await addItem(db, list.id, 'eggs');

    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
  });
});

describe('createSaveWithDedup', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('dedups a link by normalized URL (ignores www, trailing slash, utm_*)', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    const a = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'link',
      title: 'NYT recipe',
      url: 'https://www.nytimes.com/recipes/123/',
      tags: [],
    });
    const b = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'link',
      title: 'Recipe again',
      url: 'https://nytimes.com/recipes/123?utm_source=twitter',
      tags: [],
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.save.id).toBe(a.save.id);
  });

  it('dedups a place by normalized title', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    const a = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'place',
      title: 'Joe\'s Pizza',
      tags: [],
    });
    const b = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'place',
      title: "  joe's pizza  ",
      tags: [],
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.save.id).toBe(a.save.id);
  });

  it('does NOT dedup notes (intentionally free-form)', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    const a = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'note',
      title: 'remember to call',
      tags: [],
    });
    const b = await createSaveWithDedup(db, {
      groupId: g.id,
      createdBy: uid,
      kind: 'note',
      title: 'remember to call',
      tags: [],
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.save.id).not.toBe(a.save.id);
  });

  it('scopes dedup to a single group — same URL in another group is a fresh save', async () => {
    const uid = await createUser(db, 'alice');
    const g1 = await createGroup(db, { name: 'G1', kind: 'group', createdBy: uid });
    const g2 = await createGroup(db, { name: 'G2', kind: 'group', createdBy: uid });

    const a = await createSaveWithDedup(db, {
      groupId: g1.id,
      createdBy: uid,
      kind: 'link',
      title: 'site',
      url: 'https://example.com/a',
      tags: [],
    });
    const b = await createSaveWithDedup(db, {
      groupId: g2.id,
      createdBy: uid,
      kind: 'link',
      title: 'site',
      url: 'https://example.com/a',
      tags: [],
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(b.save.id).not.toBe(a.save.id);
  });
});

describe('buildLlmContext keeps proactive nudges', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function insertProactive(db: Kysely<DB>, groupId: string, body: string): Promise<void> {
    const row: MessagesTable = {
      id: newId('m'),
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 1,
    };
    await db.insertInto('messages').values(row).execute();
  }

  it('includes is_proactive=1 messages in the LLM history block', async () => {
    const uid = await createUser(db, 'alice');
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });

    // A real user turn + a proactive nudge. Both belong in the history so a
    // reply to the nudge has the context it refers to.
    const trigger = await insertMessage(db, {
      groupId: g.id,
      senderId: uid,
      body: '@Chord what is up',
      mentionsBot: true,
    });
    await insertProactive(db, g.id, 'PROACTIVE_MORNING_SCAN_NUDGE_BODY');

    const ctx = await buildLlmContext(db, {
      groupId: g.id,
      isPersonal: false,
      triggerMessageId: trigger.id,
      triggeringUserId: uid,
      attachments: [],
      useNativeTools: false,
    });

    const flat = ctx.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    expect(flat).toContain('what is up');
    expect(flat).toContain('PROACTIVE_MORNING_SCAN_NUDGE_BODY');
  });
});
