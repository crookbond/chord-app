/**
 * ADR 0332 — an allowance is a dollar budget (its tokens x
 * ALLOWANCE_USD_PER_MILLION_TOKENS), measured in the dollars OpenRouter
 * reports; the card still shows real tokens. Before this, the allowance was
 * raw tokens: a user whose turns were mostly cached prompt (billed at a
 * quarter of fresh input) ran out after ~$1.50 of real spend on a 10M ($4)
 * allowance, while nothing stopped calls that cost more per token.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getEntitlement } from '@/services/billing.service.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { __resetLlmCacheForTests, __setLlmForTests, getLlmForUser } from '@/services/llm/factory.js';
import { AllowanceExhaustedError } from '@/services/llm/refusal.js';
import type { LlmChunk, LlmCompleteOptions, LlmService, LlmTokenUsage } from '@/services/llm/types.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type MutableEnv = {
  BILLING_ENABLED: boolean;
  FREE_TOKEN_ALLOWANCE: number;
  ALLOWANCE_USD_PER_MILLION_TOKENS: number;
  STRIPE_PRICE_ID_BYOK: string;
  AI_CONSENT_REQUIRED: boolean;
};
const mutable = env as unknown as MutableEnv;
const saved = { ...mutable };

describe('the allowance is a dollar budget (ADR 0332)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    mutable.BILLING_ENABLED = true;
    mutable.FREE_TOKEN_ALLOWANCE = 10_000_000; // = $4 at $0.40 / M
    mutable.ALLOWANCE_USD_PER_MILLION_TOKENS = 0.4;
    mutable.STRIPE_PRICE_ID_BYOK = '';
    mutable.AI_CONSENT_REQUIRED = false;
  });

  afterEach(async () => {
    Object.assign(mutable, saved);
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  /** Signed up a day ago, so usage a minute old falls inside the free window. */
  const newUser = async (name: string) => {
    const id = await createUser(db, name);
    await db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 86_400_000).toISOString() })
      .where('id', '=', id)
      .execute();
    return id;
  };

  const spend = (userId: string, tokens: number, costUsd: number | null, cached: number | null = null) =>
    db
      .insertInto('token_usage')
      .values({
        id: newId('tok'),
        user_id: userId,
        source: 'bot_turn',
        ref: newId('ref'),
        model: 'openai/gpt-4.1-mini',
        prompt_tokens: tokens,
        completion_tokens: 0,
        total_tokens: tokens,
        cached_tokens: cached,
        cost_usd: costUsd,
        created_at: new Date(Date.now() - 60_000).toISOString(),
      })
      .execute();

  it('a mostly-cached user past 10M real tokens but under $4 still has AI, and the card shows real tokens', async () => {
    // 150 turns of 88k prompt, 80% cached: 13.2M tokens for about $2.11.
    const u = await newUser('cached');
    for (let i = 0; i < 150; i++) await spend(u, 88_000, 0.01408, 70_400);

    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: true, reason: 'free' });
    expect(ent.free?.used).toBe(13_200_000);
    // The $4 budget shown as tokens at this user's own $ per token: 25M.
    expect(ent.free?.allowance).toBe(25_000_000);
    expect(ent.remainingUsd).toBeCloseTo(4 - 150 * 0.01408, 6);

    const status = await getBillingStatus(db, u);
    expect(status.tokensUsedThisMonth).toBe(13_200_000);
    expect(status.tokensQuotaPerMonth).toBe(25_000_000);
  });

  it('a user whose calls cost more per token is stopped at $4, far under 10M tokens', async () => {
    const u = await newUser('dear');
    for (let i = 0; i < 40; i++) await spend(u, 50_000, 0.1); // 2M tokens, $4.00
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: false, reason: 'none', balance: 0 });
    expect(ent.free?.used).toBe(2_000_000);
    expect(ent.free?.allowance).toBe(2_000_000);
  });

  it('rows with no reported cost are priced at the allowance rate (same result as counting tokens)', async () => {
    const u = await newUser('legacy');
    await spend(u, 4_000_000, null);
    expect(await getEntitlement(db, u)).toMatchObject({
      entitled: true,
      balance: 6_000_000,
      free: { allowance: 10_000_000, used: 4_000_000 },
    });
  });

  it('one model handle stops calling once its own calls spent what was left', async () => {
    const u = await newUser('loop');
    await spend(u, 9_800_000, 3.95); // $0.05 left
    let calls = 0;
    const pricey: LlmService = {
      providerName: 'openai',
      defaultModel: 'fake',
      supportsNativeTools: false,
      async complete(_m, o?: LlmCompleteOptions) {
        calls++;
        o?.onUsage?.({ promptTokens: 90_000, completionTokens: 200, costUsd: 0.03 } satisfies LlmTokenUsage);
        return 'ok';
      },
      // eslint-disable-next-line require-yield
      async *stream(): AsyncIterable<LlmChunk> {
        throw new Error('unused');
      },
    };
    __setLlmForTests(pricey);
    const llm = await getLlmForUser(db, u, 'briefing');
    await llm.complete([{ role: 'user', content: 'a' }]); // $0.03 of $0.05
    await llm.complete([{ role: 'user', content: 'b' }]); // crosses: $0.06
    await expect(llm.complete([{ role: 'user', content: 'c' }])).rejects.toBeInstanceOf(AllowanceExhaustedError);
    expect(calls).toBe(2);
  });
});
