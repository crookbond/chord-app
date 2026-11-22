/**
 * ADR 0324 — a model call on Chord's key for a user writes a `token_usage`
 * row (the allowance, ADR 0196); a call on the user's own key writes none
 * (ADR 0193). Before this, only chat turns and the email passes wrote rows:
 * the briefing, nudges, memory extraction, attachment reading, the upload
 * classifiers, form filling, meeting context and WhatsApp import were free
 * to the user and invisible in their usage.
 */
import { randomBytes } from 'node:crypto';
import { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { env } from '@/config/env.js';
import { __resetLlmCacheForTests, __setLlmForTests, getLlmForUser, resolveTurnLlm } from '@/services/llm/factory.js';
import { newId } from '@/utils/ids.js';
import type { LlmChunk, LlmCompleteOptions, LlmService, LlmTokenUsage } from '@/services/llm/types.js';
import { meteredSource, withUsageRecording } from '@/services/llm/usage-recording.js';
import { sealToken } from '@/utils/crypto-tokens.js';
import { getTokenUsageSince } from '@/services/tokens.service.js';

/** A provider that reports usage the way the real ones do: once per call. */
function reportingLlm(usage: LlmTokenUsage | null, opts: { native?: boolean; fail?: boolean } = {}): LlmService {
  return {
    providerName: 'openai',
    defaultModel: 'fake-model',
    supportsNativeTools: opts.native ?? false,
    async complete(_m, o?: LlmCompleteOptions) {
      if (usage) o?.onUsage?.(usage);
      if (opts.fail) throw new Error('provider down');
      return 'ok';
    },
    async *stream(_m, o?: LlmCompleteOptions): AsyncIterable<LlmChunk> {
      yield { type: 'text', delta: 'hello' };
      if (usage) o?.onUsage?.(usage);
      yield { type: 'done', reason: 'stop' };
    },
  };
}

const rows = (db: Kysely<DB>, userId: string) =>
  db.selectFrom('token_usage').selectAll().where('user_id', '=', userId).orderBy('created_at').execute();

let originalMasterKey: string | undefined;
beforeAll(() => {
  originalMasterKey = process.env.MASTER_KEY;
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
});
afterAll(() => {
  if (originalMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = originalMasterKey;
});

describe('withUsageRecording', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'metered');
  });
  afterEach(async () => {
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  it('records a complete() call under its source, and still tells the caller', async () => {
    const seenByCaller: LlmTokenUsage[] = [];
    const llm = withUsageRecording(reportingLlm({ promptTokens: 120, completionTokens: 30 }), db, userId, 'briefing');
    await llm.complete([{ role: 'user', content: 'hi' }], { onUsage: (u) => seenByCaller.push(u) });

    const r = await rows(db, userId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'briefing', model: 'fake-model', prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 });
    expect(seenByCaller).toEqual([{ promptTokens: 120, completionTokens: 30 }]);
  });

  it('ADR 0332: keeps the dollar cost and cached count the provider reported; the allowance still counts every token', async () => {
    // A bot-turn shaped call as OpenRouter bills it: most of the prompt cached.
    const llm = withUsageRecording(
      reportingLlm({ promptTokens: 88_000, completionTokens: 400, cachedTokens: 70_400, costUsd: 0.01472 }),
      db,
      userId,
      'briefing',
    );
    await llm.complete([{ role: 'user', content: 'hi' }]);

    const r = await rows(db, userId);
    expect(r[0]).toMatchObject({ prompt_tokens: 88_000, completion_tokens: 400, total_tokens: 88_400, cached_tokens: 70_400 });
    expect(r[0].cost_usd).toBeCloseTo(0.01472, 8);
    expect(await getTokenUsageSince(db, userId, new Date(0).toISOString())).toBe(88_400);
  });

  it('ADR 0332: a provider that reports no cost leaves cost and cached empty, not zero', async () => {
    const llm = withUsageRecording(reportingLlm({ promptTokens: 10, completionTokens: 5 }), db, userId, 'briefing');
    await llm.complete([{ role: 'user', content: 'hi' }]);
    const r = await rows(db, userId);
    expect(r[0].cost_usd).toBeNull();
    expect(r[0].cached_tokens).toBeNull();
  });

  it('records a stream() call once it has been read to the end', async () => {
    const llm = withUsageRecording(reportingLlm({ promptTokens: 900, completionTokens: 100 }), db, userId, 'briefing');
    let text = '';
    for await (const c of llm.stream([{ role: 'user', content: 'hi' }], { model: 'asked-model' })) {
      if (c.type === 'text') text += c.delta;
    }
    expect(text).toBe('hello');
    const r = await rows(db, userId);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'briefing', model: 'asked-model', total_tokens: 1000 });
  });

  it('records nothing when the provider reported nothing (unmeasured is not free)', async () => {
    const llm = withUsageRecording(reportingLlm(null), db, userId, 'nudge');
    await llm.complete([{ role: 'user', content: 'hi' }]);
    expect(await rows(db, userId)).toHaveLength(0);
  });

  it('records what was reported even when the call then failed', async () => {
    const llm = withUsageRecording(reportingLlm({ promptTokens: 5, completionTokens: 0 }, { fail: true }), db, userId, 'nudge');
    await expect(llm.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('provider down');
    expect(await rows(db, userId)).toHaveLength(1);
  });
});

