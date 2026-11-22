/**
 * ADR 0155 — a burst of messages in one group must not race its own writes.
 *
 * Prod: three "add to the trader joes list" messages within a few seconds each
 * spawned a fire-and-forget bot turn; every turn's resolve-or-create ran its
 * SELECT before any INSERT committed, so each made its own "Trader Joes" fork
 * and only the first message's item was ever seen.
 *
 * `reactToMessage` now chains a group's turns onto a per-group promise tail,
 * and `resolveOrCreateListByName` holds a transaction-scoped advisory lock —
 * together, a same-group burst lands on ONE list.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { reactToMessage, awaitPendingBotReactions } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import { listLists } from '@/services/lists.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await awaitPendingBotReactions();
  await closeTestDb(db);
});

describe('concurrent bot turns in one group (ADR 0155)', () => {
  it('a same-group message burst lands on one list, not a fork', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    // The mock LLM maps any "add to <list> ... <grocery>" to a Costco
    // add_list_item, so three of these drive three concurrent
    // resolveOrCreateListByName('Costco') calls — the prod race.
    const bodies = [
      '@Chord add to the list - bread',
      '@Chord add to the list - milk',
      '@Chord add to the list - eggs',
    ];

    for (const body of bodies) {
      const msg = await insertMessage(db, { groupId: group.id, senderId: john, body });
      reactToMessage(db, msg, { id: group.id, kind: 'group' });
    }
    await awaitPendingBotReactions();

    const lists = await listLists(db, group.id);
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('Costco');

    const botReplies = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(botReplies).toHaveLength(3);
  });

  it('turns for different groups are not serialised against each other', async () => {
    const john = await createUser(db, 'john', 'John');
    const a = await createGroup(db, { name: 'A', kind: 'group', createdBy: john });
    const b = await createGroup(db, { name: 'B', kind: 'group', createdBy: john });

    for (const g of [a, b]) {
      const msg = await insertMessage(db, {
        groupId: g.id,
        senderId: john,
        body: '@Chord add to the list - bread and milk',
      });
      reactToMessage(db, msg, { id: g.id, kind: 'group' });
    }
    await awaitPendingBotReactions();

    expect(await listLists(db, a.id)).toHaveLength(1);
    expect(await listLists(db, b.id)).toHaveLength(1);
  });
});
