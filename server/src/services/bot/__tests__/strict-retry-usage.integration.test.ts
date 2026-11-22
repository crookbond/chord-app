/**
 * A turn that runs the strict retry is two full runs of the model. Both are
 * the user's tokens, so both reach token_usage (ADR 0196: recording usage IS
 * the debit). The retry's run used to go unrecorded.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage, LlmStreamOptions } from '@/services/llm/types.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({ script: [] as ScriptedTurn[], streams: 0 }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'usage-mock' as const,
    defaultModel: 'usage-mock',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(_messages: LlmMessage[], opts?: LlmStreamOptions): AsyncIterable<LlmChunk> {
      turns.streams += 1;
      opts?.onUsage?.({ promptTokens: 1000, completionTokens: 10 });
      const turn = turns.script.shift();
      if (turn?.text) yield { type: 'text', delta: turn.text };
      if (turn?.toolCalls) {
        for (const c of turn.toolCalls) yield { type: 'tool_call', call: c };
        yield { type: 'done', reason: 'tool_calls' };
        return;
      }
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

describe('strict retry tokens are recorded', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    turns.streams = 0;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('counts the first run and the retry run of an imperative turn', async () => {
    // First run: prose only, no tool -> the imperative strict retry fires.
    turns.script.push({ text: 'Sure, will do.' });
    // Retry: adds the item, then answers.
    turns.script.push({
      toolCalls: [{ id: 'c1', name: 'add_list_item', args: { listName: 'Costco', items: ['milk'] } }],
    });
    turns.script.push({ text: 'Added milk.' });

    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const msg = await insertMessage(db, { groupId: group.id, senderId: uid, body: '@Chord add milk to the costco list' });
    await runBotTurn(db, msg, { id: group.id, kind: 'group' });

    expect(turns.streams).toBe(3);
    const rows = await db
      .selectFrom('token_usage')
      .select(['prompt_tokens', 'completion_tokens'])
      .where('user_id', '=', uid)
      .where('source', '=', 'bot_turn')
      .execute();
    const prompt = rows.reduce((s, r) => s + r.prompt_tokens, 0);
    const completion = rows.reduce((s, r) => s + r.completion_tokens, 0);
    expect({ prompt, completion }).toEqual({ prompt: 3000, completion: 30 });
  });
});
