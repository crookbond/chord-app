/**
 * A bot turn has already read consent and entitlement before it picks the
 * model; resolveTurnLlm takes those answers instead of asking the database
 * again, and without them still reads both itself.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { AiConsentRequiredError } from '@/services/ai-consent.service.js';
import type { Entitlement } from '@/services/billing.service.js';
import { __resetLlmCacheForTests, resolveTurnLlm } from '@/services/llm/factory.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

type MutableEnv = {
  AI_CONSENT_REQUIRED: boolean;
  BILLING_ENABLED: boolean;
  FREE_TOKEN_ALLOWANCE: number;
  OSS_API_KEY: string;
  OSS_BASE_URL: string;
  OSS_MODEL: string;
};
const mutable = env as unknown as MutableEnv;
const saved = { ...mutable };

let db: Kysely<DB>;
let uid: string;

beforeEach(async () => {
  db = await openTestDb();
  uid = await createUser(db, 'known');
});

afterEach(async () => {
  Object.assign(mutable, {
    AI_CONSENT_REQUIRED: saved.AI_CONSENT_REQUIRED,
    BILLING_ENABLED: saved.BILLING_ENABLED,
    FREE_TOKEN_ALLOWANCE: saved.FREE_TOKEN_ALLOWANCE,
    OSS_API_KEY: saved.OSS_API_KEY,
    OSS_BASE_URL: saved.OSS_BASE_URL,
    OSS_MODEL: saved.OSS_MODEL,
  });
  __resetLlmCacheForTests();
  await closeTestDb(db);
});

describe('resolveTurnLlm with answers already in hand', () => {
  it('uses a consent the caller already checked, and reads it itself otherwise', async () => {
    mutable.AI_CONSENT_REQUIRED = true;
    const unasked = await resolveTurnLlm(db, uid);
    await expect(unasked.llm.complete([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      AiConsentRequiredError,
    );
    const known = await resolveTurnLlm(db, uid, { consented: true });
    await expect(known.llm.complete([{ role: 'user', content: 'hi' }])).resolves.toBeTypeOf('string');
  });

  it('uses an entitlement the caller already read', async () => {
    mutable.AI_CONSENT_REQUIRED = false;
    mutable.BILLING_ENABLED = true;
    // No free allowance on this deploy, so the user has nothing to spend.
    mutable.FREE_TOKEN_ALLOWANCE = 0;
    mutable.OSS_API_KEY = 'k';
    mutable.OSS_BASE_URL = 'http://127.0.0.1:9/v1';
    mutable.OSS_MODEL = 'oss-test';
    __resetLlmCacheForTests();
    await db
      .updateTable('users')
      .set({ created_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .where('id', '=', uid)
      .execute();

    expect((await resolveTurnLlm(db, uid)).tier).toBe('oss');
    const entitlement: Entitlement = {
      entitled: true,
      reason: 'tokens',
      balance: 10,
      allowance: 10,
    };
    expect((await resolveTurnLlm(db, uid, { entitlement })).tier).toBe('premium');
  });
});
