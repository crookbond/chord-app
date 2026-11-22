/**
 * ADR 0110 — changing the prompt and the inputs means the mail already
 * classified is classified wrong, and stays wrong.
 *
 * Two halves: a version stamp that re-queues stale threads without starving
 * live mail, and a body backfill that gives those threads something better to
 * be re-read from than the snippet that produced the first answer.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { env } from '@/config/env.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const seen: string[] = [];

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'recording-mock',
    defaultModel: 'recording-mock',
    supportsNativeTools: false,
    complete: async (messages: { role: string; content: string }[]) => {
      seen.push(messages.find((m) => m.role === 'user')?.content ?? '');
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

describe('the re-run queue', () => {
  let db: Kysely<DB>;
  let userId: string;
  let prior: { classifier: string; batch: number };

  beforeEach(async () => {
    seen.length = 0;
    db = await openTestDb();
    userId = await createUser(db, 'reclassify');
    prior = { classifier: env.EMAIL_CLASSIFIER, batch: env.EMAIL_CLASSIFIER_BATCH_SIZE };
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = 'llm';
  });

  afterEach(async () => {
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = prior.classifier;
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = prior.batch;
    await closeTestDb(db);
  });

  /** `version: null` = never classified (live mail). */
  const seed = async (gid: string, subject: string, version: number | null): Promise<void> => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        from_email: 'someone@example.com',
        last_message_at: now,
        classifier_version: version ?? 0,
        classified_at: version === null ? null : now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  const threadsInPayload = (): string[] => {
    if (seen.length === 0) return [];
    const payload = JSON.parse(seen[0]!) as { threads: { gmailThreadId: string }[] };
    return payload.threads.map((t) => t.gmailThreadId).sort();
  };

  it('spends the batch on live mail first, and the remainder on the backlog', async () => {
    const { runLlmClassifier } = await import('@/services/email/llm-classifier.js');
    await seed('t_new', 'Just arrived', null);
    await seed('t_old1', 'Classified last month', 0);
    await seed('t_old2', 'Also last month', 0);

    // Room for exactly one: the backlog must not take it.
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = 1;
    await runLlmClassifier(db, userId);
    expect(threadsInPayload()).toEqual(['t_new']);

    // Room for three: the backlog fills what live mail leaves. t_new was
    // answered (empty) above, so it is not sent again.
    seen.length = 0;
    (env as { EMAIL_CLASSIFIER_BATCH_SIZE: number }).EMAIL_CLASSIFIER_BATCH_SIZE = 3;
    await runLlmClassifier(db, userId);
    expect(threadsInPayload()).toEqual(['t_old1', 't_old2']);
  });

  it('stamps what the pass looked at, so the queue actually empties', async () => {
    const { runLlmClassifier, CLASSIFIER_VERSION } = await import(
      '@/services/email/llm-classifier.js'
    );
    await seed('t_old1', 'Classified last month', 0);
    await runLlmClassifier(db, userId);

    const row = await db
      .selectFrom('email_threads')
      .select('classifier_version')
      .where('gmail_thread_id', '=', 't_old1')
      .executeTakeFirstOrThrow();
    expect(row.classifier_version).toBe(CLASSIFIER_VERSION);

    // And it does not come back on the next tick.
    seen.length = 0;
    await runLlmClassifier(db, userId);
    expect(threadsInPayload()).toEqual([]);
  });

  it('does not send a thread back to the model because it was read, only because mail arrived', async () => {
    const { runLlmClassifier, CLASSIFIER_VERSION } = await import('@/services/email/llm-classifier.js');
    const { recomputeThread } = await import('@/services/google/gmail.service.js');
    const at = new Date(Date.now() - 60_000).toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow, user_id: userId, gmail_thread_id: 't_read', subject: 'Field trip form', snippet: 'Please sign',
        from_email: 'school@example.com', last_message_at: at, message_count: 1, is_unread: 1,
        classifier_version: CLASSIFIER_VERSION, classified_at: at, created_at: at, updated_at: at,
      })
      .execute();
    const message = (id: string, when: string, unread: boolean) => ({
      id: newId('emm'), user_id: userId, thread_id: threadRow, gmail_message_id: id, gmail_thread_id: 't_read',
      subject: 'Field trip form', snippet: 'Please sign', from_email: 'school@example.com',
      to_emails: JSON.stringify([]), cc_emails: JSON.stringify([]),
      gmail_label_ids: JSON.stringify(unread ? ['INBOX', 'UNREAD'] : ['INBOX']), is_unread: unread ? 1 : 0,
      internal_date: when, created_at: when,
    });
    await db.insertInto('email_messages').values(message('m1', at, true)).execute();
    // The sync wrote this thread before it was classified; settle the row.
    await recomputeThread(db, userId, 't_read');
    await db.updateTable('email_threads').set({ classified_at: new Date().toISOString() }).where('id', '=', threadRow).execute();

    // Opened on the phone: the sync reads the message back as read.
    await db
      .updateTable('email_messages')
      .set({ is_unread: 0, gmail_label_ids: JSON.stringify(['INBOX']) })
      .where('gmail_message_id', '=', 'm1')
      .execute();
    await recomputeThread(db, userId, 't_read');
    seen.length = 0;
    await runLlmClassifier(db, userId);
    expect(threadsInPayload()).toEqual([]);

    // A reply arrives: that is new content, and it is classified again.
    await db.insertInto('email_messages').values(message('m2', new Date().toISOString(), true)).execute();
    await recomputeThread(db, userId, 't_read');
    seen.length = 0;
    await runLlmClassifier(db, userId);
    expect(threadsInPayload()).toEqual(['t_read']);
  });
});

