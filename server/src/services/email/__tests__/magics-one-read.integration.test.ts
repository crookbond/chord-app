/**
 * One model read per email (ADR 0329).
 *
 * Prod, 10 days: 1,843 `email_magics` calls, ~2 per new thread. The sweep
 * (`runEmailMagics`) wrote a `magic` mark, the read-time pass (ADR 0180) and
 * its warm-up / prefetch (ADR 0219, ADR 0205 addendum) looked only for a
 * `read` mark - so every thread the sweep mined was read by the model again
 * as soon as the warm-up ran after that same sync, or when it was opened.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import {
  prefetchReadTimeMagics,
  preprocessReadTimeMagics,
  runEmailMagics,
  runReadTimeEmailMagics,
  type EmailExtractor,
  type EmailSuggestion,
  type MagicThreadInput,
} from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'one-read-user');
  await ensurePersonalGroup(db, userId);
  (env as { EMAIL_MAGICS_ENABLED: boolean }).EMAIL_MAGICS_ENABLED = true;
});
afterEach(async () => {
  await closeTestDb(db);
});

function recording(answer: EmailSuggestion | null = null): {
  extractor: EmailExtractor;
  inputs: MagicThreadInput[];
} {
  const inputs: MagicThreadInput[] = [];
  return {
    inputs,
    extractor: {
      async extract(input) {
        inputs.push(input);
        return answer;
      },
    },
  };
}

async function addMessage(threadId: string, gid: string, at: string, body: string): Promise<void> {
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${newId('x')}`,
      gmail_thread_id: gid,
      from_name: 'Coach Dana',
      from_email: 'dana@soccer.example',
      to_emails: JSON.stringify(['me@example.com']),
      cc_emails: JSON.stringify([]),
      subject: 'Practice moved',
      snippet: body.slice(0, 80),
      body_text: body,
      body_html: null,
      internal_date: at,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({}),
      // What a sync stores for a message with no invite (ADR 0080), so the
      // ADR 0074 probe does not go to the provider.
      ics_text: '',
      created_at: at,
    })
    .execute();
}

async function seedThread(opts: { category?: string; archived?: boolean; unsorted?: boolean } = {}) {
  const now = new Date().toISOString();
  const gid = `t_${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'Practice moved',
      snippet: 'Practice is Thursday at 5pm this week.',
      from_email: 'dana@soccer.example',
      from_name: 'Coach Dana',
      last_message_at: now,
      is_unread: 1,
      is_archived: opts.archived ? 1 : 0,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await addMessage(threadId, gid, now, 'Practice is Thursday at 5pm this week.');
  if (!opts.unsorted) await sortThread(gid, opts.category);
  return { threadId, gid };
}

async function sortThread(gid: string, title = 'Kids activities'): Promise<void> {
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: 'cat', parentId: null, title, depth: 0 }],
    assignments: [{ gmailThreadId: gid, categoryId: 'cat' }],
  });
}

async function marks(gid: string): Promise<string[]> {
  const rows = await db
    .selectFrom('email_extraction_marks')
    .select('kind')
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gid)
    .orderBy('kind')
    .execute();
  return rows.map((r) => r.kind);
}

describe('one model read per email', () => {
  it('the warm-up after a sweep does not read the swept email again', async () => {
    const { gid } = await seedThread();
    const rec = recording();
    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);

    await preprocessReadTimeMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);
    expect(await marks(gid)).toEqual(['magic', 'read']);
  });

  it('the reader prefetch does not read a swept email again', async () => {
    const { threadId } = await seedThread();
    const rec = recording();
    await runEmailMagics(db, userId, { extractor: rec.extractor });

    const res = await prefetchReadTimeMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(res.started).toBe(false);
    expect(rec.inputs).toHaveLength(1);
  });

  it('opening a swept email re-serves the sweep result, advisory included', async () => {
    const { threadId } = await seedThread();
    const rec = recording({ kind: 'advisory', note: 'This looks like a phishing attempt.' });
    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);
    // The sweep's one call is a complete read-time read: it is told who sent it.
    expect(rec.inputs[0].senderContext).toContain('dana@soccer.example');

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);
    expect(res.ranNow).toBe(false);
    expect(res.advisory?.note).toBe('This looks like a phishing attempt.');
  });

  it('an email opened before the sweep reached it is not read again by the sweep', async () => {
    const { threadId, gid } = await seedThread();
    const rec = recording();
    const opened = await runReadTimeEmailMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(opened.ranNow).toBe(true);
    expect(rec.inputs).toHaveLength(1);

    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);
    expect(await marks(gid)).toEqual(['magic', 'read']);
  });

  it('an email opened before it was sorted is still read by the sweep once sorted', async () => {
    // The open could not take the travel short-circuit (it keys on the category).
    const { threadId, gid } = await seedThread({ unsorted: true });
    const rec = recording();
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(await marks(gid)).toEqual(['read']);

    await sortThread(gid);
    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(2);
    expect(await marks(gid)).toEqual(['magic', 'read']);
  });

  it('opening an email the sweep skipped still runs its own read (ADR 0180)', async () => {
    // Archived: the sweep never mines it.
    const { threadId } = await seedThread({ archived: true });
    const rec = recording();
    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(0);

    const res = await runReadTimeEmailMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(res.ranNow).toBe(true);
    expect(rec.inputs).toHaveLength(1);
    expect(rec.inputs[0].interactive).toBe(true);
  });

  it('a new reply is read once more, not twice (ADR 0315)', async () => {
    const { threadId, gid } = await seedThread();
    const rec = recording();
    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(1);

    // Both marks predate the reply that now arrives.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    await db
      .updateTable('email_extraction_marks')
      .set({ created_at: hourAgo })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gid)
      .execute();
    await addMessage(threadId, gid, new Date().toISOString(), 'Actually make it 6pm.');

    await runEmailMagics(db, userId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(2);
    await preprocessReadTimeMagics(db, userId, { extractor: rec.extractor });
    await runReadTimeEmailMagics(db, userId, threadId, { extractor: rec.extractor });
    expect(rec.inputs).toHaveLength(2);
  });
});
