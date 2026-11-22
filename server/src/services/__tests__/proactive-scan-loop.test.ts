/**
 * The morning scan's lookup loop used to add up the text of every round, so
 * whatever the model wrote beside a lookup ("Let me check your trips…") was
 * printed in the briefing. Only the round that answers is the briefing.
 */
import type { Kysely } from 'kysely';
import { describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import type { LlmService } from '@/services/llm/types.js';
import { __testing } from '@/services/proactive.service.js';

type Round = { text: string; call?: string };

/** One scripted round per `stream` call; records what it was sent. */
function scriptedLlm(rounds: Round[]) {
  const sent: unknown[][] = [];
  let i = 0;
  const llm = {
    providerName: 'scripted',
    defaultModel: 'scripted',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: unknown[]) {
      sent.push([...messages]);
      const r = rounds[Math.min(i++, rounds.length - 1)];
      yield { type: 'text' as const, delta: r.text };
      // An unknown tool name never reaches the database.
      if (r.call) yield { type: 'tool_call' as const, call: { id: `c${i}`, name: r.call, args: {} } };
      yield { type: 'done' as const };
    },
  } as unknown as LlmService;
  return { llm, sent };
}

const db = {} as Kysely<DB>;

describe('runScanLoop', () => {
  it('keeps only the answering round, not the narration beside a lookup', async () => {
    const { llm } = scriptedLlm([
      { text: 'Let me check your upcoming trips first. ', call: 'no_such_tool' },
      { text: '⏰ This week: dentist Tuesday' },
    ]);
    const out = await __testing.runScanLoop(llm, db, 'u1', 'TODAY: …');
    expect(out).toBe('⏰ This week: dentist Tuesday');
  });

  it('asks for the briefing when it runs out of rounds still looking things up', async () => {
    const { llm, sent } = scriptedLlm([
      { text: 'Checking… ', call: 'no_such_tool' },
      { text: 'Checking… ', call: 'no_such_tool' },
      { text: 'Checking… ', call: 'no_such_tool' },
      { text: 'Checking… ', call: 'no_such_tool' },
      { text: '📋 Heads-up: passport renewal', call: 'no_such_tool' },
    ]);
    const out = await __testing.runScanLoop(llm, db, 'u1', 'TODAY: …');
    expect(out).toBe('📋 Heads-up: passport renewal');
    const last = sent[sent.length - 1].at(-1) as { role: string; content: string };
    expect(last.role).toBe('user');
    expect(last.content).toMatch(/write the briefing now/i);
  });
});
