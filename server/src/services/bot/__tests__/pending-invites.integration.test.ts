/**
 * ADR 0166 addendum — prod 2026-11-02: "Call with Karl" was created, the bot
 * asked for Karl's email with an "Add Karl from Contacts" card, and the
 * user replied with just `Karl@media.example`. The model answered in prose and
 * never called update_event, so Karl was never invited. A bare address has
 * no verb, so the imperative retry never fired; the pending-invite reminder in
 * the prompt was the only thing asking for the call.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { listPendingInvitees } from '@/services/bot/pending-invites.js';
import { createGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage } from '@/services/llm/types.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({
  script: [] as Array<ScriptedTurn | ((messages: LlmMessage[]) => ScriptedTurn)>,
  observed: [] as LlmMessage[][],
}));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pending-invite-mock' as const,
    defaultModel: 'pending-invite-mock',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmChunk> {
      turns.observed.push(messages);
      const next = turns.script.shift();
      const turn = typeof next === 'function' ? next(messages) : next;
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

describe('a bare email answering a pending invite reaches update_event', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    turns.observed.length = 0;
    userId = await createUser(db, 'john');
    const group = await createGroup(db, { name: 'Me', kind: 'personal', createdBy: userId });
    groupId = group.id;
    const starts = new Date(Date.now() + 3 * 86_400_000);
    starts.setUTCHours(15, 45, 0, 0);
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: null,
      tzOffset: '+00:00',
      emit: () => undefined,
      call: {
        name: 'create_event',
        args: { title: 'Call with Karl', startsAt: starts.toISOString(), invitees: ['Karl'] },
      },
    });
    expect((await listPendingInvitees(db, groupId, userId)).map((p) => p.name)).toEqual(['Karl']);
  });

  afterEach(async () => {
    await settleBackgroundWork();
    await closeTestDb(db);
  });

  it('retries when the model answers the address in prose, and the reminder clears', async () => {
    // First pass: the prod failure — prose, no tool.
    turns.script.push({ text: "Thanks! I'll use that for Karl." });
    // Retry: only calls update_event when it was told to.
    turns.script.push((messages) => {
      const strict = messages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('STRICT MODE'),
      );
      const told = strict ? /\(eventId ([^)]+)\)/.exec(String(strict.content))?.[1] : undefined;
      return told
        ? { toolCalls: [{ id: 'c1', name: 'update_event', args: { eventId: told, invitees: ['Karl@media.example'] } }] }
        : { text: 'Noted.' };
    });
    turns.script.push({ text: 'Added Karl.' });

    const trigger = await insertMessage(db, { groupId, senderId: userId, body: 'Karl@media.example' });
    await runBotTurn(db, trigger, { id: groupId, kind: 'personal' });

    expect(turns.observed.length).toBeGreaterThanOrEqual(2);
    expect(await listPendingInvitees(db, groupId, userId)).toEqual([]);
  });

  it('does not retry an ordinary message with no address', async () => {
    turns.script.push({ text: 'Sure.' });
    const trigger = await insertMessage(db, { groupId, senderId: userId, body: 'thanks' });
    await runBotTurn(db, trigger, { id: groupId, kind: 'personal' });

    expect(turns.observed).toHaveLength(1);
    expect((await listPendingInvitees(db, groupId, userId)).map((p) => p.name)).toEqual(['Karl']);
  });
});
