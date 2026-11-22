/**
 * After every classifier pass the batch is stamped with the classifier
 * generation (and the model's bulk verdict where it gave one). That was one
 * UPDATE per thread in the batch; it is now one per verdict (none / yes / no).
 * What each thread ends up with must not change.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const N = 25;

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'stamp-mock',
    defaultModel: 'stamp-mock',
    supportsNativeTools: false,
    // t0..t9: bulk true, t10..t19: bulk false, t20..t24: no verdict at all.
    complete: async () =>
      JSON.stringify({
        assignments: Array.from({ length: 20 }, (_, i) => ({
          gmailThreadId: `t${i}`,
          path: ['Newsletters'],
          confidence: 0.9,
          action: 'informational',
          bulk: i < 10,
        })).concat(
          Array.from({ length: 5 }, (_, i) => ({
            gmailThreadId: `t${20 + i}`,
            path: ['Receipts'],
            confidence: 0.9,
            action: 'informational',
            bulk: undefined as unknown as boolean,
          })),
        ),
      }),
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

function countThreadUpdates(db: Kysely<DB>): { db: Kysely<DB>; n: () => number } {
  let n = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'updateTable') {
        return (table: string) => {
          if (table === 'email_threads') n += 1;
          return (target.updateTable as (t: string) => unknown).call(target, table);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Kysely<DB>;
  return { db: proxy, n: () => n };
}

describe('classifier pass stamping', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorClassifier: string;
  let priorBatch: number;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'stamp');
    priorClassifier = env.EMAIL_CLASSIFIER;
    priorBatch = env.EMAIL_CLASSIFIER_BATCH_SIZE;
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = 100;
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values(
        Array.from({ length: N }, (_, i) => ({
          id: newId('emt'),
          user_id: userId,
          gmail_thread_id: `t${i}`,
          subject: `Subject ${i}`,
          snippet: 'snippet',
          from_email: 'someone@example.com',
          last_message_at: now,
          // Never classified; and every thread starts with a bulk verdict of 1
          // so a thread the pass says nothing about must visibly stay at 1.
          classifier_version: 0,
          classified_at: null,
          bulk_inferred: 1,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
  });

  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = priorClassifier;
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = priorBatch;
    await closeTestDb(db);
  });

  it('stamps every thread in the batch with a few statements, and keeps each verdict', async () => {
    const { runLlmClassifier, CLASSIFIER_VERSION } = await import('@/services/email/llm-classifier.js');
    const counted = countThreadUpdates(db);
    await runLlmClassifier(counted.db, userId);

    // Three verdict groups, not 25 threads.
    expect(counted.n()).toBeLessThanOrEqual(3);

    const rows = await db
      .selectFrom('email_threads')
      .select(['gmail_thread_id', 'classifier_version', 'bulk_inferred'])
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(N);
    for (const r of rows) {
      const i = Number(r.gmail_thread_id.slice(1));
      expect(r.classifier_version).toBe(CLASSIFIER_VERSION);
      if (i < 10) expect(r.bulk_inferred).toBe(1);
      else if (i < 20) expect(r.bulk_inferred).toBe(0);
      else expect(r.bulk_inferred).toBe(1); // no verdict: left as it was
    }
  });
});
