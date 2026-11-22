/**
 * ADR 0324 / 0193 — an email pass on the user's OWN key records nothing.
 *
 * `trackPassCost().report()` used to write the `token_usage` row itself
 * whenever it had a db and a user id, without asking whose key ran the call.
 * So a BYOK user's classifier, suggestion and people passes counted against
 * an allowance they do not draw on. The row is now written by the model
 * Chord hands out (`getLlmForUser` wraps only Chord's key), so a model that
 * comes back unwrapped - the user's own - must leave no row.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('@/services/llm/factory.js', () => {
  // What getLlmForUser returns for a BYOK user: their provider, unwrapped,
  // reporting real usage like any provider does.
  const ownKey = {
    providerName: 'openai',
    defaultModel: 'their-own-model',
    supportsNativeTools: false,
    complete: async (_m: unknown, o?: { onUsage?: (u: { promptTokens: number; completionTokens: number }) => void }) => {
      o?.onUsage?.({ promptTokens: 1577, completionTokens: 6 });
      return JSON.stringify({ assignments: [] });
    },
    async *stream() {},
  };
  return {
    getLlm: () => ownKey,
    getLlmForUser: async () => ownKey,
    resolveTurnLlm: async () => ({ llm: ownKey, tier: 'byok' as const }),
  };
});

describe('an email pass on the user’s own key', () => {
  let db: Kysely<DB>;
  let userId: string;
  let prior: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'own-key-mail');
    prior = env.EMAIL_CLASSIFIER;
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
  });
  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = prior;
    await closeTestDb(db);
  });

  it('writes no token_usage row', async () => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
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
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);

    const rows = await db.selectFrom('token_usage').selectAll().where('user_id', '=', userId).execute();
    expect(rows).toEqual([]);
  });
});
