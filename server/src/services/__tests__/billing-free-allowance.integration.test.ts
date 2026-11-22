/**
 * ADR 0325 — the 30-day trial is replaced by a one-time free allowance of
 * FREE_TOKEN_ALLOWANCE tokens per account, counted from sign-up with no time
 * limit, for every account including ones whose trial already ended.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { gatedTurnMessage, getEntitlement } from '@/services/billing.service.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type MutableEnv = {
  BILLING_ENABLED: boolean;
  FREE_TOKEN_ALLOWANCE: number;
  STRIPE_PRICE_ID_BYOK: string;
  AI_CONSENT_REQUIRED: boolean;
};
const mutable = env as unknown as MutableEnv;
const saved = { ...mutable };
const DAY = 86_400_000;
const ALLOWANCE = 10_000_000;

describe('one-time free token allowance (ADR 0325)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    mutable.BILLING_ENABLED = true;
    mutable.FREE_TOKEN_ALLOWANCE = ALLOWANCE;
    mutable.STRIPE_PRICE_ID_BYOK = '';
    mutable.AI_CONSENT_REQUIRED = false;
  });

  afterEach(async () => {
    Object.assign(mutable, {
      BILLING_ENABLED: saved.BILLING_ENABLED,
      FREE_TOKEN_ALLOWANCE: saved.FREE_TOKEN_ALLOWANCE,
      STRIPE_PRICE_ID_BYOK: saved.STRIPE_PRICE_ID_BYOK,
      AI_CONSENT_REQUIRED: saved.AI_CONSENT_REQUIRED,
    });
    await closeTestDb(db);
  });

  const signedUpDaysAgo = (userId: string, days: number) =>
    db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - days * DAY).toISOString() })
      .where('id', '=', userId)
      .execute();

  /** A user who signed up `days` ago (so usage can be dated inside their life). */
  const newUser = async (name: string, days = 30) => {
    const id = await createUser(db, name);
    await signedUpDaysAgo(id, days);
    return id;
  };

  const spend = (userId: string, tokens: number, daysAgo = 0) =>
    db
      .insertInto('token_usage')
      .values({
        id: newId('tok'),
        user_id: userId,
        source: 'bot_turn',
        ref: newId('ref'),
        model: 'gpt-x',
        prompt_tokens: tokens,
        completion_tokens: 0,
        total_tokens: tokens,
        created_at: new Date(Date.now() - daysAgo * DAY - 60_000).toISOString(),
      })
      .execute();

  it('is entitled while total usage since sign-up is under the allowance, and gated at or over it', async () => {
    const under = await newUser('under');
    await spend(under, 3_000_000, 2);
    await spend(under, 1_000_000);
    expect(await getEntitlement(db, under)).toMatchObject({
      entitled: true,
      reason: 'free',
      balance: 6_000_000,
      allowance: ALLOWANCE,
      free: { allowance: ALLOWANCE, used: 4_000_000 },
    });

    const at = await newUser('at');
    await spend(at, ALLOWANCE);
    expect(await getEntitlement(db, at)).toMatchObject({
      entitled: false,
      reason: 'none',
      balance: 0,
      free: { allowance: ALLOWANCE, used: ALLOWANCE },
    });

    const over = await newUser('over');
    await spend(over, ALLOWANCE + 1);
    expect(await getEntitlement(db, over)).toMatchObject({ entitled: false, reason: 'none' });
  });

  it('an account whose 30-day trial ended without a plan gets AI back while it has used under 10M', async () => {
    // The real shape: signed up months ago, used a little during the trial,
    // then met the paywall. The old rule gated this account on its age alone.
    const lapsed = await createUser(db, 'lapsed-trial');
    await signedUpDaysAgo(lapsed, 95);
    await spend(lapsed, 850_000, 80);
    expect(await getEntitlement(db, lapsed)).toMatchObject({
      entitled: true,
      reason: 'free',
      balance: ALLOWANCE - 850_000,
    });

    // A heavy trial user is past the allowance and stays gated.
    const heavy = await createUser(db, 'heavy-trial');
    await signedUpDaysAgo(heavy, 95);
    await spend(heavy, 12_000_000, 70);
    expect(await getEntitlement(db, heavy)).toMatchObject({ entitled: false, reason: 'none' });
  });

  it('counts only usage since sign-up, so moving created_at forward gives the allowance back', async () => {
    const u = await newUser('reset');
    await spend(u, ALLOWANCE, 10);
    expect((await getEntitlement(db, u)).entitled).toBe(false);
    await signedUpDaysAgo(u, 1);
    expect(await getEntitlement(db, u)).toMatchObject({ entitled: true, reason: 'free', balance: ALLOWANCE });
  });

  it('a paid plan with room outranks the free allowance', async () => {
    const u = await createUser(db, 'paid');
    await db
      .updateTable('users')
      .set({
        subscription_plan: 'system',
        subscription_interval: 'month',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - DAY).toISOString(),
        subscription_current_period_end: new Date(Date.now() + 29 * DAY).toISOString(),
      })
      .where('id', '=', u)
      .execute();
    expect(await getEntitlement(db, u)).toMatchObject({
      entitled: true,
      reason: 'tokens',
      plan: 'system',
      balance: env.MONTHLY_TOKEN_ALLOWANCE,
    });
  });

  it('leaves bring-your-own-key users alone: no free allowance on the key path', async () => {
    const u = await createUser(db, 'byok');
    await signedUpDaysAgo(u, 90);
    await db.updateTable('users').set({ model_key_ciphertext: Buffer.from('x') }).where('id', '=', u).execute();
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: true, reason: 'byok' });
    expect(ent.free).toBeUndefined();

    // With a base fee configured, the free tokens do not waive it (a key user
    // spends none of them, so they would never run out) — new account or old.
    mutable.STRIPE_PRICE_ID_BYOK = 'price_byok';
    const fresh = await createUser(db, 'byok-new');
    await db.updateTable('users').set({ model_key_ciphertext: Buffer.from('x') }).where('id', '=', fresh).execute();
    expect(await getEntitlement(db, fresh)).toMatchObject({ entitled: false, reason: 'byok_unpaid' });
  });

  it('FREE_TOKEN_ALLOWANCE=0 turns the free allowance off', async () => {
    mutable.FREE_TOKEN_ALLOWANCE = 0;
    const u = await createUser(db, 'none');
    const ent = await getEntitlement(db, u);
    expect(ent).toMatchObject({ entitled: false, reason: 'none' });
    expect(ent.free).toBeUndefined();
    expect(gatedTurnMessage(ent)).toContain('needs a plan');
  });

  it('billing status reports the free allowance, never a trial end date', async () => {
    const u = await newUser('status');
    await spend(u, 2_500_000);
    const status = await getBillingStatus(db, u);
    expect(status).toMatchObject({
      entitlement: 'free',
      balance: ALLOWANCE - 2_500_000,
      freeTokens: { allowance: ALLOWANCE, used: 2_500_000 },
      tokensUsedThisMonth: 2_500_000,
      tokensQuotaPerMonth: ALLOWANCE,
    });
    expect(status).not.toHaveProperty('trialEndsAt');
  });
});
