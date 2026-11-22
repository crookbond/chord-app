/**
 * ADR 0236 — "cancel my subscription" is sayable in chat, and means exactly
 * what the Settings button means: stop renewing at the end of the period
 * already paid for. Only the Stripe call is stubbed.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetRenewalCacheForTests } from '@/services/stripe.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY = 86_400_000;

describe('set_subscription_renewal', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let calls: Array<{ url: string; body: string }>;
  const realFetch = globalThis.fetch;
  const periodEnd = new Date(Date.now() + 12 * DAY).toISOString();

  beforeEach(async () => {
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = 'sk_test_x';
    __resetRenewalCacheForTests();
    calls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      calls.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          id: 'sub_chat',
          cancel_at_period_end: new URLSearchParams(body).get('cancel_at_period_end') === 'true',
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    db = await openTestDb();
    userId = await createUser(db, 'asker');
    personalId = (await ensurePersonalGroup(db, userId)).id;
    await db
      .updateTable('users')
      .set({
        stripe_subscription_id: 'sub_chat',
        subscription_plan: 'system',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - 18 * DAY).toISOString(),
        subscription_current_period_end: periodEnd,
      })
      .where('id', '=', userId)
      .execute();
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    (env as { STRIPE_SECRET_KEY: string }).STRIPE_SECRET_KEY = '';
    await closeTestDb(db);
  });

  const ask = (renew: boolean, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      call: { name: 'set_subscription_renewal', args: { renew } },
    });

  it('cancels at the period end and says when the plan stops', async () => {
    const out = await ask(false);
    expect(out.data).toEqual({ ok: true, cancelsAtPeriodEnd: true, periodEnd });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.stripe.com/v1/subscriptions/sub_chat');
    expect(new URLSearchParams(calls[0]!.body).get('cancel_at_period_end')).toBe('true');
  });

  it('resumes', async () => {
    const out = await ask(true);
    expect(out.data).toEqual({ ok: true, cancelsAtPeriodEnd: false, periodEnd });
    expect(new URLSearchParams(calls[0]!.body).get('cancel_at_period_end')).toBe('false');
  });

  it('is personal-chat only: a shared group cannot cancel someone’s plan', async () => {
    const gid = (await createGroup(db, { name: 'Soccer', kind: 'group', createdBy: userId })).id;
    const out = await ask(false, gid);
    expect(out.data).toMatchObject({ ok: false, reason: 'personal_only' });
    expect(calls).toHaveLength(0);
  });

  it('claims nothing when there is no plan of their own to cancel', async () => {
    await db
      .updateTable('users')
      .set({ subscription_plan: null, subscription_current_period_end: null })
      .where('id', '=', userId)
      .execute();
    const out = await ask(false);
    expect(out.data).toEqual({ ok: false, reason: 'no_subscription' });
    expect(calls).toHaveLength(0);
  });
});
