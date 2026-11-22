/**
 * ADR 0187 — a confirmed email-derived proposal must block re-staging the
 * same obligation from the same thread, not just a still-pending one.
 * `threadAlreadyProposed` is the exact-provenance+tool guard every staging
 * site calls first (`magics.service.ts`); the fuzzy title-matching guards
 * (`shouldStageEventProposal` etc.) are covered by their own existing tests
 * and are untouched by this change.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal, rejectProposal } from '@/services/proposals.service.js';
import { expireProposals, threadAlreadyProposed } from '@/services/event-convergence.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('threadAlreadyProposed (ADR 0187)', () => {
  it('is false for a thread that has never staged this tool', async () => {
    const userId = await createUser(db, 'never-staged');
    expect(await threadAlreadyProposed(db, userId, 'gmail:t1', 'create_task')).toBe(false);
  });

  it('is true while the proposal is still pending (pre-existing ADR 0137 behavior)', async () => {
    const userId = await createUser(db, 'still-pending');
    const group = await ensurePersonalGroup(db, userId);
    await createProposal(db, {
      groupId: group.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Return the permission slip' },
      provenance: 'gmail:t-pending',
    });
    expect(await threadAlreadyProposed(db, userId, 'gmail:t-pending', 'create_task')).toBe(true);
    // ADR 0243 — asked without a tool, any proposal from the thread counts;
    // asked about a different tool, this one does not.
    expect(await threadAlreadyProposed(db, userId, 'gmail:t-pending')).toBe(true);
    expect(await threadAlreadyProposed(db, userId, 'gmail:t-pending', 'create_event')).toBe(false);
  });

  it('stays true once the proposal is CONFIRMED — re-mining the thread must not restage it', async () => {
    const userId = await createUser(db, 'already-confirmed');
    const group = await ensurePersonalGroup(db, userId);
    const proposal = await createProposal(db, {
      groupId: group.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Return the permission slip' },
      provenance: 'gmail:t-confirmed',
    });

    const result = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });
    expect(result.ok).toBe(true);

    // Before this ADR, threadAlreadyProposed only checked `status = 'pending'`
    // and would have returned false here — the exact gap that let a re-run
    // stage (and let the user re-confirm) a duplicate task.
    expect(await threadAlreadyProposed(db, userId, 'gmail:t-confirmed', 'create_task')).toBe(true);
  });

  it('is false again once the proposal is REJECTED — "not now" is not "done"', async () => {
    const userId = await createUser(db, 'was-rejected');
    const group = await ensurePersonalGroup(db, userId);
    const proposal = await createProposal(db, {
      groupId: group.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Return the permission slip' },
      provenance: 'gmail:t-rejected',
    });
    await rejectProposal(db, { id: proposal.id, resolvedByUserId: userId });
    expect(await threadAlreadyProposed(db, userId, 'gmail:t-rejected', 'create_task')).toBe(false);
  });
});

describe('expireProposals', () => {
  it('never relabels a proposal a confirm already resolved', async () => {
    // A withdrawal sweep reads ids as pending, then the user confirms one
    // before the sweep writes: the tool ran, so the card must stay confirmed.
    const userId = await createUser(db, 'raced');
    const group = await ensurePersonalGroup(db, userId);
    const proposal = await createProposal(db, {
      groupId: group.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: { title: 'Return the permission slip' },
      provenance: 'gmail:t-raced',
    });
    const res = await confirmProposal(db, { id: proposal.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);

    await expireProposals(db, [proposal.id]);

    const row = await db.selectFrom('proposals').select('status').where('id', '=', proposal.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
  });
});