describe('getLlmForUser meters Chord’s key and never the user’s', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  it('Chord’s key records every call under the source asked for', async () => {
    const uid = await createUser(db, 'chord-key');
    __setLlmForTests(reportingLlm({ promptTokens: 40, completionTokens: 2 }));
    const llm = await getLlmForUser(db, uid, 'memory_extract');
    expect(meteredSource(llm)).toBe('memory_extract');
    await llm.complete([{ role: 'user', content: 'hi' }]);
    await llm.complete([{ role: 'user', content: 'again' }]);
    expect((await rows(db, uid)).map((r) => r.source)).toEqual(['memory_extract', 'memory_extract']);
  });

  it('the user’s own key records nothing', async () => {
    const uid = await createUser(db, 'own-key');
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
      .where('id', '=', uid)
      .execute();
    const llm = await getLlmForUser(db, uid, 'briefing');
    expect(llm.defaultModel).toBe('gpt-own');
    expect(meteredSource(llm)).toBeNull();
  });

  it('no user, nobody to charge: not metered', async () => {
    const llm = await getLlmForUser(db, null, 'briefing');
    expect(meteredSource(llm)).toBeNull();
  });
});

describe('each path records exactly once', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    __resetLlmCacheForTests();
    await closeTestDb(db);
  });

  it('an email pass on Chord’s key writes one row, not one from the wrapper and one from trackPassCost', async () => {
    const uid = await createUser(db, 'mail-once');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: uid,
        gmail_thread_id: 't1',
        subject: 'Field trip form',
        snippet: 'Please sign',
        from_email: 'teacher@school.org',
        last_message_at: now,
        classifier_version: 0,
        classified_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const prior = env.EMAIL_CLASSIFIER;
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
    try {
      const fake = reportingLlm({ promptTokens: 1577, completionTokens: 6 });
      __setLlmForTests({ ...fake, complete: async (m, o) => (await fake.complete(m, o), JSON.stringify({ assignments: [] })) });
      const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
      await runLlmClassifier(db, uid);
    } finally {
      (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = prior;
    }
    const r = await rows(db, uid);
    expect(r.map((x) => [x.source, x.total_tokens])).toEqual([['email_classify', 1583]]);
  });

  it('resolveTurnLlm (chat turn, composer, tldr, Findings, memory clean-up) is never wrapped: those record themselves', async () => {
    const uid = await createUser(db, 'turn-once');
    __setLlmForTests(reportingLlm({ promptTokens: 10, completionTokens: 1 }));
    const { llm } = await resolveTurnLlm(db, uid);
    expect(meteredSource(llm)).toBeNull();
    await llm.complete([{ role: 'user', content: 'hi' }]);
    expect(await rows(db, uid)).toHaveLength(0);
  });
});