describe('the body backfill', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'backfill');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('fills the excerpt from what is stored and re-queues the thread', async () => {
    const { backfillBodyExcerpts } = await import('@/services/email/body-backfill.js');
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: 't_html',
        subject: 'Invoice',
        snippet: 'Your monthly invoice is ready',
        last_message_at: now,
        // Already classified under the old inputs.
        classifier_version: 1,
        classified_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: 't_html',
        subject: 'Invoice',
        snippet: 'Your monthly invoice is ready',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        // The Outlook shape: HTML mirrored, no text anywhere.
        body_html: '<p>Amount Due</p><p>$1,240.00</p>',
        internal_date: now,
        created_at: now,
      })
      .execute();

    const result = await backfillBodyExcerpts(db, userId, { limit: 10 });
    expect(result).toMatchObject({ processed: 1, filled: 1 });

    const msg = await db
      .selectFrom('email_messages')
      .select('body_excerpt')
      .where('gmail_thread_id', '=', 't_html')
      .executeTakeFirstOrThrow();
    expect(msg.body_excerpt).toContain('$1,240.00');

    const thread = await db
      .selectFrom('email_threads')
      .select('classifier_version')
      .where('gmail_thread_id', '=', 't_html')
      .executeTakeFirstOrThrow();
    expect(thread.classifier_version).toBe(0);
  });

  it('settles a message with no text so the queue drains past it', async () => {
    const { backfillBodyExcerpts } = await import('@/services/email/body-backfill.js');
    const now = new Date().toISOString();
    const threadRow = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRow,
        user_id: userId,
        gmail_thread_id: 't_empty',
        subject: 'No body',
        snippet: '',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: 't_empty',
        subject: 'No body',
        snippet: '',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        internal_date: now,
        created_at: now,
      })
      .execute();

    // No Gmail connection, so every fetch fails. A failure is retried a few
    // passes (body-backfill-failure test), then settled.
    for (let i = 0; i < 5; i++) await backfillBodyExcerpts(db, userId, { limit: 10 });
    const msg = await db
      .selectFrom('email_messages')
      .select('body_excerpt')
      .where('gmail_thread_id', '=', 't_empty')
      .executeTakeFirstOrThrow();
    // '' not null: "we looked and there was nothing" has to be distinguishable
    // from "never looked", or this row is at the head of the queue forever.
    expect(msg.body_excerpt).toBe('');

    const again = await backfillBodyExcerpts(db, userId, { limit: 10 });
    expect(again.processed).toBe(0);
  });
});
