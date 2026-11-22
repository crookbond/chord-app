/**
 * ADR 0109 — the classifier is told HOW a thread was sent, and stops being
 * asked to answer that with a topic.
 *
 * The bug this pins: Gmail’s promotions tab used to be forked into "Coupons"
 * or "Newsletters" in the prompt, and the model took the easier branch — so a
 * ski retailer’s sale landed under Newsletters > Recipes & food, and Coupons
 * held three threads in the entire database.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const seen: { system: string; user: string }[] = [];

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'recording-mock',
    defaultModel: 'recording-mock',
    supportsNativeTools: false,
    complete: async (messages: { role: string; content: string }[]) => {
      seen.push({
        system: messages.find((m) => m.role === 'system')?.content ?? '',
        user: messages.find((m) => m.role === 'user')?.content ?? '',
      });
      return JSON.stringify({ assignments: [] });
    },
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

describe('the classifier is told how a thread was sent', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorClassifier: string;

  beforeEach(async () => {
    seen.length = 0;
    db = await openTestDb();
    userId = await createUser(db, 'bulk-hint');
    priorClassifier = env.EMAIL_CLASSIFIER;
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
  });

  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = priorClassifier;
    await closeTestDb(db);
  });

  const seed = async (gid: string, from: string, subject: string, bulk: number) => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: from,
        last_message_at: now,
        bulk,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  it('carries bulk for a blast and omits it for ordinary mail', async () => {
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await seed('t_promo', 'news@christysports.example', 'Two weeks left', 1);
    await seed('t_note', 'anita@example.com', 'Sunday?', 0);

    await runLlmClassifier(db, userId);

    expect(seen).toHaveLength(1);
    const threads = (JSON.parse(seen[0]!.user) as {
      threads: { gmailThreadId: string; bulk?: boolean }[];
    }).threads;
    const promo = threads.find((t) => t.gmailThreadId === 't_promo');
    const note = threads.find((t) => t.gmailThreadId === 't_note');
    expect(promo?.bulk).toBe(true);
    // Absent, not false: a key on every thread is paid for on every pass.
    expect(note && 'bulk' in note).toBe(false);
  });

  it('no longer answers "which tab" with a category', async () => {
    // Deliberately pins prompt text. Without an LLM in the loop this is the
    // only way to catch the fork coming back, and its return is exactly what
    // refills Newsletters with retail promos.
    await seed('t_promo', 'news@christysports.example', 'Two weeks left', 1);
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await runLlmClassifier(db, userId);

    expect(seen[0]!.system).not.toMatch(/promotions"?\s*(→|->)/);
    expect(seen[0]!.system).toMatch(/ALWAYS return "bulk": true when the thread was SENT/);
  });
});
