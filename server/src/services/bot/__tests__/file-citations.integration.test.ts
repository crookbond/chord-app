/**
 * ADR 0288 (addendum 2026-10-25) — the "based on:" row, end to end.
 *
 * The prod case (owner's personal chat, 2026-10-25): a plan-my-day reply built
 * from the calendar and list_tasks was footed "based on: SQ008517.pdf ·
 * SQ008238.pdf", two New York Athletic Club statements. The reply repeated the
 * to-do "paying the New York Athletic Club balance by Saturday", the same words
 * sat in the statements' injected text, and the phrase rule read that as a
 * quote. No file tool ran, so no file may be named.
 */
import { SSE } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage } from '@/services/llm/types.js';
import { sseHub } from '@/services/sse.hub.js';
import { createTask } from '@/services/tasks.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({
  script: [] as ScriptedTurn[],
  prompts: [] as string[],
}));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'citations-mock' as const,
    defaultModel: 'citations-mock',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmChunk> {
      turns.prompts.push(messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
      const turn = turns.script.shift();
      if (turn?.text) yield { type: 'text', delta: turn.text };
      if (turn?.toolCalls) {
        for (const call of turn.toolCalls) yield { type: 'tool_call', call };
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

const TODO = 'Paying the New York Athletic Club balance by Saturday';

async function insertStatement(db: Kysely<DB>, groupId: string, userId: string, filename: string) {
  const id = newId('a');
  const now = new Date().toISOString();
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: groupId,
      uploaded_by: userId,
      filename,
      mime_type: 'application/pdf',
      size: 1000,
      path: `tests/${id}.pdf`,
      summary: 'New York Athletic Club member statement.',
      extracted_text: `Member statement. Please arrange for paying the New York Athletic Club balance by Saturday to avoid a late charge.`,
      image_meta: null,
      pinned: 1,
      indexed_at: now,
      created_at: now,
    })
    .execute();
  await indexAttachmentChunks(db, id);
  return id;
}

describe('"based on:" row under a bot reply', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    turns.prompts.length = 0;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('names no file under a plan-my-day reply that repeats a to-do the statements also hold', async () => {
    const uid = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    await createTask(db, { groupId: group.id, createdBy: uid, title: TODO });
    await insertStatement(db, group.id, uid, 'SQ008517.pdf');
    await insertStatement(db, group.id, uid, 'SQ008238.pdf');

    turns.script.push({ toolCalls: [{ id: 'call-1', name: 'list_tasks', args: {} }] });
    turns.script.push({
      text: `Here's your Saturday:\n• 10:00 Squash Singles\n• To-do: paying the New York Athletic Club balance by Saturday\n• Free from 2 PM.`,
    });

    const trigger = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord plan my day around the New York Athletic Club balance',
    });

    const sources: unknown[] = [];
    const off = sseHub.onBroadcast((_ch, ev, data) => {
      if (ev === SSE.botSources) sources.push(data);
    });
    try {
      await runBotTurn(db, trigger, { id: group.id, kind: 'group' });
    } finally {
      off();
    }

    // The statements were in front of the model (the precondition for the bug)...
    expect(turns.prompts.some((p) => p.includes('SQ008517.pdf'))).toBe(true);
    // ...and the reply really repeats their words, but no file tool used them.
    expect(sources).toEqual([]);
  });
});
