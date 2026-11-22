import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { createGroup } from '@/services/groups.service.js';
import {
  closeTestDb,
  createUser,
  fenceWith,
  insertMessage,
  openTestDb,
} from '@/__test-helpers__/db.js';

const mockState = vi.hoisted(() => ({ response: '' }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'relay-mock',
    defaultModel: 'relay-mock',
    supportsNativeTools: false,
    complete: async () => '[]',
    async *stream() {
      yield { type: 'text', delta: mockState.response };
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

const insertTrigger = (
  db: Kysely<DB>,
  opts: { groupId: string; senderId: string; body: string },
) =>
  insertMessage(db, {
    ...opts,
    mentionsBot: true,
    source: 'telegram',
    externalMessageId: 'tg-1',
    chordVisible: 0,
  });

describe('relay integration', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await connectorRegistry.shutdownAll();
    await closeTestDb(db);
  });

  it('telegram bot-only turn can relay a visible bot message into Chord', async () => {
    mockState.response = fenceWith("I've let the local group know.", {
      name: 'relay',
      args: { target: 'chord', text: 'dinner is at 7' },
    });

    const userId = await createUser(db, 'alice', 'Alice');
    const group = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: userId,
    });
    const trigger = await insertTrigger(db, {
      groupId: group.id,
      senderId: userId,
      body: '@Chord tell the local group dinner is at 7',
    });

    const telegram = new MockConnector(db, 'telegram');
    connectorRegistry.register(telegram);

    await runBotTurn(
      db,
      trigger,
      { id: group.id, kind: 'group' },
      undefined,
      { platform: 'telegram', externalChannelId: '-1001', botUserId: null },
      0,
    );

    const botMessages = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', group.id)
      .where('kind', '=', 'bot')
      .orderBy('created_at', 'asc')
      .execute();

    expect(botMessages).toHaveLength(2);
    expect(botMessages[0]).toMatchObject({
      body: 'Alice (from telegram) asked me to share: dinner is at 7',
      chord_visible: 1,
    });
    expect(botMessages[1]).toMatchObject({
      body: "I've let the local group know.",
      chord_visible: 0,
    });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toBe("I've let the local group know.");
  });
});
