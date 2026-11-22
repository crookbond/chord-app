/**
 * ADR 0324 — the call sites that recorded nothing, run through the REAL
 * factory with a Chord model that reports usage. The owner's account spent
 * 27.6M tokens in October and only chat turns and email passes were counted;
 * the briefing scan (a tool loop like a chat turn) was the biggest missing
 * piece. Each test here fails on the code before ADR 0324 with zero rows.
 */
import type { Message } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests, __setLlmForTests } from '@/services/llm/factory.js';
import type { LlmChunk, LlmCompleteOptions, LlmService } from '@/services/llm/types.js';
import { extractMemoriesFromTurn } from '@/services/bot/extraction.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { runDailyScanForUserNow } from '@/services/proactive.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { dayOf } from '@/utils/tz.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '', GMAIL_ENABLED: false } };
});

const TZ = 'America/New_York';

function chordModel(native: boolean, reply: string): LlmService {
  return {
    providerName: 'openai',
    defaultModel: 'chord-model',
    supportsNativeTools: native,
    async complete(_m, o?: LlmCompleteOptions) {
      o?.onUsage?.({ promptTokens: 1000, completionTokens: 50 });
      return reply;
    },
    async *stream(_m, o?: LlmCompleteOptions): AsyncIterable<LlmChunk> {
      yield { type: 'text', delta: reply };
      o?.onUsage?.({ promptTokens: 2000, completionTokens: 80 });
      yield { type: 'done', reason: 'stop' };
    },
  };
}

const sources = async (db: Kysely<DB>, userId: string) =>
  (await db.selectFrom('token_usage').select(['source', 'total_tokens']).where('user_id', '=', userId).execute());

describe('model calls outside chat and email record their tokens', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ada');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
    const tomorrow = dayOf(new Date(Date.now() + 86_400_000).toISOString(), TZ);
    await createEvent(db, {
      groupId,
      title: 'Dentist',
      startsAt: `${tomorrow}T15:00:00`,
      endsAt: `${tomorrow}T16:00:00`,
      createdBy: userId,
    });
  });
  afterEach(async () => {
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  it('the morning briefing scan (tool loop) records under briefing', async () => {
    __setLlmForTests(chordModel(true, '⏰ This week: dentist tomorrow'));
    expect(await runDailyScanForUserNow(db, userId)).toBe(true);
    expect(await sources(db, userId)).toEqual([{ source: 'briefing', total_tokens: 2080 }]);
  });

  it('the single-shot briefing (no native tools) records under briefing', async () => {
    __setLlmForTests(chordModel(false, '⏰ This week: dentist tomorrow'));
    expect(await runDailyScanForUserNow(db, userId)).toBe(true);
    expect(await sources(db, userId)).toEqual([{ source: 'briefing', total_tokens: 1050 }]);
  });

  it('memory extraction after a turn records under memory_extract', async () => {
    __setLlmForTests(chordModel(false, '[]'));
    const msg = await insertMessage(db, { groupId, senderId: userId, body: 'My kid is allergic to peanuts' });
    await extractMemoriesFromTurn(db, {
      triggerMsg: msg as Message,
      triggerUserName: 'Ada',
      botReply: 'Noted.',
      group: { id: groupId, kind: 'personal' },
    });
    expect(await sources(db, userId)).toEqual([{ source: 'memory_extract', total_tokens: 1050 }]);
  });

  it('a chat turn through the real factory is one bot_turn row per model run, never two', async () => {
    // resolveTurnLlm builds its model without getLlmForUser, so the wrapper
    // never sees a chat turn; bot.service records the run itself, once.
    __setLlmForTests(chordModel(false, 'Sure, done.'));
    const msg = await insertMessage(db, { groupId, senderId: userId, body: '@Chord what is on tomorrow?' });
    await db.updateTable('messages').set({ mentions_bot: 1 }).where('id', '=', msg.id).execute();
    await runBotTurn(db, msg as Message, { id: groupId, kind: 'personal' });
    await settleBackgroundWork();
    const all = await sources(db, userId);
    expect(all.filter((r) => r.source === 'bot_turn')).toEqual([{ source: 'bot_turn', total_tokens: 2080 }]);
    // Anything else is a different model call (memory extraction after the turn).
    expect(all.every((r) => r.source === 'bot_turn' || r.source === 'memory_extract')).toBe(true);
  });
});
