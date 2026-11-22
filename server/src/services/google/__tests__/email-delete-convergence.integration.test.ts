/**
 * Email delete/archive convergence: deleted or archived mail shows up nowhere,
 * and the email→proposal flow dies with the email — a Gmail-side trash or
 * delete retracts the thread's still-pending magic proposals, while a proposal
 * decided before the delete keeps its outcome.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  __deleteGmailMockMessage,
  __resetGmailMock,
  getGmailApi,
} from '@/services/google/gmail-api.js';
import { backfillGmail, listThreads } from '@/services/google/gmail.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { SSE } from '@chord/kernel';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * Relative, not literal (ADR 0100's precedent, load-bearing again for ADR
 * 0137): a `startsAt` already lived through stages nothing, so a hardcoded
 * date rots this into a test that asserts nothing.
 */
const inDays = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const D_DINNER = inDays(12);


describe('email delete/archive convergence', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalGroupId: string;
  let savedBackfillDays: number;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    // Classifier off: its snapshot-replace ingest would wipe the manually
    // assigned category these tests use.
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    // Fixture mail sits at a fixed 2023 epoch; widen the backfill window so the
    // reverse-delete pass (which only judges in-window rows) covers it.
    savedBackfillDays = env.GMAIL_BACKFILL_DAYS;
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = 3650;
    db = await openTestDb();
    userId = await createUser(db, 'delete-conv-user');
    personalGroupId = (await ensurePersonalGroup(db, userId)).id;
    await backfillGmail(db, userId);
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    (env as { GMAIL_BACKFILL_DAYS: number }).GMAIL_BACKFILL_DAYS = savedBackfillDays;
    await closeTestDb(db);
  });

  const stageProposal = (gmailThreadId: string) =>
    createProposal(db, {
      groupId: personalGroupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Sunday dinner at Grandma’s', startsAt: `${D_DINNER}T17:00:00-04:00` },
      provenance: `gmail:${gmailThreadId}`,
    });

  const proposalStatus = async (id: string) =>
    (
      await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow()
    ).status;

  const threadRow = (gmailThreadId: string) =>
    db
      .selectFrom('email_threads')
      .select(['id', 'is_archived'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', gmailThreadId)
      .executeTakeFirst();

  it('trashing a thread hides it everywhere and retracts its pending proposal', async () => {
    const proposal = await stageProposal('t_fam1');
    const api = await getGmailApi(db, userId);
    await api.modifyThread('t_fam1', { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
    await backfillGmail(db, userId);

    // Gmail leaves trashed mail out of a listing, so the backfill's
    // reverse-delete removes the thread rather than re-reading its labels.
    expect((await threadRow('t_fam1'))?.is_archived ?? 1).toBe(1);
    const listed = await listThreads(db, userId, { mode: 'traditional' });
    expect(listed.some((t) => t.subject === 'Sunday dinner?')).toBe(false);
    expect(await proposalStatus(proposal.id)).toBe('expired');
  });

  // Reported: "deleting an email in Chord should delete proposed to-dos /
  // action items". The proposal WAS being expired, but silently — so Action
  // Items and the AI feed kept showing it until their next refetch.
  it('trashing a thread tells open screens its suggestion is gone', async () => {
    const proposal = await stageProposal('t_fam1');
    const heard: Array<{ channel: string; event: string; data: unknown }> = [];
    const stop = sseHub.onBroadcast((channel, event, data) => {
      heard.push({ channel, event, data });
    });
    try {
      const api = await getGmailApi(db, userId);
      await api.modifyThread('t_fam1', { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
      await backfillGmail(db, userId);
    } finally {
      stop();
    }

    expect(await proposalStatus(proposal.id)).toBe('expired');
    expect(
      heard.some(
        (h) =>
          h.channel === personalGroupId &&
          h.event === SSE.proposalResolved &&
          (h.data as { id: string; status: string }).id === proposal.id &&
          (h.data as { id: string; status: string }).status === 'expired',
      ),
    ).toBe(true);
    expect(
      heard.some((h) => h.channel === `user:${userId}` && h.event === SSE.emailTilesUpdated),
    ).toBe(true);
  });

  it('a Google-side permanent delete removes the thread and retracts its proposal', async () => {
    const proposal = await stageProposal('t_fam1');
    __deleteGmailMockMessage(userId, 'm_fam1');
    await backfillGmail(db, userId);

    expect(await threadRow('t_fam1')).toBeUndefined();
    expect(await proposalStatus(proposal.id)).toBe('expired');
  });

  it('archive alone hides the email but keeps the pending proposal', async () => {
    const proposal = await stageProposal('t_fam1');
    const api = await getGmailApi(db, userId);
    await api.modifyThread('t_fam1', { removeLabelIds: ['INBOX'] });
    await backfillGmail(db, userId);

    expect((await threadRow('t_fam1'))?.is_archived).toBe(1);
    const listed = await listThreads(db, userId, { mode: 'traditional' });
    expect(listed.some((t) => t.subject === 'Sunday dinner?')).toBe(false);
    expect(await proposalStatus(proposal.id)).toBe('pending');
  });

  it('a proposal decided before the delete keeps its outcome', async () => {
    const proposal = await stageProposal('t_fam1');
    await db
      .updateTable('proposals')
      .set({ status: 'confirmed', resolved_at: new Date().toISOString() })
      .where('id', '=', proposal.id)
      .execute();

    __deleteGmailMockMessage(userId, 'm_fam1');
    await backfillGmail(db, userId);

    expect(await threadRow('t_fam1')).toBeUndefined();
    expect(await proposalStatus(proposal.id)).toBe('confirmed');
  });

  it('category-mode listing also hides archived mail', async () => {
    // Assign the family thread to a category, then trash it: the tile sheet
    // (category mode) must not keep showing it.
    const row = await threadRow('t_fam1');
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: 'cat_fam',
        user_id: userId,
        parent_id: null,
        title: 'Family',
        depth: 0,
        sort_order: 0,
        updated_at: now,
      })
      .execute();
    await db
      .updateTable('email_threads')
      .set({ category_id: 'cat_fam', classified_at: now })
      .where('id', '=', row!.id)
      .execute();

    const before = await listThreads(db, userId, { mode: 'category', categoryIds: ['cat_fam'] });
    expect(before.some((t) => t.subject === 'Sunday dinner?')).toBe(true);

    const api = await getGmailApi(db, userId);
    await api.modifyThread('t_fam1', { addLabelIds: ['TRASH'], removeLabelIds: ['INBOX'] });
    await backfillGmail(db, userId);

    const after = await listThreads(db, userId, { mode: 'category', categoryIds: ['cat_fam'] });
    expect(after.some((t) => t.subject === 'Sunday dinner?')).toBe(false);
  });
});
