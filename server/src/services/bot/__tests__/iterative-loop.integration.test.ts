/**
 * ADR 0005 — iterative native-tools loop.
 *
 * The other bot integration tests all fake `supportsNativeTools=false` and
 * exercise the text-fence path. This file covers the *other* branch:
 * `runNativeLoop` in `bot.service.ts`. We script a fake provider that
 *   1) first turn — emits a `tool_call` (no text),
 *   2) second turn — emits a final text answer once it has the tool result.
 *
 * If the loop ever silently regresses to single-shot, the second-turn
 * assertion fails: we'd see the tool execute, the bot would persist, but
 * the model would never have read the result back.
 */
import { SSE } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage } from '@/services/llm/types.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

const turns = vi.hoisted(() => ({
  script: [] as ScriptedTurn[],
  observed: [] as LlmMessage[][],
}));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'iterative-mock' as const,
    defaultModel: 'iterative-mock',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: LlmMessage[]): AsyncIterable<LlmChunk> {
      // Snapshot the exact transcript the loop sent us, so we can prove
      // the prior tool-result message was appended on the next iteration.
      turns.observed.push(messages);
      const turn = turns.script.shift();
      if (!turn) {
        yield { type: 'done', reason: 'stop' };
        return;
      }
      if (turn.text) {
        for (const ch of turn.text) {
          yield { type: 'text', delta: ch };
        }
      }
      if (turn.toolCalls) {
        for (const c of turn.toolCalls) {
          yield { type: 'tool_call', call: c };
        }
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

describe('runNativeLoop (ADR 0005)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    turns.script.length = 0;
    turns.observed.length = 0;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('round-trips: tool_call → executor → tool-role message → final text', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });

    // Turn 1: model asks to create a task. No text yet.
    // Turn 2: model produces a final natural-language summary.
    turns.script.push({
      toolCalls: [
        {
          id: 'call-1',
          name: 'create_task',
          args: { title: 'pick up milk' },
        },
      ],
    });
    turns.script.push({ text: 'Done — added the task.' });

    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord remind me to pick up milk',
    });

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    // Loop ran twice.
    expect(turns.observed).toHaveLength(2);

    // Second iteration's transcript MUST include the tool result the loop
    // appended. Without that, the loop is single-shot and the ADR 0005
    // contract is broken.
    const second = turns.observed[1]!;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg, 'expected role=tool message on the 2nd iteration').toBeDefined();
    expect(toolMsg!.toolCallId).toBe('call-1');
    expect(toolMsg!.toolName).toBe('create_task');

    // Bot's final visible body came from the second turn.
    const botRows = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .execute();
    expect(botRows).toHaveLength(1);
    expect(botRows[0]!.body).toContain('Done');

    // The tool actually executed. PROPOSABLE_TOOLS is empty today
    // (executor.ts:74 — UI for proposal confirm/reject is not back yet),
    // so write tools commit straight to their target table.
    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('pick up milk');
  });

  it('hits MAX_ITERATIONS cap when model keeps requesting tools', async () => {
    const uid = await createUser(db, 'bob');
    const group = await createGroup(db, { name: 'Cap', kind: 'group', createdBy: uid });

    // Script far more turns than the cap. Loop should bail at
    // MAX_ITERATIONS without crashing. Cap is intentionally generous
    // (20) so batch operations like "create 30 events from this PDF"
    // fit comfortably even with conservative providers.
    const overshoot = 30;
    for (let i = 0; i < overshoot; i++) {
      turns.script.push({
        toolCalls: [{ id: `c${i}`, name: 'list_tasks', args: {} }],
      });
    }

    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord show all tasks',
    });

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    expect(turns.observed.length).toBeLessThan(overshoot);
    expect(turns.observed.length).toBeGreaterThanOrEqual(6);
  });

  it('runs many tool_calls in a single round (30 events from one PDF)', async () => {
    const uid = await createUser(db, 'dave');
    const group = await createGroup(db, { name: 'PDF', kind: 'group', createdBy: uid });

    // Round 1: model returns all 30 events at once.
    // Round 2: model wraps up with a summary message.
    const calls = Array.from({ length: 30 }, (_, i) => ({
      id: `evt-${i}`,
      name: 'create_event',
      args: {
        title: `Event ${i}`,
        // Relative: `create_event` refuses a start that has already passed, so
        // a hardcoded month stops writing once it rots past today.
        startsAt: `${new Date(Date.now() + (i + 1) * 86400000).toISOString().slice(0, 10)}T18:00:00+00:00`,
      },
    }));
    turns.script.push({ toolCalls: calls });
    turns.script.push({ text: 'Added 30 events.' });

    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord add all events from that PDF',
    });

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    // Two rounds — one tool round, one summary round.
    expect(turns.observed).toHaveLength(2);

    // All 30 calls committed directly (PROPOSABLE_TOOLS is empty today,
    // so write tools bypass the proposals table).
    const events = await db
      .selectFrom('events')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(events).toHaveLength(30);

    // Second iteration's transcript carries 30 tool-result messages.
    const second = turns.observed[1]!;
    const toolResults = second.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(30);
  });

  it('a declined tool call (ran, but nothing happened) broadcasts "declined", not "ok"', async () => {
    // Prod: a `create_event` refusal (here: a past-dated start — ADR 0100)
    // rendered as a cheerful "created event · <why it refused>" pill, because
    // `SSE.botTool` only ever distinguished "threw" from "didn't throw",
    // never "did this actually do anything". Pinning the wiring: a real
    // validation refusal must broadcast `declined`, and must not write
    // anything. (Past-dated rather than a bad `repeat`, so this test stays
    // independent of the separate hallucinated-repeat fallback — see
    // recurring-events.integration.test.ts for that one.)
    const uid = await createUser(db, 'erin');
    const group = await createGroup(db, { name: 'Repeat', kind: 'group', createdBy: uid });

    turns.script.push({
      toolCalls: [
        {
          id: 'call-1',
          name: 'create_event',
          args: {
            title: 'Call with AHF',
            startsAt: '2020-01-01T12:00:00+00:00',
          },
        },
      ],
    });
    turns.script.push({ text: 'That date has already passed — did you mean a future date?' });

    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord add call with AHF on Jan 1 2020 at noon',
    });

    const toolEvents: { name: string; status: string }[] = [];
    const off = sseHub.onBroadcast((_ch, ev, data) => {
      if (ev === SSE.botTool) toolEvents.push(data as { name: string; status: string });
    });
    try {
      await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });
    } finally {
      off();
    }

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({ name: 'create_event', status: 'declined' });

    const events = await db.selectFrom('events').selectAll().where('group_id', '=', group.id).execute();
    expect(events).toHaveLength(0);
  });

  // Audit 2026-11-01: the native path only left personal-only tools out of the
  // offered list; a model that called one anyway in a shared group ran it
  // (the text-fence path dropped it). Both now refuse in executeAndBroadcast.
  it('refuses a personal-only tool the model calls in a shared group', async () => {
    const uid = await createUser(db, 'gina');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    turns.script.push({
      toolCalls: [{ id: 'sig', name: 'set_email_signature', args: { text: 'Sent from the family chat' } }],
    });
    turns.script.push({ text: 'That only works in your personal chat.' });
    const triggerMsg = await insertMessage(db, { groupId: group.id, senderId: uid, body: '@Chord what is my signature?' });

    const toolEvents: { name: string; status: string }[] = [];
    const off = sseHub.onBroadcast((_ch, ev, data) => {
      if (ev === SSE.botTool) toolEvents.push(data as { name: string; status: string });
    });
    try {
      await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });
    } finally {
      off();
    }

    const me = await db.selectFrom('users').select('email_signature').where('id', '=', uid).executeTakeFirstOrThrow();
    expect(me.email_signature ?? null).toBeNull();
    expect(toolEvents).toEqual([expect.objectContaining({ name: 'set_email_signature', status: 'error' })]);
    const toolMsg = turns.observed[1]?.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/only available in your personal chat/);
  });

  // Same class: auto-filed attachment tools were left out of the offered list
  // but still ran if called, so a trip filed from the upload was proposed again.
  it('refuses a trip tool on a turn whose upload the trip filer owns', async () => {
    const uid = await createUser(db, 'hana');
    const group = await createGroup(db, { name: 'Trip', kind: 'group', createdBy: uid });
    const attachmentId = newId('a');
    const now = new Date().toISOString();
    await db
      .insertInto('attachments')
      .values({
        id: attachmentId,
        scope_kind: 'group',
        scope_id: group.id,
        uploaded_by: uid,
        filename: 'itinerary.pdf',
        mime_type: 'application/pdf',
        size: 1024,
        path: `test/${attachmentId}`,
        summary: null,
        extracted_text: null,
        image_meta: null,
        pinned: 0,
        indexed_at: now,
        created_at: now,
      })
      .execute();
    turns.script.push({ toolCalls: [{ id: 't1', name: 'create_trip', args: { name: 'Denver', destination: 'Denver', startDate: '2030-02-11', endDate: '2030-02-14' } }] });
    turns.script.push({ text: 'The itinerary is being filed.' });
    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord what is in this file?',
      attachmentId,
    });

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    expect(await db.selectFrom('trips').select('id').execute()).toHaveLength(0);
    expect(await db.selectFrom('proposals').select('id').execute()).toHaveLength(0);
    const toolMsg = turns.observed[1]?.find((m) => m.role === 'tool');
    expect(String(toolMsg?.content)).toMatch(/not available here/);
  });

  it('skips tool execution when args fail zod validation', async () => {
    const uid = await createUser(db, 'carol');
    const group = await createGroup(db, { name: 'Bad', kind: 'group', createdBy: uid });

    // create_task requires `title`. Send empty args → validation fails →
    // loop appends an error tool-result and continues.
    turns.script.push({
      toolCalls: [{ id: 'bad', name: 'create_task', args: {} }],
    });
    turns.script.push({ text: "Couldn't add that." });

    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord remind me',
    });

    await runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' });

    // Two iterations, but no task was created (validation rejected the
    // call before the executor ran).
    expect(turns.observed).toHaveLength(2);
    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(tasks).toHaveLength(0);

    // Second iteration's tool-role message carries the validation error.
    const second = turns.observed[1]!;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg!.content)).toMatch(/error/i);
  });

  it('drops a truncated tool call instead of re-feeding it (provider 400 guard)', async () => {
    const uid = await createUser(db, 'erin');
    const group = await createGroup(db, { name: 'Trunc', kind: 'group', createdBy: uid });

    // Simulate a `finish_reason: 'length'` truncation: the provider adapter
    // couldn't parse the cut-off arguments, so it surfaced the `{ __raw }`
    // sentinel. Echoing this back into the transcript is what made the
    // provider 400; the loop must drop it and stop cleanly.
    turns.script.push({
      toolCalls: [{ id: 'cut', name: 'create_task', args: { __raw: '{"title":"apply for world cup lot' } }],
    });
    // Use a NON-imperative trigger so the imperative strict-mode retry
    // (which would fire a second stream) doesn't muddy the assertion.
    const triggerMsg = await insertMessage(db, {
      groupId: group.id,
      senderId: uid,
      body: '@Chord what do you think about the world cup lottery?',
    });

    await expect(
      runBotTurn(db, triggerMsg, { id: group.id, kind: 'group' }),
    ).resolves.not.toThrow();

    // Loop stopped after the single (broken) round — the dropped call emptied
    // the round, so no second stream and nothing was re-fed.
    expect(turns.observed).toHaveLength(1);

    // No `__raw` tool call leaked into the transcript, and nothing executed.
    const onlyTranscript = turns.observed[0]!;
    expect(onlyTranscript.some((m) => m.role === 'tool')).toBe(false);
    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', group.id)
      .execute();
    expect(tasks).toHaveLength(0);
  });
});
