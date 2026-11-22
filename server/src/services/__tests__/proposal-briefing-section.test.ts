/**
 * buildPendingProposalsSection — unaccepted proposals ride the daily briefing.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  buildPendingProposalsSection,
  createProposal,
  rejectProposal,
} from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedMessage(groupId: string, id: string): Promise<string> {
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body: 'context',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      mentions_others: 0,
      chord_visible: 1,
      auto_mirror: 1,
      is_proactive: 0,
      created_at: new Date().toISOString(),
    })
    .execute();
  return id;
}

describe('buildPendingProposalsSection', () => {
  it('lists pending proposals, excludes gmail ones on request, and nulls when empty', async () => {
    const userId = await createUser(db, 'brief-user');
    const personal = await ensurePersonalGroup(db, userId);
    const base = {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
    };

    const fromChat = await createProposal(db, {
      ...base,
      proposedByMessageId: await seedMessage(personal.id, 'msg1'),
      toolName: 'create_event',
      args: { title: 'Dentist', startsAt: '2026-08-01T10:00:00+00:00' },
      provenance: null,
    });
    await createProposal(db, {
      ...base,
      toolName: 'add_list_item',
      args: { listName: 'Costco', items: ['milk', 'bread'] },
      provenance: 'gmail:g-1',
    });

    const full = await buildPendingProposalsSection(db, userId);
    expect(full).toContain('2 suggestions');
    expect(full).toContain('Event: Dentist');
    expect(full).toContain('Costco: milk, bread');
    expect(full).toContain("To Do's");

    // Email section already listed the gmail magic → only the chat one here.
    const noGmail = await buildPendingProposalsSection(db, userId, { excludeGmail: true });
    expect(noGmail).toContain('1 suggestion');
    expect(noGmail).toContain('Event: Dentist');
    expect(noGmail).not.toContain('Costco');

    // Everything resolved → no section at all.
    await rejectProposal(db, { id: fromChat.id, resolvedByUserId: userId });
    await db.updateTable('proposals').set({ status: 'rejected' }).execute();
    expect(await buildPendingProposalsSection(db, userId)).toBeNull();
  });

  it('collapses a bundle to its create_trip lead with a linked count', async () => {
    const userId = await createUser(db, 'brief-bundle-user');
    const personal = await ensurePersonalGroup(db, userId);
    const base = {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      provenance: 'attachment:att1',
      bundleId: 'b1',
    };
    await createProposal(db, {
      ...base,
      toolName: 'add_travel_leg',
      args: { origin: 'SFO', destination: 'JFK' },
    });
    await createProposal(db, {
      ...base,
      toolName: 'create_trip',
      args: { name: 'NYC spring break', destination: 'NYC' },
    });
    await createProposal(db, {
      ...base,
      toolName: 'add_accommodation',
      args: { propertyName: 'Hotel' },
    });

    const section = await buildPendingProposalsSection(db, userId);
    expect(section).toContain('1 suggestion');
    expect(section).toContain('Trip: NYC spring break (+2 linked)');
    expect(section).not.toContain('SFO');
  });
});
