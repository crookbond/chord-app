/**
 * ADR 0044 — BYOK key-failure messaging.
 *
 * When a turn runs on the user's own BYOK key and the key is rejected
 * (401) or out of credits, the bot must tell the user to fix/top up their
 * key (so they can self-serve) instead of the generic "temporarily
 * unavailable" outage message — and must NOT fall back to the system key.
 *
 * A non-BYOK user hitting the same error keeps the generic message (covered
 * by bot-error.integration.test.ts).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

// Mock the LLM factory so the turn always fails with an auth (401) error,
// as a revoked/invalid BYOK key would.
vi.mock('@/services/llm/factory.js', () => {
  const authError = () =>
    Object.assign(new Error('401 Incorrect API key provided'), {
      status: 401,
      code: 'invalid_api_key',
    });
  const llm = {
    providerName: 'openai',
    defaultModel: 'gpt-test',
    supportsNativeTools: false,
    complete: async () => { throw authError(); },
    // eslint-disable-next-line require-yield
    async *stream() { throw authError(); },
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

describe('BYOK key failure messaging', () => {
  it('user with a stored key → bot tells them to fix the key, not "unavailable"', async () => {
    const userId = newId('u');
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'byokuser',
        display_name: 'BYOK User',
        created_at: new Date().toISOString(),
        shadow: 0,
        // Presence of these two is what marks the turn as BYOK.
        model_provider: 'openai',
        model_name: 'gpt-test',
        model_key_ciphertext: Buffer.from('sealed'),
        model_key_iv: Buffer.from('iv'),
        model_key_tag: Buffer.from('tag'),
      })
      .execute();

    const group = await createGroup(db, { name: 'BYOK Group', kind: 'group', createdBy: userId });

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

    await runBotTurn(
      db,
      {
        id: triggerMsgId,
        groupId: group.id,
        senderId: userId,
        kind: 'text' as const,
        body: '@Chord what is the weather like?',
        mentionsBot: true,
        createdAt: new Date().toISOString(),
      },
      { id: group.id, kind: 'group' },
    );

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .execute();

    expect(botMessages.length).toBe(1);
    const body = botMessages[0]!.body;
    expect(body, 'hint: should not leak the raw provider error').not.toContain('401');
    expect(body, 'hint: BYOK auth failure should point at the key, not an outage').toMatch(/key|Settings/i);
    expect(body, 'hint: should not claim it is our outage').not.toMatch(/temporarily unavailable/i);
  });
});
