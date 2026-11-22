/**
 * ADR 0078 — the People screen's learned-facts + pending-suggestions feeds:
 * confirmed persona memories attach to the person they mention (proposed
 * ones stay in the Memory tab), and staged add_person / add_important_date
 * proposals surface until decided.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { stagePersonProposal } from '@/services/email/person-extraction.js';
import { upsertMemory } from '@/services/memory.service.js';
import {
  createPerson,
  learnedFactsForPeople,
  listPendingPersonSuggestions,
} from '@/services/people.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('People screen feeds', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'people-screen-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    return async () => closeTestDb(db);
  });

  it('attaches only CONFIRMED memories that mention the person', async () => {
    const alice = await createPerson(db, { ownerUserId: userId, displayName: 'Alice Doe' });
    const sam = await createPerson(db, { ownerUserId: userId, displayName: 'Sam' });

    await upsertMemory(db, {
      groupId,
      personaId: userId,
      scope: 'persona',
      key: 'spouse_name',
      value: 'Alice',
      source: 'extracted',
      status: 'confirmed',
    });
    await upsertMemory(db, {
      groupId,
      personaId: userId,
      scope: 'persona',
      key: 'hobby',
      value: 'Alice plays tennis on Saturdays',
      source: 'extracted',
      status: 'confirmed',
    });
    await upsertMemory(db, {
      groupId,
      personaId: userId,
      scope: 'persona',
      key: 'kid_school',
      value: 'Lincoln Elementary',
      source: 'extracted',
      status: 'confirmed',
    });
    // Proposed → must NOT surface on the People screen.
    await upsertMemory(db, {
      groupId,
      personaId: userId,
      scope: 'persona',
      key: 'sibling_name',
      value: 'Alice maybe?',
      source: 'extracted',
      status: 'proposed',
    });

    const facts = await learnedFactsForPeople(db, userId, [
      { id: alice.id, displayName: alice.displayName },
      { id: sam.id, displayName: sam.displayName },
    ]);

    // ADR 0333 — flipped: "hobby: Alice plays tennis" is saved as a fact
    // about the user, not about Alice; a name somewhere in a value no
    // longer puts it under her. A relationship fact whose whole value is her
    // name still does.
    const aliceFacts = facts.get(alice.id) ?? [];
    expect(aliceFacts.map((f) => f.key).sort()).toEqual(['spouse_name']);
    expect(facts.get(sam.id)).toBeUndefined();
  });

  it('lists pending person/date proposals and drops decided ones', async () => {
    const person = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_person',
      args: { displayName: 'Coach Dan', notes: 'coach (from email)' },
      provenance: 'gmail:tp',
    });
    await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'add_important_date',
      args: { personName: 'Alice', kind: 'birthday', date: '0000-05-12', recurs: true },
      provenance: 'gmail:tp2',
    });

    // The 'tp' thread is mirrored locally → its suggestion links to the
    // source email; 'tp2' has no local row → no link.
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: 'emt_tp',
        user_id: userId,
        gmail_thread_id: 'tp',
        subject: 'Practice schedule',
        snippet: 'from Coach Dan',
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const pending = await listPendingPersonSuggestions(db, userId);
    expect(pending).toHaveLength(2);
    expect(pending.find((p) => p.kind === 'person')).toMatchObject({
      title: 'Coach Dan',
      detail: 'coach (from email)',
      sourceHref: '/email/emt_tp',
    });
    expect(pending.find((p) => p.kind === 'date')).toMatchObject({
      title: 'Alice',
      detail: 'birthday · 0000-05-12',
      sourceHref: null,
    });

    await db
      .updateTable('proposals')
      .set({ status: 'rejected', resolved_at: new Date().toISOString() })
      .where('id', '=', person.id)
      .execute();
    const after = await listPendingPersonSuggestions(db, userId);
    expect(after).toHaveLength(1);
    expect(after[0].kind).toBe('date');
  });

  it('stagePersonProposal: relations propose once, never duplicate or re-add known people', async () => {
    // Fresh name → staged, and it reads as a learned person on the strip.
    expect(
      await stagePersonProposal(db, {
        userId,
        groupId,
        name: 'Alice',
        relationship: 'spouse',
        provenance: 'gmail:t1',
      }),
    ).toBe(true);
    const pending = await listPendingPersonSuggestions(db, userId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ title: 'Alice', detail: 'spouse (from email)' });

    // Same name again while pending → no duplicate.
    expect(
      await stagePersonProposal(db, {
        userId,
        groupId,
        name: 'alice',
        relationship: 'spouse',
        provenance: 'gmail:t2',
      }),
    ).toBe(false);
    expect(await listPendingPersonSuggestions(db, userId)).toHaveLength(1);

    // Already a known person → nothing staged.
    await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    expect(
      await stagePersonProposal(db, {
        userId,
        groupId,
        name: 'Ben',
        relationship: 'kid',
        provenance: 'gmail:t3',
      }),
    ).toBe(false);
  });
});
