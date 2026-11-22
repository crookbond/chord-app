/**
 * Mail the provider moves to spam takes what it produced with it.
 *
 * Prod 2026-10-29: a fake Coinbase email staged "Contact Coinbase support at
 * +1 888 814 6053 ..." as a to-do card, then landed in spam. A move to spam
 * read as an archive, which keeps an email's suggestions on purpose (ADR
 * 0073), so the card would have stayed; and a to-do from it with a date ahead
 * would have survived even a delete (ADR 0239).
 */
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail, recomputeThread } from '@/services/google/gmail.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { createTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const PHISH_TODO = 'Contact Coinbase support at +1 888 814 6053 if you do not recognize the phone number change request';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe('a thread moved to spam', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let savedBackfillDays: number;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    savedBackfillDays = env.GMAIL_BACKFILL_DAYS;
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = 3650;
    db = await openTestDb();
    userId = await createUser(db, 'spam-retire-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await backfillGmail(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = savedBackfillDays;
    await closeTestDb(db);
  });

  const stage = async (gmailThreadId: string) => {
    const proposal = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: PHISH_TODO },
      provenance: `gmail:${gmailThreadId}`,
    });
    const task = await createTask(db, {
      groupId,
      createdBy: userId,
      title: PHISH_TODO,
      dueAt: inDays(5),
      sourceRawContext: `gmail:${gmailThreadId}`,
    });
    return { proposalId: proposal.id, taskId: task.id };
  };

  /** What a history label change writes, then the recompute it triggers. */
  const relabel = async (gmailThreadId: string, add: string[], remove: string[]) => {
    const rows = await db
      .selectFrom('email_messages')
      .select(['id', 'gmail_label_ids'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const next = [...new Set([...r.gmail_label_ids.filter((l) => !remove.includes(l)), ...add])];
      await db
        .updateTable('email_messages')
        .set({ gmail_label_ids: sql`${JSON.stringify(next)}::jsonb` })
        .where('id', '=', r.id)
        .execute();
    }
    await recomputeThread(db, userId, gmailThreadId);
  };

  const state = async (ids: { proposalId: string; taskId: string }) => ({
    proposal: (await db.selectFrom('proposals').select('status').where('id', '=', ids.proposalId).executeTakeFirstOrThrow()).status,
    task: await db
      .selectFrom('tasks')
      .select(['status', 'archived_reason'])
      .where('id', '=', ids.taskId)
      .executeTakeFirstOrThrow(),
  });

  it('withdraws the card and retires the to-do, even one dated ahead', async () => {
    const ids = await stage('t_fam1');
    await relabel('t_fam1', ['SPAM'], ['INBOX']);

    const s = await state(ids);
    expect(s.proposal).toBe('expired');
    expect(s.task).toEqual({ status: 'archived', archived_reason: 'email_spam' });
  });

  it('a plain archive still keeps both', async () => {
    const ids = await stage('t_fam1');
    await relabel('t_fam1', [], ['INBOX']);

    const s = await state(ids);
    expect(s.proposal).toBe('pending');
    expect(s.task.status).toBe('open');
  });
});
