/**
 * Bot error-handling tests.
 *
 * When the LLM provider is down or returns an error, the bot must:
 *   - NOT expose the raw provider error to the user
 *   - Post a friendly "service temporarily unavailable" message so the user
 *     knows to retry rather than being left with no response
 *   - Log the error server-side at error level
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

// Mock the LLM factory so this file's tests are independent of provider config
// and always exercise the error path.
vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'failing-mock',
    defaultModel: 'failing-mock',
    supportsNativeTools: false,
    complete: async () => { throw new Error('400 Provider returned error'); },
    // eslint-disable-next-line require-yield
    async *stream() { throw new Error('400 Provider returned error'); },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('bot error handling', () => {
  it('LLM provider error → bot posts friendly retry message, not the raw error', async () => {
    const userId = newId('u');
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'errortest',
        display_name: 'Error Test',
        created_at: new Date().toISOString(),
        shadow: 0,
      })
      .execute();

    const group = await createGroup(db, { name: 'Error Test Group', kind: 'group', createdBy: userId });

    const triggerMsgId = newId('m');
    await db.insertInto('messages').values({
      id: triggerMsgId,
      group_id: group.id,
      sender_id: userId,
      kind: 'text',
      body: '@Chord what is the weather like?',
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
    }).execute();

    const triggerMsg = {
      id: triggerMsgId,
      groupId: group.id,
      senderId: userId,
      kind: 'text' as const,
      body: '@Chord what is the weather like?',
      mentionsBot: true,
      createdAt: new Date().toISOString(),
    };

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .execute();

    expect(botMessages.length, 'hint: bot should post a message even when LLM fails').toBe(1);

    const body = botMessages[0]!.body;
    expect(body, 'hint: user-facing message should not expose raw provider error').not.toContain('400');
    expect(body, 'hint: user-facing message should not expose raw provider error').not.toContain('Provider returned error');
    expect(body, 'hint: user should be told to try again').toMatch(/try again|unavailable|service/i);
  });

  it('LLM error does not create any proposals or resources', async () => {
    const userId = newId('u');
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'errortest2',
        display_name: 'Error Test 2',
        created_at: new Date().toISOString(),
        shadow: 0,
      })
      .execute();

    const group = await createGroup(db, { name: 'Error Test Group 2', kind: 'group', createdBy: userId });

    const triggerMsgId = newId('m');
    await db.insertInto('messages').values({
      id: triggerMsgId,
      group_id: group.id,
      sender_id: userId,
      kind: 'text',
      body: '@Chord add milk to Costco list',
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
    }).execute();

    const triggerMsg = {
      id: triggerMsgId,
      groupId: group.id,
      senderId: userId,
      kind: 'text' as const,
      body: '@Chord add milk to Costco list',
      mentionsBot: true,
      createdAt: new Date().toISOString(),
    };

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    const lists = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();

    expect(lists.length, 'hint: no lists should be created when LLM fails').toBe(0);
  });
});
