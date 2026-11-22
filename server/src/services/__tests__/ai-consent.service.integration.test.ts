/**
 * ADR 0283 — no model runs on a user's data until they agreed; a chat
 * reply of AGREE / NO is the answer, read in code.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';
import {
  AiConsentRequiredError,
  getAiConsent,
  hasAiConsent,
  parseChatConsentReply,
  setAiConsent,
} from '@/services/ai-consent.service.js';
import { getLlmForUser, resolveTurnLlm } from '@/services/llm/factory.js';
import { getEmbedderForUser } from '@/services/llm/embeddings.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';

const mutable = env as { AI_CONSENT_REQUIRED: boolean; EMBEDDINGS_ENABLED: boolean };
let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  mutable.AI_CONSENT_REQUIRED = true;
  userId = newId('u');
  await db
    .insertInto('users')
    .values({ id: userId, username: `u_${userId}`, display_name: 'Ada Rao', created_at: new Date().toISOString(), shadow: 0 })
    .execute();
});

afterEach(async () => {
  mutable.AI_CONSENT_REQUIRED = false;
  await closeTestDb(db);
});

describe('parseChatConsentReply', () => {
  it.each([
    ['AGREE', 'granted'],
    ['agree.', 'granted'],
    ['I agree!', 'granted'],
    ['@Chord agree', 'granted'],
    ['No', 'declined'],
    ['decline', 'declined'],
  ] as const)('%s → %s', (body, want) => {
    expect(parseChatConsentReply(body)).toBe(want);
  });

  it.each(['I agree with you about dinner', 'no milk please', 'what is on today', '', 'yes'])(
    'reads %j as no answer',
    (body) => {
      expect(parseChatConsentReply(body)).toBeNull();
    },
  );
});

describe('setAiConsent', () => {
  it('refuses to grant without the age statement, and accepts a decline without it', async () => {
    expect(await setAiConsent(db, userId, { decision: 'granted', recipient: 'X' })).toEqual({
      ok: false,
      reason: 'age_not_confirmed',
    });
    expect(await hasAiConsent(db, userId)).toBe(false);
    const declined = await setAiConsent(db, userId, { decision: 'declined', recipient: 'X' });
    expect(declined.ok).toBe(true);
    expect(await hasAiConsent(db, userId)).toBe(false);
  });

  it('a later grant reuses an earlier age statement', async () => {
    await setAiConsent(db, userId, { decision: 'declined', ageConfirmed: true, recipient: 'X' });
    const r = await setAiConsent(db, userId, { decision: 'granted', recipient: 'OpenAI (gpt-test)' });
    expect(r.ok).toBe(true);
    expect(await hasAiConsent(db, userId)).toBe(true);
    expect((await getAiConsent(db, userId))?.recipient).toBe('OpenAI (gpt-test)');
  });

  it('switched off for the deploy, everyone may', async () => {
    mutable.AI_CONSENT_REQUIRED = false;
    expect(await hasAiConsent(db, userId)).toBe(true);
  });
});

describe('the model choke points', () => {
  it('a user who has not agreed gets a model that sends nothing', async () => {
    const llm = await getLlmForUser(db, userId, 'bot_turn');
    await expect(llm.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AiConsentRequiredError);
    const turn = await resolveTurnLlm(db, userId);
    await expect(turn.llm.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AiConsentRequiredError);

    await setAiConsent(db, userId, { decision: 'granted', ageConfirmed: true, recipient: 'X' });
    const ok = await getLlmForUser(db, userId, 'bot_turn');
    await expect(ok.complete([{ role: 'user', content: 'hi' }])).resolves.toBeTypeOf('string');
  });

  it('no consent, no embedder (keyword search only)', async () => {
    const prev = mutable.EMBEDDINGS_ENABLED;
    mutable.EMBEDDINGS_ENABLED = true;
    try {
      expect(await getEmbedderForUser(db, userId)).toBeNull();
      await setAiConsent(db, userId, { decision: 'granted', ageConfirmed: true, recipient: 'X' });
      expect(await getEmbedderForUser(db, userId)).not.toBeNull();
    } finally {
      mutable.EMBEDDINGS_ENABLED = prev;
    }
  });

  it('system work with no user is not affected', async () => {
    const llm = await getLlmForUser(db, null, 'bot_turn');
    await expect(llm.complete([{ role: 'user', content: 'hi' }])).resolves.toBeTypeOf('string');
  });
});

async function say(groupId: string, body: string): Promise<string> {
  const id = newId('m');
  const createdAt = new Date().toISOString();
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: userId,
      kind: 'text',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: createdAt,
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  await runBotTurn(
    db,
    { id, groupId, senderId: userId, kind: 'text', body, mentionsBot: false, createdAt },
    { id: groupId, kind: 'personal' },
  );
  const reply = await db
    .selectFrom('messages')
    .select('body')
    .where('reply_to_id', '=', id)
    .where('kind', '=', 'bot')
    .executeTakeFirstOrThrow();
  return reply.body ?? '';
}

describe('the personal chat', () => {
  it('asks before answering, records AGREE, then answers', async () => {
    const group = await ensurePersonalGroup(db, userId);

    const first = await say(group.id, 'add milk to the Costco list');
    expect(first).toMatch(/Reply AGREE/);
    expect(first).toMatch(/a test model/);
    const list = await db.selectFrom('lists').select('id').where('group_id', '=', group.id).execute();
    expect(list, 'hint: no tool may run before consent').toHaveLength(0);

    const recorded = await say(group.id, 'AGREE');
    expect(recorded).toMatch(/AI is on/);
    const consent = await getAiConsent(db, userId);
    expect(consent?.decision).toBe('granted');
    expect(consent?.ageConfirmed).toBe(true);

    const after = await say(group.id, 'add milk to the Costco list');
    expect(after).not.toMatch(/Reply AGREE/);
  });

  it('NO keeps AI off and says how to turn it on', async () => {
    const group = await ensurePersonalGroup(db, userId);
    await say(group.id, 'hello');
    expect(await say(group.id, 'no')).toMatch(/stays off/);
    expect(await hasAiConsent(db, userId)).toBe(false);
    expect(await say(group.id, 'what is on today')).toMatch(/AI is off for your account/);
  });
});
