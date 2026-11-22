/**
 * ADR 0079/0325 — the allowance runs out partway through an email pass. The
 * pass starts entitled (its gate is checked once, in `runAfterSyncPasses`),
 * then each thread spends tokens. Once the wrapper refuses, the threads not
 * yet read must stay unmarked: the sweep marks a thread `magic` whatever the
 * extractor did, so without this a refusal permanently skipped every email
 * left in the batch.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, runReadTimeEmailMagics } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests, __setLlmForTests } from '@/services/llm/factory.js';
import { AllowanceExhaustedError } from '@/services/llm/refusal.js';
import type { LlmService } from '@/services/llm/types.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let calls = 0;
/** Chord's model: reads each email for 60 tokens and finds nothing to do. */
const chordModel: LlmService = {
  providerName: 'openai',
  defaultModel: 'chord-model',
  supportsNativeTools: false,
  async complete(_m, o) {
    calls += 1;
    o?.onUsage?.({ promptTokens: 50, completionTokens: 10 });
    return '{"items":[]}';
  },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('not used');
  },
};

const e = env as { BILLING_ENABLED: boolean; FREE_TOKEN_ALLOWANCE: number };
let was: { billing: boolean; free: number };
let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'mid-pass');
  await ensurePersonalGroup(db, userId);
  was = { billing: e.BILLING_ENABLED, free: e.FREE_TOKEN_ALLOWANCE };
  e.BILLING_ENABLED = true;
  calls = 0;
  __setLlmForTests(chordModel);
});
afterEach(async () => {
  e.BILLING_ENABLED = was.billing;
  e.FREE_TOKEN_ALLOWANCE = was.free;
  __resetLlmCacheForTests();
  await closeTestDb(db);
});

async function seedThread(n: number): Promise<{ gid: string; threadId: string }> {
  const at = new Date(Date.now() - n * 60_000).toISOString();
  const gid = `t-mid-${n}`;
  const threadId = newId('emt');
  const subject = `School note ${n}`;
  const body = `Hi, a quick note number ${n} about the week ahead. Nothing to do yet.`;
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      account_id: null,
      gmail_thread_id: gid,
      subject,
      snippet: body.slice(0, 60),
      from_email: 'office@school.example',
      from_name: 'School Office',
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      account_id: null,
      thread_id: threadId,
      gmail_message_id: `m-mid-${n}`,
      gmail_thread_id: gid,
      from_name: 'School Office',
      from_email: 'office@school.example',
      to_emails: JSON.stringify(['parent@example.com']),
      cc_emails: JSON.stringify([]),
      subject,
      snippet: body.slice(0, 60),
      body_text: body,
      body_html: null,
      ics_text: '',
      internal_date: at,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
      created_at: at,
    })
    .execute();
  return { gid, threadId };
}

async function marks(kind: 'magic' | 'read'): Promise<string[]> {
  const rows = await db
    .selectFrom('email_extraction_marks')
    .select('gmail_thread_id')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .execute();
  return rows.map((r) => r.gmail_thread_id).sort();
}

describe('an email pass that runs out of allowance', () => {
  it('the sweep stops at the refusal and leaves the unread emails unmarked', async () => {
    const seeded = [await seedThread(1), await seedThread(2), await seedThread(3)];
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'school', parentId: null, title: 'School', depth: 0 }],
      assignments: seeded.map((s) => ({ gmailThreadId: s.gid, categoryId: 'school' })),
    });
    // Room for two reads of 60 tokens: the third is refused.
    e.FREE_TOKEN_ALLOWANCE = 100;

    await runEmailMagics(db, userId);

    expect(calls).toBe(2);
    const marked = await marks('magic');
    expect(marked).toHaveLength(2);
    const unmarked = seeded.map((s) => s.gid).filter((g) => !marked.includes(g));
    expect(unmarked).toHaveLength(1);
  });

  it('the read-time pass refused inside the pass writes no read mark', async () => {
    // Billing off at the pass's own gate; the model call itself is refused
    // (the allowance ran out between the two, or consent was withdrawn).
    e.BILLING_ENABLED = false;
    const { gid, threadId } = await seedThread(1);
    const refusing = {
      async extract(): Promise<never> {
        throw new AllowanceExhaustedError('none');
      },
    };

    await runReadTimeEmailMagics(db, userId, threadId, { extractor: refusing });

    expect(await marks('read')).not.toContain(gid);
  });
});
