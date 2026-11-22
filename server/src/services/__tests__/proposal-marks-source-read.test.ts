/**
 * Deciding an email-born proposal marks its source thread read — acting on a
 * suggestion is proof the mail behind it was read. Covers both verdicts, the
 * non-email proposals that must be left alone, and the per-mailbox scoping
 * (one user's decision never touches another user's copy of a thread id).
 *
 * A convergence retraction counts as a decision too: the appointment is on the
 * calendar, or the invite was cancelled, so the obligation really is met and
 * the badge drops. Consolidation is the deliberate exception — it only moves
 * the obligation onto the surviving card.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  applyInviteCancellation,
  consolidateDuplicateEventProposals,
  retractProposalsCoveredByExistingEvents,
} from '@/services/event-convergence.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  confirmProposal,
  createProposal,
  rejectProposal,
} from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('proposal decisions mark the source email read', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    db = await openTestDb();
    userId = await createUser(db, 'read-on-action');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    return async () => {
      (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
      await closeTestDb(db);
    };
  });

  const seedUnreadThread = async (owner: string, gmailThreadId: string): Promise<string> => {
    const now = new Date().toISOString();
    const threadRowId = newId('et');
    await db
      .insertInto('email_threads')
      .values({
        id: threadRowId,
        user_id: owner,
        gmail_thread_id: gmailThreadId,
        subject: 'Soccer sign-up',
        snippet: 'snip',
        from_email: 'coach@example.com',
        last_message_at: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('em'),
        user_id: owner,
        thread_id: threadRowId,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gmailThreadId,
        from_email: 'coach@example.com',
        to_emails: JSON.stringify([]),
        cc_emails: JSON.stringify([]),
        subject: 'Soccer sign-up',
        snippet: 'snip',
        body_text: 'Practice moved to Tuesday.',
        internal_date: now,
        is_unread: 1,
        gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
        created_at: now,
      })
      .execute();
    return threadRowId;
  };

  const stageProposal = (provenance: string | null) =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_list_item',
      args: { listName: 'Todo', items: ['sign the form'] },
      provenance,
    });

  const isUnread = async (threadRowId: string): Promise<boolean> => {
    const row = await db
      .selectFrom('email_threads')
      .select('is_unread')
      .where('id', '=', threadRowId)
      .executeTakeFirstOrThrow();
    return row.is_unread === 1;
  };

  it('confirming clears UNREAD on the source thread', async () => {
    const threadRowId = await seedUnreadThread(userId, 'g-confirm');
    const proposal = await stageProposal('gmail:g-confirm');

    const result = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });

    expect(result.ok).toBe(true);
    expect(await isUnread(threadRowId)).toBe(false);
  });

  it('rejecting clears UNREAD too — declining is still a decision', async () => {
    const threadRowId = await seedUnreadThread(userId, 'g-reject');
    const proposal = await stageProposal('gmail:g-reject');

    const resolved = await rejectProposal(db, { id: proposal.id, resolvedByUserId: userId });

    expect(resolved?.proposal.status).toBe('rejected');
    expect(await isUnread(threadRowId)).toBe(false);
  });

  it('leaves other mailboxes alone — the thread id is only unique per user', async () => {
    const other = await createUser(db, 'read-on-action-other');
    const mine = await seedUnreadThread(userId, 'g-shared-id');
    const theirs = await seedUnreadThread(other, 'g-shared-id');

    const proposal = await stageProposal('gmail:g-shared-id');
    await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });

    expect(await isUnread(mine)).toBe(false);
    expect(await isUnread(theirs)).toBe(true);
  });

  it('is a no-op for proposals with no email behind them', async () => {
    const threadRowId = await seedUnreadThread(userId, 'g-untouched');
    const proposal = await stageProposal(null);

    const result = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });

    expect(result.ok).toBe(true);
    expect(await isUnread(threadRowId)).toBe(true);
  });

  describe('convergence retractions (bug 9)', () => {
    const stageEventProposal = (provenance: string, args: Record<string, unknown>) =>
      createProposal(db, {
        groupId,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'create_event',
        args,
        provenance,
      });

    it('a proposal covered by a real calendar event marks its source read', async () => {
      const threadRowId = await seedUnreadThread(userId, 'g-covered');
      await createEvent(db, {
        groupId,
        createdBy: userId,
        title: 'Parent-teacher conference',
        startsAt: '2026-09-10T15:00:00-04:00',
      });
      await stageEventProposal('gmail:g-covered', {
        title: 'Parent-teacher conference',
        startsAt: '2026-09-10T15:30:00-04:00',
      });

      expect(await retractProposalsCoveredByExistingEvents(db, userId)).toBe(1);
      expect(await isUnread(threadRowId)).toBe(false);
    });

    it('an invite cancellation marks the cancelled thread read', async () => {
      const threadRowId = await seedUnreadThread(userId, 'g-cancelled');
      await stageEventProposal('gmail:g-cancelled', {
        title: 'Standup',
        startsAt: '2026-09-11T09:00:00-04:00',
        externalUid: 'uid-abc',
      });

      const res = await applyInviteCancellation(db, userId, 'uid-abc');

      expect(res.proposalsRetracted).toBe(1);
      expect(await isUnread(threadRowId)).toBe(false);
    });

    it('consolidation does NOT mark read — the obligation moved, it was not met', async () => {
      const loser = await seedUnreadThread(userId, 'g-dup-a');
      const winner = await seedUnreadThread(userId, 'g-dup-b');
      const args = { title: 'Stay at Teresita', startsAt: '2026-09-12T17:00:00-04:00' };
      await stageEventProposal('gmail:g-dup-a', args);
      await stageEventProposal('gmail:g-dup-b', args);

      expect(await consolidateDuplicateEventProposals(db, userId)).toBe(1);
      expect(await isUnread(loser)).toBe(true);
      expect(await isUnread(winner)).toBe(true);
    });
  });
});
