/**
 * A chat reply is the text of each round of the tool loop. It used to be
 * every round pasted together with no space, so a reply read "Let me check
 * your calendar.You're free Tuesday" — narration the model wrote before it had
 * the result, glued to the answer.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { runSideChatTurn, type SideTool } from '@/services/bot/bot.service.js';
import { isLookupTool } from '@/services/bot/tools.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import type { LlmService } from '@/services/llm/types.js';

type Round = { text: string; call?: { name: string; args: unknown } };

function scriptedLlm(rounds: Round[]): LlmService {
  let i = 0;
  return {
    providerName: 'scripted',
    defaultModel: 'scripted',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream() {
      const r = rounds[Math.min(i++, rounds.length - 1)];
      if (r.text) yield { type: 'text' as const, delta: r.text };
      if (r.call) yield { type: 'tool_call' as const, call: { id: `c${i}`, ...r.call } };
      yield { type: 'done' as const };
    },
  } as unknown as LlmService;
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const findEvents = { name: 'find_events', args: { startDate: tomorrow, endDate: tomorrow } };

describe('chat reply across tool rounds', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ada');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function reply(rounds: Round[], tools: string[]): Promise<string> {
    const out = await runSideChatTurn(db, scriptedLlm(rounds), [{ role: 'user', content: 'hi' }], {
      groupId,
      userId,
      tz: 'America/New_York',
      onlyTools: new Set(tools),
    });
    return out.body;
  }

  it('leaves out what the model wrote before a lookup', async () => {
    const body = await reply(
      [
        { text: 'Let me check your calendar.', call: findEvents },
        { text: "You're free tomorrow." },
      ],
      ['find_events'],
    );
    expect(body).toBe("You're free tomorrow.");
  });

  it('keeps text beside a card the reply presents, apart from the next round', async () => {
    const body = await reply(
      [
        {
          text: "I can't draw pictures, but here's an image search for a boy running.",
          call: {
            name: 'suggest_external_action',
            args: { kind: 'search', label: 'Search images', query: { q: 'boy running', searchType: 'images' } },
          },
        },
        { text: 'Anything else?' },
      ],
      ['suggest_external_action'],
    );
    expect(body).toBe("I can't draw pictures, but here's an image search for a boy running.\n\nAnything else?");
  });

  it('keeps the narration rather than sending nothing', async () => {
    const body = await reply([{ text: 'Let me check your calendar.', call: findEvents }, { text: '' }], ['find_events']);
    expect(body).toBe('Let me check your calendar.');
  });

  // Audit 2026-11-01: a side tool (the Findings hand-off) that threw ended the
  // whole side-chat turn, losing the answer; it now answers the model with the
  // fixed ADR 0102 failure sentence and the turn goes on.
  it('answers a throwing side tool with the fixed failure sentence, on both paths', async () => {
    const boom: SideTool = {
      def: { name: 'boom_tool', description: 'x', parameters: { type: 'object', properties: {} } },
      run: async () => {
        throw new Error('duplicate key value violates unique constraint "secret_idx"');
      },
    };
    const sideTools = new Map([['boom_tool', boom]]);
    const seen: string[] = [];
    const inner = scriptedLlm([{ text: '', call: { name: 'boom_tool', args: {} } }, { text: 'That did not go through.' }]);
    const native = {
      ...inner,
      stream(messages: Array<{ role: string }>, opts: unknown) {
        seen.push(JSON.stringify(messages.filter((m) => m.role === 'tool')));
        return inner.stream(messages as never, opts as never);
      },
    } as unknown as LlmService;
    const out = await runSideChatTurn(db, native, [{ role: 'user', content: 'hi' }], {
      groupId,
      userId,
      tz: 'America/New_York',
      onlyTools: new Set(),
      sideTools,
    });
    expect(out.body).toBe('That did not go through.');
    expect(seen[1]).toContain('NOTHING was written');
    expect(seen[1]).not.toContain('secret_idx');

    const fence = '```chord-tool\n' + JSON.stringify({ name: 'boom_tool', args: {} }) + '\n```';
    const textOnly = { ...scriptedLlm([{ text: `Here you go.\n${fence}` }]), supportsNativeTools: false } as LlmService;
    const fenced = await runSideChatTurn(db, textOnly, [{ role: 'user', content: 'hi' }], {
      groupId,
      userId,
      tz: 'America/New_York',
      onlyTools: new Set(),
      sideTools,
    });
    expect(fenced.body.trim()).toBe('Here you go.');
  });

  it('counts only tools that find something out as lookups', () => {
    expect(isLookupTool('find_events')).toBe(true);
    expect(isLookupTool('read_email')).toBe(true);
    expect(isLookupTool('add_list_item')).toBe(false);
    expect(isLookupTool('suggest_external_action')).toBe(false);
    expect(isLookupTool('hand_off_to_chat')).toBe(false);
  });
});
