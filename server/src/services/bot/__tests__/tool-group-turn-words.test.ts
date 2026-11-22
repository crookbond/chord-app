/**
 * ADR 0322 addendum — the words that pick a turn's tool groups are the
 * triggering message plus the same user's previous message when it is recent.
 * The bot's own replies are never read: a reply like "Here's your week: the
 * flight to Denver, your dentist appointment, the email from the school..."
 * switched on calendar + trips + email + people for the "yes" that followed.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { turnToolWords } from '@/services/bot/bot.service.js';
import { groupsForText } from '@/services/bot/tool-groups.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const BOT_REPLY =
  "Here's your week: Tuesday your flight to Denver, Wednesday the dentist appointment, " +
  'and the email from the school about the order form is still unread in your inbox. ' +
  "Mom's birthday is Saturday — want me to message the family chat, check your calendar " +
  'colour, or change your morning briefing settings and phone number on WhatsApp?';

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

describe('turnToolWords (ADR 0322 addendum)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function setup(prevBody: string, prevMinutesAgo: number) {
    const uid = await createUser(db);
    const g = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: uid });
    const prev = await insertMessage(db, { groupId: g.id, senderId: uid, body: prevBody });
    await db.updateTable('messages').set({ created_at: minutesAgo(prevMinutesAgo) }).where('id', '=', prev.id).execute();
    const bot = await insertMessage(db, { groupId: g.id, senderId: uid, body: BOT_REPLY });
    await db
      .updateTable('messages')
      .set({ kind: 'bot', sender_id: null, created_at: minutesAgo(prevMinutesAgo - 0.5) })
      .where('id', '=', bot.id)
      .execute();
    const trigger = await insertMessage(db, { groupId: g.id, senderId: uid, body: 'yes' });
    return { uid, g, trigger };
  }

  it('does not read the bot reply full of trigger words', async () => {
    const { g, trigger } = await setup("what's on this week", 2);
    const words = await turnToolWords(db, g.id, trigger);
    expect(words).not.toContain('Denver');
    expect(groupsForText(words)).toEqual(new Set());
  });

  it("keeps the user's recent previous message, so a bare yes keeps its context", async () => {
    const { g, trigger } = await setup('reply to the email from the school', 5);
    const words = await turnToolWords(db, g.id, trigger);
    expect(words).toContain('yes');
    expect(groupsForText(words)).toEqual(new Set(['email']));
  });

  it('drops a previous message older than the follow-up window', async () => {
    const { g, trigger } = await setup('reply to the email from the school', 30);
    const words = await turnToolWords(db, g.id, trigger);
    expect(groupsForText(words)).toEqual(new Set());
  });

  it("does not read another member's message", async () => {
    const uid = await createUser(db);
    const other = await createUser(db);
    const g = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    await insertMessage(db, { groupId: g.id, senderId: other, body: 'book the flight to Denver' });
    const trigger = await insertMessage(db, { groupId: g.id, senderId: uid, body: 'add milk to the list' });
    const words = await turnToolWords(db, g.id, trigger);
    expect(groupsForText(words)).toEqual(new Set());
  });
});
