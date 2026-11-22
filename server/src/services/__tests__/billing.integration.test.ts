/**
 * ADR 0063/0194/0195/0196 — usage-derived entitlement. There is no separate
 * debit/grant step any more: `getEntitlement` computes a system-key
 * subscriber's remaining balance by summing `token_usage` since their
 * period started. Covers the computed-balance math, the ADR 0196 rule that
 * EVERY AI surface's usage counts (not just bot turns), the lapsed-period
 * cutoff, and the routing decision under BILLING_ENABLED.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { getEntitlement } from '@/services/billing.service.js';
import { recordTokenUsage } from '@/services/tokens.service.js';
import { resolveTurnLlm } from '@/services/llm/factory.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// ADR 0325 — these tests are about the plans' own rules (and back-date accounts
// to step past the old 30-day trial). The one-time free allowance would cover
// every gated case here, so it is switched off; billing-free-allowance covers it.
const savedFreeAllowance = env.FREE_TOKEN_ALLOWANCE;
beforeEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = 0;
});
afterEach(() => {
  (env as { FREE_TOKEN_ALLOWANCE: number }).FREE_TOKEN_ALLOWANCE = savedFreeAllowance;
});

function setBilling(on: boolean): void {
  (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = on;
}

/** Put a user on an ACTIVE system-plan subscription, period already started
 *  well in the past (clear of the trial window) and ending well in the
 *  future — the shape `invoice.paid` (ADR 0196) leaves on the user row. */
async function subscribe(db: Kysely<DB>, userId: string): Promise<void> {
  const now = Date.now();
  await db
    .updateTable('users')
    .set({
      created_at: new Date(now - 60 * 86_400_000).toISOString(), // 60 days ago — trial long over
      subscription_plan: 'system',
      subscription_period_started_at: new Date(now - 5 * 86_400_000).toISOString(),
      subscription_current_period_end: new Date(now + 25 * 86_400_000).toISOString(),
    })
    .where('id', '=', userId)
    .execute();
}

async function spend(db: Kysely<DB>, userId: string, tokens: number, source: 'bot_turn' | 'email_magics'): Promise<void> {
  await recordTokenUsage(db, {
    userId,
    source,
    ref: `spend-${Math.random()}`,
    model: 'gpt-x',
    promptTokens: tokens,
    completionTokens: 0,
  });
}

describe('usage-derived entitlement', () => {
  let db: Kysely<DB>;
  let uid: string;
  const original = env.BILLING_ENABLED;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'payer');
    setBilling(true);
  });
  afterEach(async () => {
    setBilling(original);
    await closeTestDb(db);
  });

  it('an active subscription with no usage yet is entitled for the full allowance', async () => {
    await subscribe(db, uid);
    const ent = await getEntitlement(db, uid);
    expect(ent).toMatchObject({ entitled: true, reason: 'tokens', balance: env.MONTHLY_TOKEN_ALLOWANCE });
  });

  it('balance is the allowance minus real usage since the period started', async () => {
    await subscribe(db, uid);
    await spend(db, uid, 1820, 'bot_turn');
    const ent = await getEntitlement(db, uid);
    expect(ent.balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 1820);
    expect(ent.entitled).toBe(true);
  });

  it('ADR 0196 — email AI pass usage counts against the SAME allowance as chat', async () => {
    await subscribe(db, uid);
    await spend(db, uid, 500, 'bot_turn');
    await spend(db, uid, 700, 'email_magics');
    const ent = await getEntitlement(db, uid);
    expect(ent.balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 1200);
  });

  it('is not entitled once usage reaches the allowance — even with zero chat spend', async () => {
    await subscribe(db, uid);
    await spend(db, uid, env.MONTHLY_TOKEN_ALLOWANCE, 'email_magics');
    const ent = await getEntitlement(db, uid);
    expect(ent).toMatchObject({ entitled: false, reason: 'none', balance: 0 });
  });

  it('usage before the CURRENT period started does not count (no rollover)', async () => {
    await subscribe(db, uid);
    // Spend, then simulate a new period starting after that old spend.
    await spend(db, uid, env.MONTHLY_TOKEN_ALLOWANCE, 'bot_turn');
    expect((await getEntitlement(db, uid)).entitled).toBe(false);
    await db
      .updateTable('users')
      .set({ subscription_period_started_at: new Date().toISOString() })
      .where('id', '=', uid)
      .execute();
    const ent = await getEntitlement(db, uid);
    expect(ent).toMatchObject({ entitled: true, reason: 'tokens', balance: env.MONTHLY_TOKEN_ALLOWANCE });
  });

  it('a lapsed period is not entitled even with plenty of unused allowance', async () => {
    await subscribe(db, uid);
    await db
      .updateTable('users')
      .set({ subscription_current_period_end: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', uid)
      .execute();
    const ent = await getEntitlement(db, uid);
    expect(ent).toMatchObject({ entitled: false, reason: 'none' });
  });

  it('no subscription on record at all is not entitled (no free allowance on this deploy)', async () => {
    await db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .where('id', '=', uid)
      .execute();
    const ent = await getEntitlement(db, uid);
    expect(ent).toMatchObject({ entitled: false, reason: 'none', balance: 0 });
  });
});

describe('resolveTurnLlm tiers', () => {
  let db: Kysely<DB>;
  let uid: string;
  const original = env.BILLING_ENABLED;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'router');
  });
  afterEach(async () => {
    setBilling(original);
    await closeTestDb(db);
  });

  it('billing OFF: a non-BYOK user is premium regardless of subscription state', async () => {
    setBilling(false);
    expect((await resolveTurnLlm(db, uid)).tier).toBe('premium');
    await subscribe(db, uid);
    expect((await resolveTurnLlm(db, uid)).tier).toBe('premium');
  });

  it('billing ON: premium while entitled; OSS-unconfigured falls back to premium once exhausted', async () => {
    setBilling(true);
    await subscribe(db, uid);
    expect((await resolveTurnLlm(db, uid)).tier).toBe('premium');

    await spend(db, uid, env.MONTHLY_TOKEN_ALLOWANCE, 'bot_turn');
    expect((await getEntitlement(db, uid)).entitled).toBe(false);
    // With no OSS_* configured (test default), the safety valve keeps them
    // on premium rather than blocking.
    expect((await resolveTurnLlm(db, uid)).tier).toBe('premium');
  });
});
