/**
 * ADR 0079/0194/0196/0325 — a free token allowance, then the AI surface gates.
 * Entitlement matrix, the bot-turn gate (nudge instead of an LLM turn), free
 * turns spending the free allowance, paid usage computing a real remaining
 * balance, email afterSync passes skipped, and the proactive daily scan
 * retired-but-reseeded for unentitled users. "Gated" here means the free
 * allowance is spent (`spendFree`); the account's age no longer matters.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'mock',
    defaultModel: 'mock-model',
    supportsNativeTools: false,
    complete: async () => 'Sure — done!',
    async *stream(_messages: unknown, opts?: { onUsage?: (u: { promptTokens: number; completionTokens: number }) => void }) {
      opts?.onUsage?.({ promptTokens: 1, completionTokens: 0 });
      yield { type: 'text' as const, delta: 'Sure — done!' };
    },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
    getOssLlm: () => null,
  };
});

import { formatTokenCount } from '@chord/kernel';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { getEntitlement } from '@/services/billing.service.js';
import { runBotTurn } from '@/services/bot/bot.service.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { drainOnce, enqueueDailyScanForUserNow } from '@/services/proactive.service.js';
import { recordTokenUsage } from '@/services/tokens.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const THIRTY_ONE_DAYS_AGO = new Date(Date.now() - 31 * 86_400_000).toISOString();

describe('free allowance, then the gate (ADR 0079/0325)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    db = await openTestDb();
  });

  afterEach(async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    await closeTestDb(db);
  });

  const backdate = (userId: string) =>
    db
      .updateTable('users')
      .set({ created_at: THIRTY_ONE_DAYS_AGO })
      .where('id', '=', userId)
      .execute();

  /** Spend the whole ADR 0325 free allowance (an hour ago, inside the account's life). */
  const spendFree = async (userId: string) => {
    await backdate(userId);
    await db
      .insertInto('token_usage')
      .values({
        id: newId('tok'),
        user_id: userId,
        source: 'bot_turn',
        ref: 'spend-free',
        model: 'gpt-x',
        prompt_tokens: env.FREE_TOKEN_ALLOWANCE,
        completion_tokens: 0,
        total_tokens: env.FREE_TOKEN_ALLOWANCE,
        created_at: new Date(Date.now() - 3_600_000).toISOString(),
      })
      .execute();
  };

  // ADR 0196 — the shape `invoice.paid` leaves on the user row: no more
  // "grant N tokens", just the period's bounds. `periodStartedAt` defaults
  // to "now" so any usage already recorded before this call (e.g. a
  // trial-era turn) falls BEFORE the window and correctly doesn't count.
  const activateSubscription = (userId: string, periodStartedAt = new Date().toISOString()) =>
    db
      .updateTable('users')
      .set({
        subscription_plan: 'system',
        subscription_period_started_at: periodStartedAt,
        subscription_current_period_end: new Date(Date.now() + 25 * 86_400_000).toISOString(),
      })
      .where('id', '=', userId)
      .execute();

  const seedTrigger = async (userId: string, groupId: string) => {
    const id = newId('m');
    await db
      .insertInto('messages')
      .values({
        id,
        group_id: groupId,
        sender_id: userId,
        kind: 'text',
        body: '@Chord add milk to the list',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 1,
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
    return {
      id,
      groupId,
      senderId: userId,
      kind: 'text' as const,
      body: '@Chord add milk to the list',
      mentionsBot: true,
      createdAt: new Date().toISOString(),
    };
  };

  const botBodies = async (groupId: string) =>
    (
      await db
        .selectFrom('messages')
        .select('body')
        .where('group_id', '=', groupId)
        .where('kind', '=', 'bot')
        .execute()
    ).map((m) => m.body);

  it('entitlement matrix: free → tokens; a paid plan outranks the free allowance; billing-off passes', async () => {
    // The ranking under test needs a free allowance bigger than one paid month.
    const savedFree = env.FREE_TOKEN_ALLOWANCE;
    (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = env.MONTHLY_TOKEN_ALLOWANCE * 2;
    try {
    const userId = await createUser(db, 'trial-user');
    expect((await getEntitlement(db, userId)).reason).toBe('free');

    // Paying while still on the free allowance: the plan is what's reported
    // (it carries the period and the cancel button), not "Free".
    await activateSubscription(userId);
    expect(await getEntitlement(db, userId)).toMatchObject({ reason: 'tokens', plan: 'system' });

    // Spending that whole paid allowance: the free allowance (twice as big)
    // still covers it, and the plan stays on the card.
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: 'spend-all',
      model: 'gpt-x',
      promptTokens: env.MONTHLY_TOKEN_ALLOWANCE,
      completionTokens: 0,
    });
    expect(await getEntitlement(db, userId)).toMatchObject({ entitled: true, reason: 'free', plan: 'system' });

    // Once the free allowance is spent too, the spent plan is just spent.
    await spendFree(userId);
    expect(await getEntitlement(db, userId)).toMatchObject({ entitled: false, reason: 'none', plan: 'system' });

    const broke = await createUser(db, 'broke-user');
    await spendFree(broke);
    const ent = await getEntitlement(db, broke);
    expect(ent).toMatchObject({ entitled: false, reason: 'none' });

    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    expect((await getEntitlement(db, broke)).reason).toBe('billing_off');
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    } finally {
      (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = savedFree;
    }
  });

  it('free allowance spent with no plan: the turn is a nudge, not an LLM reply', async () => {
    const userId = await createUser(db, 'gated-user');
    await spendFree(userId);
    const group = await ensurePersonalGroup(db, userId);
    const trigger = await seedTrigger(userId, group.id);

    await runBotTurn(db, trigger, { id: group.id, kind: 'personal' });

    const bodies = await botBodies(group.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`used your ${formatTokenCount(env.FREE_TOKEN_ALLOWANCE)} free AI tokens`);
    expect(bodies[0]).not.toContain('trial');
    expect(bodies[0]).not.toContain('Sure — done!');
  });

  it('free turns spend the free allowance; paid usage debits the real allowance', async () => {
    const userId = await createUser(db, 'debit-user');
    const group = await ensurePersonalGroup(db, userId);

    // ADR 0325 — a free turn's usage comes out of the free allowance.
    await runBotTurn(db, await seedTrigger(userId, group.id), { id: group.id, kind: 'personal' });
    expect(await getEntitlement(db, userId)).toMatchObject({
      reason: 'free',
      balance: env.FREE_TOKEN_ALLOWANCE - 2,
      free: { allowance: env.FREE_TOKEN_ALLOWANCE, used: 2 },
    });

    await backdate(userId);
    // Period starts NOW, after the free turn above — that earlier usage
    // falls before the window and correctly doesn't count against it.
    await activateSubscription(userId);
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE);

    await runBotTurn(db, await seedTrigger(userId, group.id), { id: group.id, kind: 'personal' });
    // Mock reports 1 prompt token + 0 completion tokens per model run (see the
    // llm/factory.js mock above) — ADR 0196: recording usage IS the debit.
    // "add milk" is an imperative and the mock calls no tool, so the turn runs
    // the strict retry: two runs, both counted (ADR 0322).
    expect((await getEntitlement(db, userId)).balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 2);
  });

  it('afterSync AI passes skip for unentitled users (mail still mirrors)', async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'mock';

    const gated = await createUser(db, 'gated-mail');
    await spendFree(gated);
    const r1 = await backfillGmail(db, gated);
    expect(r1.inserted).toBeGreaterThan(0); // mirror works
    const cats = await db
      .selectFrom('email_categories')
      .select('id')
      .where('user_id', '=', gated)
      .execute();
    expect(cats).toHaveLength(0); // AI classification did not run

    const fresh = await createUser(db, 'trial-mail');
    await backfillGmail(db, fresh);
    const freshCats = await db
      .selectFrom('email_categories')
      .select('id')
      .where('user_id', '=', fresh)
      .execute();
    expect(freshCats.length).toBeGreaterThan(0); // a user on the free allowance still gets AI
  });

  it('gated daily scan posts a deterministic teaser (no LLM) and reseeds tomorrow', async () => {
    const userId = await createUser(db, 'gated-brief');
    await spendFree(userId);
    const group = await ensurePersonalGroup(db, userId);
    const row = await enqueueDailyScanForUserNow(db, userId);
    expect(row).not.toBeNull();

    await drainOnce(db);

    const bodies = await botBodies(group.id);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('A peek at your day');
    expect(bodies[0]).toContain('Read more');
    expect(bodies[0]).toContain('AI Plan');
    expect(bodies[0]).not.toContain('Sure — done!'); // the LLM never ran
    const fired = await db
      .selectFrom('proactive_messages')
      .select('fired_at')
      .where('id', '=', row!.id)
      .executeTakeFirstOrThrow();
    expect(fired.fired_at).not.toBeNull();
    const future = await db
      .selectFrom('proactive_messages')
      .select(['id', 'scheduled_for'])
      .where('persona_id', '=', userId)
      .where('kind', '=', 'daily_morning_scan')
      .where('fired_at', 'is', null)
      .execute();
    expect(future).toHaveLength(1); // full briefings resume when they pay
  });
});
