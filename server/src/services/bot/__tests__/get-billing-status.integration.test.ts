/**
 * ADR 0196 — "do I have a subscription" / "how much AI have I used" must
 * answer from the exact same data Settings shows, not a separate
 * computation the bot tool happens to agree with. `get_billing_status`
 * calls the same `getBillingStatus()` `GET /me/billing` uses.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { recordTokenUsage } from '@/services/tokens.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('get_billing_status', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  const originalBillingEnabled = env.BILLING_ENABLED;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'asker');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = originalBillingEnabled;
    await closeTestDb(db);
  });

  function ask() {
    return applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'get_billing_status', args: {} },
    });
  }

  it('returns exactly what GET /me/billing would — billing off, current deployment default', async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    const direct = await getBillingStatus(db, userId);
    const result = await ask();
    expect(result.data).toEqual(direct);
    expect(direct.entitlement).toBe('billing_off');
  });

  it('reports real usage even under billing_off — the counter is not tied to being charged', async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    await recordTokenUsage(db, {
      userId,
      source: 'email_magics',
      ref: 'usage-1',
      model: 'gpt-x',
      promptTokens: 4200,
      completionTokens: 100,
    });
    const result = await ask();
    const data = result.data as { tokensUsedThisMonth?: number };
    expect(data.tokensUsedThisMonth).toBe(4300);
  });

  it('reports an active system subscription and its real balance', async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    await db
      .updateTable('users')
      .set({
        created_at: new Date(Date.now() - 60 * 86_400_000).toISOString(),
        subscription_plan: 'system',
        subscription_period_started_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        subscription_current_period_end: new Date(Date.now() + 25 * 86_400_000).toISOString(),
      })
      .where('id', '=', userId)
      .execute();
    await recordTokenUsage(db, {
      userId,
      source: 'bot_turn',
      ref: 'usage-2',
      model: 'gpt-x',
      promptTokens: 1000,
      completionTokens: 0,
    });
    const result = await ask();
    const data = result.data as { entitlement?: string; balance: number; tokensUsedThisMonth?: number };
    expect(data.entitlement).toBe('tokens');
    expect(data.balance).toBe(env.MONTHLY_TOKEN_ALLOWANCE - 1000);
    expect(data.tokensUsedThisMonth).toBe(1000);
  });

  it('degrades gracefully with no actor rather than throwing', async () => {
    const result = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: null,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'get_billing_status', args: {} },
    });
    expect(result.data).toBeNull();
  });
});
