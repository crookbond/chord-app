/**
 * ADR 0342 — deleting an account takes its plan and its free tokens with it.
 *
 * Before: deleteAccount never called Stripe, so a subscriber who deleted their
 * account kept being charged every month (each invoice.paid found no user),
 * and an account made again with the same login got a fresh free allowance.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { deleteAccount, PlanNotCancelledError } from '@/services/account.service.js';
import { getEntitlement } from '@/services/billing.service.js';
import { __resetRenewalCacheForTests } from '@/services/stripe.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type MutableEnv = {
  BILLING_ENABLED: boolean;
  FREE_TOKEN_ALLOWANCE: number;
  STRIPE_SECRET_KEY: string;
  STRIPE_PRICE_ID_BYOK: string;
  AI_CONSENT_REQUIRED: boolean;
};
const mutable = env as unknown as MutableEnv;
const saved = { ...mutable };

const SUB = 'sub_1QxDeleteMe';

describe('deleting an account (ADR 0342)', () => {
  let db: Kysely<DB>;
  let stripeCalls: Array<{ method: string; url: string }>;
  let subscriptionStatus: string;
  let cancelStatus: number;

  const fakeStripe: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    stripeCalls.push({ method, url });
    if (method === 'DELETE') {
      return cancelStatus === 200
        ? Response.json({ id: SUB, status: 'canceled' })
        : Response.json({ error: { message: 'Stripe is down' } }, { status: cancelStatus });
    }
    return Response.json({ id: SUB, status: subscriptionStatus, cancel_at_period_end: false });
  };

  beforeEach(async () => {
    db = await openTestDb();
    mutable.BILLING_ENABLED = true;
    mutable.FREE_TOKEN_ALLOWANCE = 10_000_000;
    mutable.STRIPE_SECRET_KEY = 'sk_test_x';
    mutable.STRIPE_PRICE_ID_BYOK = '';
    mutable.AI_CONSENT_REQUIRED = false;
    stripeCalls = [];
    subscriptionStatus = 'active';
    cancelStatus = 200;
    __resetRenewalCacheForTests();
  });

  afterEach(async () => {
    Object.assign(mutable, saved);
    await closeTestDb(db);
  });

  const subscriber = async () => {
    const id = await createUser(db, 'payer', 'Pat Payer');
    await db
      .updateTable('users')
      .set({
        email: 'pat@example.com',
        stripe_customer_id: 'cus_pat',
        stripe_subscription_id: SUB,
        subscription_plan: 'system',
        subscription_interval: 'month',
        subscription_source: 'stripe',
        subscription_period_started_at: new Date(Date.now() - 86_400_000).toISOString(),
        subscription_current_period_end: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      })
      .where('id', '=', id)
      .execute();
    return id;
  };

  const exists = async (id: string) =>
    !!(await db.selectFrom('users').select('id').where('id', '=', id).executeTakeFirst());

  it('cancels a live Stripe plan before the account goes', async () => {
    const id = await subscriber();
    const out = await deleteAccount(db, id, fakeStripe);
    expect(out.stripePlanCancelled).toBe(true);
    expect(stripeCalls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([
      `https://api.stripe.com/v1/subscriptions/${SUB}`,
    ]);
    expect(await exists(id)).toBe(false);
  });

  it('deletes nothing when Stripe will not cancel the plan', async () => {
    const id = await subscriber();
    cancelStatus = 503;
    await expect(deleteAccount(db, id, fakeStripe)).rejects.toBeInstanceOf(PlanNotCancelledError);
    expect(await exists(id)).toBe(true);
    // The fingerprints are written with the deletion, so none were.
    expect(await db.selectFrom('spent_free_allowances').select('fingerprint').execute()).toHaveLength(0);
  });

  it('leaves a subscription Stripe already ended alone', async () => {
    const id = await subscriber();
    subscriptionStatus = 'canceled';
    const out = await deleteAccount(db, id, fakeStripe);
    expect(out.stripePlanCancelled).toBe(false);
    expect(stripeCalls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await exists(id)).toBe(false);
  });

  it('asks Stripe nothing for an account with no plan', async () => {
    const id = await createUser(db, 'free', 'Fran Free');
    const out = await deleteAccount(db, id, fakeStripe);
    expect(out.stripePlanCancelled).toBe(false);
    expect(stripeCalls).toHaveLength(0);
  });

  it('gives an account made again with the same login no free tokens', async () => {
    const first = await createUser(db, 'ann', 'Ann Lee');
    await db
      .updateTable('users')
      .set({ email: 'Ann@Example.com', google_sub: 'google-ann' })
      .where('id', '=', first)
      .execute();
    expect((await getEntitlement(db, first)).reason).toBe('free');
    await deleteAccount(db, first, fakeStripe);

    // Back with the same Google login (and the address in another case).
    const again = await createUser(db, 'ann2', 'Ann Lee');
    await db
      .updateTable('users')
      .set({ email: 'ann@example.com', google_sub: 'google-ann' })
      .where('id', '=', again)
      .execute();
    const ent = await getEntitlement(db, again);
    expect(ent.entitled).toBe(false);
    expect(ent.reason).toBe('none');
    expect(ent.free).toBeUndefined();
  });

  it('also catches a matching login linked after sign-up', async () => {
    const first = await createUser(db, 'bo', 'Bo Chen');
    await db.updateTable('users').set({ microsoft_sub: 'tid:oid-bo' }).where('id', '=', first).execute();
    await deleteAccount(db, first, fakeStripe);

    const again = await createUser(db, 'bo2', 'Bo Chen');
    expect((await getEntitlement(db, again)).reason).toBe('free');
    await db.updateTable('users').set({ microsoft_sub: 'tid:oid-bo' }).where('id', '=', again).execute();
    expect((await getEntitlement(db, again)).reason).toBe('none');
  });

  it('leaves someone with different logins their free tokens', async () => {
    const first = await createUser(db, 'cy', 'Cy Old');
    await db.updateTable('users').set({ email: 'cy@example.com' }).where('id', '=', first).execute();
    await deleteAccount(db, first, fakeStripe);

    const other = await createUser(db, 'dee', 'Dee New');
    await db.updateTable('users').set({ email: 'dee@example.com' }).where('id', '=', other).execute();
    expect((await getEntitlement(db, other)).reason).toBe('free');
  });

  it('does not count an unverified phone number as an identity', async () => {
    const first = await createUser(db, 'eve', 'Eve One');
    await db
      .updateTable('users')
      .set({ phone_number: '+15551230000', phone_hash: 'hash-555', phone_verified: 0 })
      .where('id', '=', first)
      .execute();
    await deleteAccount(db, first, fakeStripe);

    const again = await createUser(db, 'eve2', 'Eve Two');
    await db
      .updateTable('users')
      .set({ phone_number: '+15551230000', phone_hash: 'hash-555', phone_verified: 0 })
      .where('id', '=', again)
      .execute();
    expect((await getEntitlement(db, again)).reason).toBe('free');
  });
});
