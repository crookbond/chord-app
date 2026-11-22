/**
 * ADR 0184 — the background sweep (`runEmailMagics`) and the interactive
 * read-time pass (`runReadTimeEmailMagics`, ADR 0180) send two different
 * versions of ADR 0179's discretionary-broadcast rule to the extractor: the
 * sweep keeps the suppression (a coupon nobody looked at stays "none"),
 * the read-time pass drops it (opening the email is itself the consent
 * ADR 0179's rule was trying to infer from the mail's content alone).
 *
 * Pinned the same way ADR 0109's own prompt fork is pinned
 * (`bulk-hint.integration.test.ts`): without a real LLM in the loop, the
 * system-prompt text sent to `llm.complete` is the only thing to assert on.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const seen: { system: string }[] = [];

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'recording-mock',
    defaultModel: 'recording-mock',
    supportsNativeTools: false,
    complete: async (messages: { role: string; content: string }[]) => {
      seen.push({ system: messages.find((m) => m.role === 'system')?.content ?? '' });
      return JSON.stringify({ kind: 'none' });
    },
    async *stream() {},
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

describe('ADR 0184 — interactive vs. sweep discretionary-broadcast rule', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    seen.length = 0;
    db = await openTestDb();
    userId = await createUser(db, 'on-the-hook-user');
    await ensurePersonalGroup(db, userId);
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedThread(gid: string, subject: string): Promise<string> {
    const id = newId('emt');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id,
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    return id;
  }

  it('the background sweep still suppresses a discretionary broadcast', async () => {
    const gid = 'g-note';
    await seedThread(gid, 'Weekend plans');
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'ff' }],
    });

    const { runEmailMagics } = await import('@/services/email/magics.service.js');
    await runEmailMagics(db, userId);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toMatch(/ON THE HOOK/);
    expect(seen[0]!.system).not.toMatch(/opened this exact email themselves/);
  });

  it('opening the thread drops the discretionary-broadcast gate', async () => {
    const threadId = await seedThread('g-note2', 'Building Water Shut Off - Monday');

    const { runReadTimeEmailMagics } = await import('@/services/email/magics.service.js');
    await runReadTimeEmailMagics(db, userId, threadId);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.system).toMatch(/opened this exact email themselves/);
    expect(seen[0]!.system).not.toMatch(/Only emit a task or event when the recipient is ON THE HOOK/);
  });

  it('the interactive rule still lets a fixed household-outage window count as an event', async () => {
    // Not asserting the model's OWN judgment (there is no real model here) —
    // asserting the instruction it would need is actually present, since a
    // prose-only rule is only as good as the sentence a future edit could
    // silently drop.
    const threadId = await seedThread('g-note3', 'Building Water Shut Off - Monday');

    const { runReadTimeEmailMagics } = await import('@/services/email/magics.service.js');
    await runReadTimeEmailMagics(db, userId, threadId);

    expect(seen[0]!.system).toMatch(/counts as something "the recipient is attending"/);
    // The recurring case must still fall through to "none" — the whole point
    // of keeping signal (3) (a fixed, one-time window) in the interactive rule.
    expect(seen[0]!.system).toMatch(/RECURRING or open-ended schedule.*is still not concrete enough/);
  });
});
