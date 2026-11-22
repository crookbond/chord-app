/**
 * PR-D.1 — getLlmForUser fallback semantics.
 *
 * Exercises the *real* factory (no `vi.mock`). Verifies that:
 *   1. No userId          → global env-default service.
 *   2. User w/o key       → global env-default service.
 *   3. User w/ valid key  → fresh per-user service with stored model.
 *   4. Corrupt blob       → graceful fallback to global, no throw.
 *
 * MASTER_KEY is set in beforeAll so seal/open works against the real
 * crypto helper. LLM_PROVIDER stays as `mock` from vitest config, so the
 * "global" path returns the MockLlmService. Per-user OpenAI/Gemini
 * services are constructed against the user's stored provider regardless
 * of the env default — that's the point.
 */
import { randomBytes } from 'node:crypto';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { getLlm, getLlmForUser } from '@/services/llm/factory.js';
import { sealToken } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function log(label: string, payload: object): void {
  // Vitest surfaces console.log during test runs — useful for the user's
  // post-run log paste.
  console.log(`[byok] ${label}`, JSON.stringify(payload));
}

let db: Kysely<DB>;
let originalMasterKey: string | undefined;

beforeAll(() => {
  originalMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
});

afterAll(() => {
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = originalMasterKey;
});

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('getLlmForUser — PR-D.1 fallback semantics', () => {
  it('null userId returns the global cached LLM', async () => {
    const global = getLlm();
    const resolved = await getLlmForUser(db, null, 'bot_turn');
    log('null-userId', { global: global.providerName, resolved: resolved.providerName });
    expect(resolved).toBe(global);
  });

  it('user with no stored key returns the global cached LLM', async () => {
    const uid = await createUser(db);
    const global = getLlm();
    const resolved = await getLlmForUser(db, uid, 'bot_turn');
    log('no-key', {
      uid,
      global: global.providerName,
      resolved: resolved.providerName,
    });
    // ADR 0324: Chord's model, wrapped so the call records its tokens.
    expect(resolved.providerName).toBe(global.providerName);
    expect(resolved.defaultModel).toBe(global.defaultModel);
  });

  it('user with stored OpenAI key returns a fresh OpenAI service with stored model', async () => {
    const uid = await createUser(db);
    const sealed = sealToken('sk-fake-byok-test-key');
    await db
      .updateTable('users')
      .set({
        model_provider: 'openai',
        model_name: 'gpt-byok-fake',
        model_key_ciphertext: sealed.ciphertext,
        model_key_iv: sealed.iv,
        model_key_tag: sealed.tag,
      })
      .where('id', '=', uid)
      .execute();

    const global = getLlm();
    const resolved = await getLlmForUser(db, uid, 'bot_turn');
    log('with-openai-key', {
      uid,
      globalProvider: global.providerName,
      globalModel: global.defaultModel,
      resolvedProvider: resolved.providerName,
      resolvedModel: resolved.defaultModel,
      isFreshInstance: resolved !== global,
    });
    expect(resolved).not.toBe(global);
    expect(resolved.providerName).toBe('openai');
    expect(resolved.defaultModel).toBe('gpt-byok-fake');
  });

  it('user with stored Gemini key returns a fresh Gemini service', async () => {
    const uid = await createUser(db);
    const sealed = sealToken('gemini-fake-byok-key');
    await db
      .updateTable('users')
      .set({
        model_provider: 'gemini',
        model_name: 'gemini-byok-fake',
        model_key_ciphertext: sealed.ciphertext,
        model_key_iv: sealed.iv,
        model_key_tag: sealed.tag,
      })
      .where('id', '=', uid)
      .execute();

    const resolved = await getLlmForUser(db, uid, 'bot_turn');
    log('with-gemini-key', {
      uid,
      provider: resolved.providerName,
      model: resolved.defaultModel,
    });
    expect(resolved.providerName).toBe('gemini');
    expect(resolved.defaultModel).toBe('gemini-byok-fake');
  });

  it('user with stored Anthropic key returns a fresh Anthropic service', async () => {
    const uid = await createUser(db);
    const sealed = sealToken('sk-ant-fake-byok-key');
    await db
      .updateTable('users')
      .set({
        model_provider: 'anthropic',
        model_name: 'claude-byok-fake',
        model_key_ciphertext: sealed.ciphertext,
        model_key_iv: sealed.iv,
        model_key_tag: sealed.tag,
      })
      .where('id', '=', uid)
      .execute();

    const resolved = await getLlmForUser(db, uid, 'bot_turn');
    log('with-anthropic-key', {
      uid,
      provider: resolved.providerName,
      model: resolved.defaultModel,
    });
    expect(resolved.providerName).toBe('anthropic');
    expect(resolved.defaultModel).toBe('claude-byok-fake');
  });

  it('corrupt key blob falls back to global without throwing', async () => {
    const uid = await createUser(db);
    // valid sizes (12-byte iv, 16-byte tag) but garbage bytes — auth tag
    // mismatch should fail decrypt cleanly inside the factory.
    await db
      .updateTable('users')
      .set({
        model_provider: 'openai',
        model_name: 'gpt-corrupt',
        model_key_ciphertext: Buffer.from([1, 2, 3, 4, 5]),
        model_key_iv: Buffer.alloc(12, 0xab),
        model_key_tag: Buffer.alloc(16, 0xcd),
      })
      .where('id', '=', uid)
      .execute();

    const global = getLlm();
    const resolved = await getLlmForUser(db, uid, 'bot_turn');
    log('corrupt-key-fallback', {
      uid,
      provider: resolved.providerName,
      fellBack: resolved === global,
    });
    // ADR 0324: Chord's model, wrapped so the call records its tokens.
    expect(resolved.providerName).toBe(global.providerName);
    expect(resolved.defaultModel).toBe(global.defaultModel);
  });
});
