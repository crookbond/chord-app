/**
 * TG callback_query handler (ADR 0029): decodes `verb:id` payloads,
 * authenticates the tapping TG user against the proposal's Chord
 * group, dispatches to the proposal service, returns a toast string.
 *
 * Pins:
 *   - Confirm verb on a pending proposal owned by the tapping user's
 *     group → proposal resolves, toast = "✓ Confirmed".
 *   - Reject verb → resolves, toast = "✗ Skipped".
 *   - Unknown TG identity → "I don't recognize this Telegram account."
 *   - Identity exists but not a member of the proposal's group →
 *     "You're not a member of that Chord group."
 *   - Pending proposal id that doesn't exist → "That proposal is gone."
 *   - Already-resolved proposal → "Already resolved."
 *   - Unparseable callback data → "Sorry, I couldn't read that button."
 *   - Unknown verb → "Unknown action."
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { handleCallback } from '@/services/connectors/telegram/callback-handler.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

interface Fixture {
  db: Kysely<DB>;
  groupId: string;
  userId: string;
}

async function seed(): Promise<Fixture> {
  const db = await openTestDb();
  const now = new Date().toISOString();
  const userId = newId('u');
  const groupId = newId('g');
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: 'alice',
      display_name: 'Alice',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Family',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `cb-${groupId.slice(2)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 1,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();
  await db
    .insertInto('external_identities')
    .values({
      platform: 'telegram',
      external_id: '42',
      external_display: 'Alice',
      user_id: userId,
      created_at: now,
    })
    .execute();
  return { db, groupId, userId };
}

async function makeProposal(fx: Fixture) {
  return await createProposal(fx.db, {
    groupId: fx.groupId,
    proposedByUserId: fx.userId,
    proposedByMessageId: null,
    toolName: 'save_link',
    args: {
      title: 'Hacker News article',
      url: 'https://news.ycombinator.com',
    },
    provenance: 'test',
  });
}

describe('callback-handler: proposal confirm/reject', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await seed();
  });

  afterEach(async () => {
    await closeTestDb(fx.db);
  });

  it('confirm verb on a pending proposal → proposal resolved + toast', async () => {
    const p = await makeProposal(fx);
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: `p+:${p.id}`,
    });
    expect(result.toast).toBe('✓ Confirmed');

    const after = await fx.db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('confirmed');
  });

  it('reject verb on a pending proposal → proposal rejected + toast', async () => {
    const p = await makeProposal(fx);
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: `p-:${p.id}`,
    });
    expect(result.toast).toBe('✗ Skipped');

    const after = await fx.db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('rejected');
  });

  it('already-resolved proposal → "Already resolved." toast, no state change', async () => {
    const p = await makeProposal(fx);
    await fx.db
      .updateTable('proposals')
      .set({ status: 'rejected' })
      .where('id', '=', p.id)
      .execute();
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: `p+:${p.id}`,
    });
    expect(result.toast).toMatch(/already resolved/i);
    const after = await fx.db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('rejected');
  });

  it('non-existent proposal id → "That proposal is gone."', async () => {
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: 'p+:prop_does_not_exist',
    });
    expect(result.toast).toMatch(/gone/i);
  });

  it('unknown TG identity → no Chord account toast', async () => {
    const p = await makeProposal(fx);
    const result = await handleCallback(fx.db, {
      externalUserId: '99999',
      receivedByBotUserId: null,
      data: `p+:${p.id}`,
    });
    expect(result.toast).toMatch(/don't recognize/i);
    const after = await fx.db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('pending');
  });

  it('known identity but not a group member → not-a-member toast', async () => {
    // Spin up a *different* group with a *different* user; the proposal
    // belongs to that group, but Alice (TG 42) is not a member.
    const otherUserId = newId('u');
    const otherGroupId = newId('g');
    const now = new Date().toISOString();
    await fx.db
      .insertInto('users')
      .values({
        id: otherUserId,
        username: 'bob',
        display_name: 'Bob',
        created_at: now,
        shadow: 0,
      })
      .execute();
    await fx.db
      .insertInto('groups')
      .values({
        id: otherGroupId,
        name: "Bob's",
        kind: 'group',
        invite_code: otherGroupId.slice(2, 8).toUpperCase(),
        ingest_email: `cb2-${otherGroupId.slice(2)}@chord.app`,
        created_by: otherUserId,
        adults_only: 0,
        mirror_inbound: 1,
        created_at: now,
      })
      .execute();
    await fx.db
      .insertInto('group_members')
      .values({
        group_id: otherGroupId,
        user_id: otherUserId,
        role: 'owner',
        tier: 'verified',
        joined_at: now,
      })
      .execute();
    const p = await createProposal(fx.db, {
      groupId: otherGroupId,
      proposedByUserId: otherUserId,
      proposedByMessageId: null,
      toolName: 'save_link',
      args: { title: 't', url: 'https://example.test' },
      provenance: 'test',
    });

    const result = await handleCallback(fx.db, {
      externalUserId: '42', // Alice's TG id, mapped to her u_ row
      receivedByBotUserId: null,
      data: `p+:${p.id}`,
    });
    expect(result.toast).toMatch(/not a member/i);
    const after = await fx.db
      .selectFrom('proposals')
      .select('status')
      .where('id', '=', p.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('pending');
  });

  it('unparseable callback data → friendly toast, no work done', async () => {
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: 'this-is-not-a-verb',
    });
    expect(result.toast).toMatch(/couldn't read/i);
  });

  it('unknown verb → "Unknown action." toast', async () => {
    const result = await handleCallback(fx.db, {
      externalUserId: '42',
      receivedByBotUserId: null,
      data: 'xx:something',
    });
    expect(result.toast).toMatch(/unknown action/i);
  });
});
