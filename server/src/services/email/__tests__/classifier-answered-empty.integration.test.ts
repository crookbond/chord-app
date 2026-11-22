/**
 * Prod, 2026-09-27: one user's classifier sent the SAME 9 never-classified
 * threads (1,577 prompt tokens, ~6 completion tokens) to the model 562 times
 * in a day, another the same 34 threads 217 times — 1.6M tokens a day, every
 * one of them recorded against the user's allowance. The model answered with
 * no usable assignments ("llm classifier returned no usable assignments"),
 * the pass stamped only `classifier_version`, and `selectBatch` re-picks any
 * thread whose `classified_at` is NULL. A pass that answered must take the
 * thread out of the queue even when the answer was empty — including when a
 * later pass ingests a snapshot that does not mention it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const sent: string[][] = [];
let answer: (ids: string[]) => unknown = () => ({ assignments: [] });

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'empty-answer-mock',
    defaultModel: 'empty-answer-mock',
    supportsNativeTools: false,
    complete: async (messages: { role: string; content: string }[]) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '{}';
      const ids = (JSON.parse(user) as { threads: { gmailThreadId: string }[] }).threads.map(
        (t) => t.gmailThreadId,
      );
      sent.push(ids);
      return JSON.stringify(answer(ids));
    },
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

describe('a classifier pass that answered with nothing', () => {
  let db: Kysely<DB>;
  let userId: string;
  let prior: { classifier: string; batch: number };

  beforeEach(async () => {
    sent.length = 0;
    answer = () => ({ assignments: [] });
    db = await openTestDb();
    userId = await createUser(db, 'empty-answer');
    prior = { classifier: env.EMAIL_CLASSIFIER, batch: env.EMAIL_CLASSIFIER_BATCH_SIZE };
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = 40;
  });

  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = prior.classifier;
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = prior.batch;
    await closeTestDb(db);
  });

  /** A never-classified thread, as sync leaves it. */
  const seed = async (gids: string[]): Promise<void> => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values(
        gids.map((gid) => ({
          id: newId('emt'),
          user_id: userId,
          gmail_thread_id: gid,
          subject: `Subject ${gid}`,
          snippet: 'snippet',
          from_email: 'someone@example.com',
          last_message_at: now,
          classifier_version: 0,
          classified_at: null,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
  };

  it('does not send the same never-classified threads to the model again', async () => {
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    const nine = Array.from({ length: 9 }, (_, i) => `t${i}`);
    await seed(nine);

    await runLlmClassifier(db, userId);
    expect(sent).toHaveLength(1);
    expect([...sent[0]!].sort()).toEqual([...nine].sort());

    // Every later tick is a no-op, not another model call.
    await runLlmClassifier(db, userId);
    await runLlmClassifier(db, userId);
    expect(sent).toHaveLength(1);
  });

  it('keeps an omitted thread out of the queue when a later pass ingests', async () => {
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await seed(['t_kept', 't_skipped']);
    // The model files one thread and says nothing about the other.
    answer = (ids) => ({
      assignments: ids
        .filter((id) => id === 't_kept' || id === 't_new')
        .map((id) => ({
          gmailThreadId: id,
          path: ['Receipts'],
          confidence: 0.9,
          action: 'informational',
        })),
    });

    await runLlmClassifier(db, userId);
    expect(sent).toHaveLength(1);

    // New mail arrives; its pass ingests a whole-mailbox snapshot that does
    // not mention t_skipped. That must not put t_skipped back in the queue.
    await seed(['t_new']);
    await runLlmClassifier(db, userId);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(['t_new']);

    await runLlmClassifier(db, userId);
    expect(sent).toHaveLength(2);

    const kept = await db
      .selectFrom('email_threads')
      .select('category_id')
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_kept')
      .executeTakeFirstOrThrow();
    expect(kept.category_id).not.toBeNull();
  });

  it('still retries threads when the model call threw', async () => {
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await seed(['t_err']);
    answer = () => {
      throw new Error('provider down');
    };
    await runLlmClassifier(db, userId);
    answer = () => ({ assignments: [] });
    await runLlmClassifier(db, userId);
    expect(sent).toEqual([['t_err'], ['t_err']]);
  });
});
