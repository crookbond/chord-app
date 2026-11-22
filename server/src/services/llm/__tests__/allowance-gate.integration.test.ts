/**
 * ADR 0079/0325 — the allowance is refused in the one wrapper too, beside
 * consent (ADR 0283). Every model call already went through `getLlmForUser` /
 * `resolveTurnLlm`, which checked consent; the allowance was checked only at
 * each entry point, so a door that forgot (the read-time email pass, the
 * upload filers, meeting context, passive memory extraction) ran on Chord's
 * key with nothing left.
 */
import { randomBytes } from 'node:crypto';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { env } from '@/config/env.js';
import { __resetLlmCacheForTests, __setLlmForTests, getLlmForUser, resolveTurnLlm } from '@/services/llm/factory.js';
import { AllowanceExhaustedError, canUseAi, isAiRefusal } from '@/services/llm/refusal.js';
import type { LlmService } from '@/services/llm/types.js';
import { sealToken } from '@/utils/crypto-tokens.js';

let calls = 0;
const counting: LlmService = {
  providerName: 'openai',
  defaultModel: 'chord-model',
  supportsNativeTools: false,
  async complete(_m, o) {
    calls += 1;
    o?.onUsage?.({ promptTokens: 50, completionTokens: 10 });
    return 'ok';
  },
  async *stream(_m, o) {
    calls += 1;
    yield { type: 'text', delta: 'hi' };
    o?.onUsage?.({ promptTokens: 50, completionTokens: 10 });
    yield { type: 'done', reason: 'stop' };
  },
};

const e = env as { BILLING_ENABLED: boolean; FREE_TOKEN_ALLOWANCE: number; STRIPE_PRICE_ID_BYOK: string };
let was: { billing: boolean; free: number; byok: string };
let originalMasterKey: string | undefined;
beforeAll(() => {
  originalMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
});
afterAll(() => {
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = originalMasterKey;
});

let db: Kysely<DB>;
let userId: string;
beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'allowance');
  was = { billing: e.BILLING_ENABLED, free: e.FREE_TOKEN_ALLOWANCE, byok: e.STRIPE_PRICE_ID_BYOK };
  e.BILLING_ENABLED = true;
  e.STRIPE_PRICE_ID_BYOK = '';
  calls = 0;
  __setLlmForTests(counting);
});
afterEach(async () => {
  e.BILLING_ENABLED = was.billing;
  e.FREE_TOKEN_ALLOWANCE = was.free;
  e.STRIPE_PRICE_ID_BYOK = was.byok;
  __resetLlmCacheForTests();
  await closeTestDb(db);
});

describe('the wrapper refuses a call with no allowance left', () => {
  it('getLlmForUser: refused before anything is sent', async () => {
    e.FREE_TOKEN_ALLOWANCE = 0;
    const llm = await getLlmForUser(db, userId, 'meeting_context');
    const err = await llm.complete([{ role: 'user', content: 'hi' }]).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AllowanceExhaustedError);
    expect(isAiRefusal(err)).toBe(true);
    expect(calls).toBe(0);
  });

  it('a pass that spends the last of the allowance is refused on the next call', async () => {
    e.FREE_TOKEN_ALLOWANCE = 100;
    for (let i = 0; i < 2; i += 1) {
      await (await getLlmForUser(db, userId, 'email_magics')).complete([{ role: 'user', content: 'x' }]);
    }
    const third = await getLlmForUser(db, userId, 'email_magics');
    await expect(third.complete([{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(AllowanceExhaustedError);
    expect(calls).toBe(2);
    expect(await canUseAi(db, userId)).toBe(false);
  });

  it('resolveTurnLlm: the stream is refused too', async () => {
    e.FREE_TOKEN_ALLOWANCE = 0;
    const { llm } = await resolveTurnLlm(db, userId);
    const read = async () => {
      for await (const chunk of llm.stream([{ role: 'user', content: 'hi' }])) void chunk;
    };
    await expect(read()).rejects.toBeInstanceOf(AllowanceExhaustedError);
    expect(calls).toBe(0);
  });

  it('the user’s own key still works (BYOK is free, ADR 0251)', async () => {
    e.FREE_TOKEN_ALLOWANCE = 0;
    const sealed = sealToken('sk-own-key');
    await db
      .updateTable('users')
      .set({
        model_provider: 'openai',
        model_name: 'gpt-own',
        model_key_ciphertext: sealed.ciphertext,
        model_key_iv: sealed.iv,
        model_key_tag: sealed.tag,
      })
      .where('id', '=', userId)
      .execute();
    expect(await canUseAi(db, userId)).toBe(true);
    const llm = await getLlmForUser(db, userId, 'briefing');
    expect(llm.defaultModel).toBe('gpt-own');
  });

  it('billing off: nothing changes', async () => {
    e.BILLING_ENABLED = false;
    e.FREE_TOKEN_ALLOWANCE = 0;
    await (await getLlmForUser(db, userId, 'briefing')).complete([{ role: 'user', content: 'hi' }]);
    expect(calls).toBe(1);
  });
});
