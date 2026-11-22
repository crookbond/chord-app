/**
 * Integration smoke test for a full bot turn against the mock LLM provider.
 *
 * Spins up a per-test Postgres database (template-cloned), seeds minimal state
 * (user + group + membership), posts an `@Chord add to Costco list - bread`
 * message, awaits `runBotTurn`, and asserts that the mock provider's
 * text-fence reply produced a Costco list + list_items in the DB.
 *
 * This is the first end-to-end regression gate in the repo — unrelated
 * breakage anywhere in the bot turn pipeline (retrieval, context assembly,
 * stream parsing, tool execution, SSE broadcast paths that don't throw) will
 * surface here.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { newId } from '@/utils/ids.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { closeTestDb, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

async function seedBasicGroup(db: Kysely<DB>): Promise<{
  userId: string;
  groupId: string;
}> {
  const userId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();

  await db
    .insertInto('users')
    .values({ id: userId, username: 'john', display_name: 'John', created_at: now, shadow: 0 })
    .execute();

  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Doe Family',
      kind: 'group',
      invite_code: 'TEST01',
      ingest_email: 'doe-test@chord.app',
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();

  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();

  return { userId, groupId };
}

const insertUserMessage = insertMessage;

describe('bot turn — mock provider, full stack', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('@Chord add to Costco list - bread → creates list + items', async () => {
    const { userId, groupId } = await seedBasicGroup(db);
    const triggerMsg = await insertUserMessage(db, {
      groupId,
      senderId: userId,
      body: '@Chord add to Costco list - bread',
    });

    await runBotTurn(db, triggerMsg, { id: groupId, kind: 'group' });

    const lists = await db
      .selectFrom('lists')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(lists.length).toBeGreaterThanOrEqual(1);
    expect(lists[0]!.name.toLowerCase()).toContain('costco');

    const items = await db
      .selectFrom('list_items')
      .selectAll()
      .where('list_id', '=', lists[0]!.id)
      .execute();
    expect(items.length).toBeGreaterThanOrEqual(1);

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .execute();
    expect(botMessages).toHaveLength(1);
    expect(botMessages[0]!.body).toMatch(/costco/i);
  });

  it('emits bot.start with {triggerMessageId, messageId} before any bot.tool', async () => {
    const { userId, groupId } = await seedBasicGroup(db);
    const triggerMsg = await insertUserMessage(db, {
      groupId,
      senderId: userId,
      body: '@Chord add to Costco list - bread',
    });

    const events: { name: string; data: unknown }[] = [];
    const unsub = sseHub.onBroadcast((_channel, event, data) => {
      events.push({ name: event, data });
    });
    try {
      await runBotTurn(db, triggerMsg, { id: groupId, kind: 'group' });
    } finally {
      unsub();
    }

    const startIdx = events.findIndex((e) => e.name === 'bot.start');
    const firstToolIdx = events.findIndex((e) => e.name === 'bot.tool');
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // bot.start must precede every bot.tool — that's the whole point.
    if (firstToolIdx >= 0) expect(startIdx).toBeLessThan(firstToolIdx);

    const start = events[startIdx]!.data as {
      triggerMessageId: string;
      messageId: string;
    };
    expect(start.triggerMessageId).toBe(triggerMsg.id);
    expect(start.messageId).toMatch(/^m_/);

    // Every later bot.* event must reference the same bot messageId.
    for (const e of events.slice(startIdx + 1)) {
      if (
        e.name === 'bot.tool' ||
        e.name === 'bot.done' ||
        e.name === 'bot.card' ||
        e.name === 'bot.receipt'
      ) {
        const d = e.data as { messageId: string };
        expect(d.messageId).toBe(start.messageId);
      }
    }
  });

  it('directive turn: emits bot.receipt, persists bot row at chord_visible=0, no message event', async () => {
    const { userId, groupId } = await seedBasicGroup(db);
    const triggerMsg = await insertUserMessage(db, {
      groupId,
      senderId: userId,
      body: '@Chord add to Costco list - bread',
    });

    const events: { name: string; data: unknown }[] = [];
    const unsub = sseHub.onBroadcast((_channel, event, data) => {
      events.push({ name: event, data });
    });
    try {
      await runBotTurn(db, triggerMsg, { id: groupId, kind: 'group' });
    } finally {
      unsub();
    }

    // ADR 0022: bot.receipt is the canonical turn-end for directives.
    const receipts = events.filter((e) => e.name === 'bot.receipt');
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!.data as {
      triggerMessageId: string;
      messageId: string;
      status: 'ok' | 'error';
      toolNames: string[];
    };
    expect(receipt.triggerMessageId).toBe(triggerMsg.id);
    expect(receipt.status).toBe('ok');
    expect(receipt.toolNames.length).toBeGreaterThan(0);

    // No `message` event for the bot reply (it would trigger a bubble).
    const botMessageEvents = events.filter(
      (e) =>
        e.name === 'message' &&
        (e.data as { senderId: string | null }).senderId === null,
    );
    expect(botMessageEvents).toHaveLength(0);

    // No bot.token streaming.
    expect(events.some((e) => e.name === 'bot.token')).toBe(false);

    // Bot row exists but is invisible to Chord clients.
    const botRow = await db
      .selectFrom('messages')
      .selectAll()
      .where('id', '=', receipt.messageId)
      .executeTakeFirstOrThrow();
    expect(botRow.kind).toBe('bot');
    expect(botRow.chord_visible).toBe(0);
  });

  it('Q&A turn: no tools fired → emits message + bot.done, no bot.receipt, no bot.token', async () => {
    const { userId, groupId } = await seedBasicGroup(db);
    // Personal group so the bot reacts even without @-mention; the
    // mock provider replies with no tool fences for greeting prompts.
    await db
      .updateTable('groups')
      .set({ kind: 'personal' })
      .where('id', '=', groupId)
      .execute();

    const triggerMsg = await insertUserMessage(db, {
      groupId,
      senderId: userId,
      body: 'hello there',
    });

    const events: { name: string; data: unknown }[] = [];
    const unsub = sseHub.onBroadcast((_channel, event, data) => {
      events.push({ name: event, data });
    });
    try {
      await runBotTurn(db, triggerMsg, { id: groupId, kind: 'personal' });
    } finally {
      unsub();
    }

    // No tools fired → no receipt.
    expect(events.some((e) => e.name === 'bot.receipt')).toBe(false);
    // No streaming tokens either way.
    expect(events.some((e) => e.name === 'bot.token')).toBe(false);
    // Bubble path: bot.done + message both fire once.
    expect(events.filter((e) => e.name === 'bot.done')).toHaveLength(1);
    const botMessages = events.filter(
      (e) =>
        e.name === 'message' &&
        (e.data as { senderId: string | null }).senderId === null,
    );
    expect(botMessages).toHaveLength(1);
  });

  it('personal group: bot replies even without @Chord mention', async () => {
    const { userId, groupId } = await seedBasicGroup(db);
    // Flip to personal kind for this test.
    await db
      .updateTable('groups')
      .set({ kind: 'personal' })
      .where('id', '=', groupId)
      .execute();

    const triggerMsg = await insertUserMessage(db, {
      groupId,
      senderId: userId,
      body: 'book a rental car for the trip',
    });

    await runBotTurn(db, triggerMsg, { id: groupId, kind: 'personal' });

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', groupId)
      .where('kind', '=', 'bot')
      .execute();
    expect(botMessages).toHaveLength(1);

    const tasks = await db
      .selectFrom('tasks')
      .selectAll()
      .where('group_id', '=', groupId)
      .execute();
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0]!.title.toLowerCase()).toContain('rental');
  });
});
