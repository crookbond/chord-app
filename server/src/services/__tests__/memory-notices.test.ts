/**
 * ADR 0281 — Chord says what it learned (a card per new fact, under the reply
 * or in the sayer's personal chat), learns nothing from a repeat, and can be
 * told to correct or forget a fact in chat.
 */
import type { BotCard, Message } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { addMember, closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { confirmMemory, getMemory, upsertMemory, writeMemory } from '@/services/memory.service.js';
import { refreshMemoryNotice } from '@/services/memory-notices.service.js';

const mockState = vi.hoisted(() => ({ rows: '[]', prompts: [] as string[], refuse: false }));

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'mock',
    defaultModel: 'mock',
    supportsNativeTools: false,
    complete: async (msgs: { content: string }[]) => {
      if (mockState.refuse) {
        const { AllowanceExhaustedError } = await import('@/services/llm/refusal.js');
        throw new AllowanceExhaustedError('none');
      }
      mockState.prompts.push(msgs.map((m) => m.content).join('\n'));
      return mockState.rows;
    },
    async *stream() {
      yield { type: 'done', reason: 'stop' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

import { extractMemoriesFromTurn } from '@/services/bot/extraction.js';
import { correctMemoryForTurn, forgetMemoryForTurn, matchMemories } from '@/services/bot/memory-tools.js';

async function backlogOf(db: Kysely<DB>): Promise<{ kind: string; ref: string }[]> {
  return db.selectFrom('ai_backlog').select(['kind', 'ref']).execute();
}

async function cardsOf(db: Kysely<DB>, messageId: string): Promise<BotCard[]> {
  const row = await db
    .selectFrom('message_cards')
    .select('cards_json')
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row ? (JSON.parse(row.cards_json) as BotCard[]) : [];
}

async function botReply(db: Kysely<DB>, groupId: string): Promise<string> {
  const id = `m_bot_${Math.random().toString(36).slice(2)}`;
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body: 'Noted.',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  return id;
}

describe('memory notices (ADR 0281)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Doe');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john })).id;
    await addMember(db, groupId, priya);
    mockState.rows = '[]';
    mockState.prompts = [];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeTestDb(db);
  });

  const turn = async (body: string, noticeMessageId: string | null) => {
    const msg = await insertMessage(db, { groupId, senderId: john, body });
    return extractMemoriesFromTurn(db, {
      triggerMsg: msg as Message,
      triggerUserName: 'John',
      botReply: noticeMessageId ? 'Noted.' : '',
      group: { id: groupId, kind: 'group' },
      noticeMessageId,
    });
  };

  it('puts a card for a newly learned fact under the bot reply', async () => {
    const maya = await createPersona(db, { groupId, name: 'Maya', householdRole: 'child', managedBy: john });
    mockState.rows = JSON.stringify([
      { key: 'allergy', value: 'peanuts', confidence: 0.95, scope: 'persona', subject: 'Maya' },
    ]);
    const reply = await botReply(db, groupId);

    const learned = await turn('Maya is allergic to peanuts', reply);

    expect(learned).toHaveLength(1);
    const cards = await cardsOf(db, reply);
    expect(cards).toEqual([
      expect.objectContaining({
        kind: 'memory',
        title: 'Maya · allergy',
        subtitle: 'peanuts',
        memoryId: learned[0].id,
        memoryStatus: 'proposed',
        memoryForUserId: john,
      }),
    ]);
    expect(learned[0].subjectId).toBe(maya.id);
    const link = await db.selectFrom('memory_notices').selectAll().executeTakeFirst();
    expect(link).toMatchObject({ memory_id: learned[0].id, message_id: reply });
  });

  it('passive listening past the allowance asks no model (ADR 0079/0325)', async () => {
    // A listening group with the sayer's tokens spent: the bot turn is gated,
    // but passive extraction ran with no turn and made a paid call per message.
    const env0 = { billing: env.BILLING_ENABLED, free: env.FREE_TOKEN_ALLOWANCE };
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = 0;
    try {
      mockState.rows = JSON.stringify([{ key: 'allergy', value: 'peanuts', confidence: 0.95, scope: 'user' }]);
      const learned = await turn('I am allergic to peanuts', null);
      expect(learned).toHaveLength(0);
      expect(mockState.prompts).toHaveLength(0);
      // Held back, not dropped: it runs once tokens are back (ai-backlog).
      expect(await backlogOf(db)).toEqual([{ kind: 'memory_message', ref: expect.any(String) }]);
    } finally {
      (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = env0.billing;
      (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = env0.free;
    }
  });

  it('keeps cards a tool already put on the reply', async () => {
    const reply = await botReply(db, groupId);
    await db
      .insertInto('message_cards')
      .values({
        message_id: reply,
        cards_json: JSON.stringify([{ kind: 'list', title: 'Costco' }]),
        created_at: new Date().toISOString(),
      })
      .execute();
    mockState.rows = JSON.stringify([
      { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
    ]);
    await turn('we fly out of JFK', reply);
    const cards = await cardsOf(db, reply);
    expect(cards.map((c) => c.kind)).toEqual(['list', 'memory']);
  });

  it('with no visible reply, posts the notice to the sayer\'s personal chat without a push', async () => {
    mockState.rows = JSON.stringify([
      { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
    ]);
    await turn('we fly out of JFK', null);

    const personal = await ensurePersonalGroup(db, john);
    const notice = await db
      .selectFrom('messages')
      .selectAll()
      .where('group_id', '=', personal.id)
      .executeTakeFirstOrThrow();
    expect(notice).toMatchObject({ kind: 'system', is_proactive: 1, auto_mirror: 0 });
    expect(notice.body).toBe('From your message in Doe Family, I noted:');
    const cards = await cardsOf(db, notice.id);
    expect(cards[0]).toMatchObject({ kind: 'memory', title: 'John Doe · home airport', subtitle: 'JFK' });
  });

  // Prod shape: "we fly out of JFK" said again after it was saved. The
  // proposed-duplicate check only looked at other PROPOSED rows, so each
  // restatement opened another pending card for a fact already confirmed.
  it('learns nothing from restating a saved fact (no new row, no card)', async () => {
    const saved = await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: john,
      key: 'home_airport',
      value: 'JFK',
      source: 'explicit',
      status: 'confirmed',
    });
    mockState.rows = JSON.stringify([
      { key: 'home_airport', value: 'jfk ', confidence: 0.9, scope: 'persona', subject: 'self' },
    ]);
    const reply = await botReply(db, groupId);

    const learned = await turn('we fly out of JFK', reply);

    expect(learned).toEqual([]);
    const rows = await db.selectFrom('memories').selectAll().where('key', '=', 'home_airport').execute();
    expect(rows.map((r) => r.id)).toEqual([saved.id]);
    expect(await cardsOf(db, reply)).toEqual([]);
  });

  it('writeMemory reports a repeat of the saved value as not created', async () => {
    await upsertMemory(db, {
      groupId, scope: 'persona', personaId: john, key: 'diet', value: 'Vegetarian', source: 'explicit',
    });
    const r = await writeMemory(db, {
      groupId, scope: 'persona', personaId: john, key: 'diet', value: 'vegetarian', source: 'passive', status: 'proposed',
    });
    expect(r.created).toBe(false);
    expect(r.memory.status).toBe('confirmed');
  });

  it('sends nothing to the model, and learns nothing, without the sayer\'s AI consent (ADR 0283)', async () => {
    const mutable = env as { AI_CONSENT_REQUIRED: boolean };
    mutable.AI_CONSENT_REQUIRED = true;
    try {
      mockState.rows = JSON.stringify([
        { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
      ]);
      const learned = await turn('we fly out of JFK', null);
      expect(learned).toEqual([]);
      expect(mockState.prompts).toEqual([]);
      expect(await db.selectFrom('memories').select('id').execute()).toHaveLength(0);
      expect(await backlogOf(db)).toEqual([{ kind: 'memory_message', ref: expect.any(String) }]);
    } finally {
      mutable.AI_CONSENT_REQUIRED = false;
    }
  });

  it('a refusal from the model wrapper holds the message back instead of dropping it', async () => {
    // The after-reply pass can follow a turn that spent the last tokens; the
    // wrapper refuses, and the catch used to log it and lose the work.
    mockState.refuse = true;
    try {
      const learned = await turn('we fly out of JFK', null);
      expect(learned).toEqual([]);
      expect(await backlogOf(db)).toEqual([{ kind: 'memory_message', ref: expect.any(String) }]);
    } finally {
      mockState.refuse = false;
    }
  });

  it('tells the extractor what it already knows', async () => {
    await upsertMemory(db, {
      groupId, scope: 'persona', personaId: john, key: 'home_airport', value: 'JFK', source: 'explicit',
    });
    await turn('hello', null);
    expect(mockState.prompts[0]).toContain('John Doe · home_airport = JFK');
  });

  it('rewrites the card when the fact is kept, replaced or removed', async () => {
    mockState.rows = JSON.stringify([
      { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
    ]);
    const reply = await botReply(db, groupId);
    const [m] = await turn('we fly out of JFK', reply);

    await confirmMemory(db, m.id);
    await refreshMemoryNotice(db, m.id);
    expect((await cardsOf(db, reply))[0]).toMatchObject({ memoryStatus: 'saved', meta: 'Remembered' });

    await correctMemoryForTurn(db, { groupId, userId: john, match: 'home airport', value: 'EWR' });
    expect((await cardsOf(db, reply))[0]).toMatchObject({ memoryStatus: 'replaced', meta: 'Updated to: EWR' });
  });

  describe('correct_memory / forget_memory', () => {
    it('corrects a saved fact by name, keeping the old one in the supersede chain', async () => {
      const maya = await createPersona(db, { groupId, name: 'Maya', householdRole: 'child', managedBy: john });
      const old = await upsertMemory(db, {
        groupId, scope: 'group', key: 'allergy', value: 'peanuts', source: 'explicit',
        subjectType: 'persona', subjectId: maya.id,
      });

      const r = await correctMemoryForTurn(db, { groupId, userId: john, match: "Maya's allergy", value: 'tree nuts' });

      expect(r.data).toMatchObject({ result: 'corrected', updated: true, oldValue: 'peanuts', newValue: 'tree nuts' });
      expect((await getMemory(db, old.id))?.supersededBy).toBeTruthy();
      expect(r.card).toMatchObject({ kind: 'memory', title: 'Maya · allergy', subtitle: 'tree nuts', memoryStatus: 'saved' });
    });

    it('forgets a saved fact and marks its card removed', async () => {
      mockState.rows = JSON.stringify([
        { key: 'home_airport', value: 'JFK', confidence: 0.9, scope: 'persona', subject: 'self' },
      ]);
      const reply = await botReply(db, groupId);
      const [m] = await turn('we fly out of JFK', reply);
      await confirmMemory(db, m.id);

      const r = await forgetMemoryForTurn(db, { groupId, userId: john, match: 'home airport' });

      expect(r.data).toMatchObject({ result: 'forgotten', deleted: true, value: 'JFK' });
      expect(await getMemory(db, m.id)).toBeNull();
      expect((await cardsOf(db, reply))[0]).toMatchObject({ memoryStatus: 'removed', meta: 'Removed' });
    });

    it('asks when several facts match, and changes nothing', async () => {
      await upsertMemory(db, { groupId, scope: 'group', key: 'school_pickup', value: '3pm', source: 'explicit' });
      await upsertMemory(db, { groupId, scope: 'group', key: 'school_name', value: 'Lincoln', source: 'explicit' });

      const r = await forgetMemoryForTurn(db, { groupId, userId: john, match: 'school' });

      expect(r.data).toMatchObject({ result: 'ambiguous', deleted: false });
      expect((r.data.candidates as unknown[]).length).toBe(2);
      expect(await db.selectFrom('memories').select('id').execute()).toHaveLength(2);
    });

    it('says not_found rather than pretending', async () => {
      const r = await correctMemoryForTurn(db, { groupId, userId: john, match: 'shoe size', value: '9' });
      expect(r.data).toMatchObject({ result: 'not_found', updated: false });
      expect(await db.selectFrom('memories').select('id').execute()).toHaveLength(0);
    });

    it('cannot reach another member\'s private fact', async () => {
      const hers = await upsertMemory(db, {
        groupId, scope: 'persona', personaId: priya, key: 'home_airport', value: 'SFO', source: 'explicit',
      });

      const byName = await forgetMemoryForTurn(db, { groupId, userId: john, match: 'home airport' });
      const byId = await forgetMemoryForTurn(db, { groupId, userId: john, memoryId: hers.id });

      expect(byName.data.result).toBe('not_found');
      expect(byId.data.result).toBe('not_found');
      expect(await getMemory(db, hers.id)).not.toBeNull();
    });
  });

  it('matchMemories needs every word, and ignores possessives and filler', () => {
    const rows = [
      { id: 'a', key: 'allergy', value: 'peanuts' },
      { id: 'b', key: 'favorite_cuisine', value: 'thai' },
    ] as Parameters<typeof matchMemories>[0];
    const labels = new Map([['a', 'Maya'], ['b', 'Maya']]);
    expect(matchMemories(rows, labels, "Maya's allergy").map((m) => m.id)).toEqual(['a']);
    expect(matchMemories(rows, labels, 'forget the favorite cuisine').map((m) => m.id)).toEqual(['b']);
    expect(matchMemories(rows, labels, 'Maya')).toHaveLength(2);
    expect(matchMemories(rows, labels, 'the')).toEqual([]);
  });
});
