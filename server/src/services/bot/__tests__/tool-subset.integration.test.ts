/**
 * ADR 0322 — a chat turn is sent the core tools plus the groups its
 * conversation names, loads more with `more_tools`, and still runs a tool it
 * calls by name without having been sent it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { buildToolDefs } from '@/services/bot/tools.js';
import { createGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage, LlmStreamOptions } from '@/services/llm/types.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({
  script: [] as ScriptedTurn[],
  sent: [] as string[][],
  observed: [] as LlmMessage[][],
}));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'subset-mock' as const,
    defaultModel: 'subset-mock',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: LlmMessage[], opts?: LlmStreamOptions): AsyncIterable<LlmChunk> {
      turns.observed.push([...messages]);
      turns.sent.push((opts?.tools ?? []).map((t) => t.name));
      const turn = turns.script.shift();
      if (!turn) {
        yield { type: 'done', reason: 'stop' };
        return;
      }
      if (turn.text) yield { type: 'text', delta: turn.text };
      if (turn.toolCalls) {
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

const subsetFlag = env as { BOT_TOOL_SUBSET: boolean };

describe('tool subset per turn (ADR 0322)', () => {
  let db: Kysely<DB>;
  const prior = subsetFlag.BOT_TOOL_SUBSET;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    turns.sent.length = 0;
    turns.observed.length = 0;
    subsetFlag.BOT_TOOL_SUBSET = true;
  });

  afterEach(async () => {
    subsetFlag.BOT_TOOL_SUBSET = prior;
    await closeTestDb(db);
  });

  async function turn(body: string): Promise<{ groupId: string }> {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const msg = await insertMessage(db, { groupId: group.id, senderId: uid, body });
    await runBotTurn(db, msg, { id: group.id, kind: 'group' });
    return { groupId: group.id };
  }

  it('sends a grocery turn the core tools and more_tools, not the trip or account tools', async () => {
    turns.script.push({ text: 'Added.' });
    await turn('@Chord add milk to the costco list');
    const sent = turns.sent[0]!;
    expect(sent).toContain('add_list_item');
    expect(sent).toContain('more_tools');
    expect(sent).not.toContain('create_trip');
    expect(sent).not.toContain('get_billing_status');
    expect(sent.length).toBeLessThan(buildToolDefs().length / 2);
  });

  it('sends the trip tools when the conversation is about a trip', async () => {
    turns.script.push({ text: 'Sure.' });
    await turn('@Chord we are flying to Denver next month');
    expect(turns.sent[0]).toContain('add_travel_leg');
  });

  it('loads a group the model asks for, from the next round trip on', async () => {
    turns.script.push({ toolCalls: [{ id: 'm1', name: 'more_tools', args: { groups: ['trips'] } }] });
    turns.script.push({ text: 'Loaded.' });
    await turn('@Chord sort out the thing for the 12th');
    expect(turns.sent[0]).not.toContain('create_trip');
    expect(turns.sent[1]).toContain('create_trip');
    const result = turns.observed[1]!.find((m) => m.role === 'tool' && m.toolName === 'more_tools');
    expect(String(result?.content)).toContain('"loaded":["trips"]');
  });

  it('runs a tool the model calls without having been sent it, and sends its group after', async () => {
    turns.script.push({
      toolCalls: [
        {
          id: 't1',
          name: 'create_trip',
          args: { name: 'Trip to Denver', destination: 'Denver', startDate: '2027-03-01', endDate: '2027-03-05' },
        },
      ],
    });
    turns.script.push({ text: 'Created the trip.' });
    const { groupId } = await turn('@Chord sort out the thing for march');
    expect(turns.sent[0]).not.toContain('create_trip');
    const trips = await db.selectFrom('trips').select('name').where('group_id', '=', groupId).execute();
    expect(trips.map((t) => t.name)).toEqual(['Trip to Denver']);
    expect(turns.sent[1]).toContain('add_travel_leg');
  });

  it('sends every tool when BOT_TOOL_SUBSET is off', async () => {
    subsetFlag.BOT_TOOL_SUBSET = false;
    turns.script.push({ text: 'Added.' });
    await turn('@Chord add milk to the costco list');
    expect(turns.sent[0]).toContain('create_trip');
    expect(turns.sent[0]).not.toContain('more_tools');
  });
});
