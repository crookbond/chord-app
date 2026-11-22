/**
 * Family-profile Phase 3a — the shared family facts (household + managed
 * personas) reach the bot's turn context and the morning briefing, while a
 * per-member `subject_type='user'` fact stays private.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildLlmContext } from '@/services/bot/context.js';
import { loadScanContext } from '@/services/proactive.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { seedGroupPersonas } from '@/db/personas-seed.js';
import { familyFactsForContext, upsertMemory } from '@/services/memory.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function addMember(db: Kysely<DB>, groupId: string, userId: string): Promise<void> {
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'member',
      tier: 'verified',
      joined_at: new Date().toISOString(),
    })
    .execute();
}

async function seedMessage(db: Kysely<DB>, groupId: string, userId: string): Promise<string> {
  const id = newId('m');
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: userId,
      kind: 'text',
      body: '@Chord what is Ben allergic to?',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 1,
      created_at: new Date().toISOString(),
      source: 'chat',
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 0,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  return id;
}

describe('family facts in context', () => {
  let db: Kysely<DB>;
  let owner: string;
  let spouse: string;
  let groupId: string;
  let benId: string;

  beforeEach(async () => {
    db = await openTestDb();
    owner = await createUser(db, 'ro');
    spouse = await createUser(db, 'mani');
    groupId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: owner })).id;
    await addMember(db, groupId, spouse);
    await seedGroupPersonas(db);
    benId = (await createPersona(db, { groupId, name: 'Ben', householdRole: 'child', managedBy: owner })).id;

    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'allergy',
      value: 'peanuts',
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'persona',
      subjectId: benId,
    });
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'home_address',
      value: '12 Oak St',
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'household',
      subjectId: null,
    });
    // A private per-member fact (about the spouse) — must NOT leak.
    await upsertMemory(db, {
      groupId,
      scope: 'persona',
      personaId: spouse,
      key: 'office',
      value: 'SECRET-OFFICE-42',
      source: 'explicit',
      status: 'confirmed',
    });
    // A proposed persona fact — not yet confirmed, must NOT appear.
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'shoe_size',
      value: 'PROPOSED-SIZE',
      source: 'extracted',
      status: 'proposed',
      subjectType: 'persona',
      subjectId: benId,
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('familyFactsForContext returns household + persona facts only, confirmed only', async () => {
    const facts = await familyFactsForContext(db, groupId);
    const keys = facts.map((f) => f.key).sort();
    expect(keys).toEqual(['allergy', 'home_address']);
    const ben = facts.find((f) => f.key === 'allergy')!;
    expect(ben.subjectLabel).toBe('Ben (child)');
    expect(facts.find((f) => f.key === 'home_address')!.subjectLabel).toBe('Household');
  });

  it('buildLlmContext surfaces the shared facts in a group turn, but not a member private fact', async () => {
    const msgId = await seedMessage(db, groupId, owner);
    const messages = await buildLlmContext(db, {
      groupId,
      isPersonal: false,
      triggerMessageId: msgId,
      triggeringUserId: owner,
      attachments: [],
      useNativeTools: false,
    });
    const sys = String(messages[0]?.content);
    expect(sys).toContain('Facts about the family');
    expect(sys).toContain('Ben (child)');
    expect(sys).toContain('allergy: peanuts');
    expect(sys).toContain('12 Oak St');
    expect(sys).not.toContain('SECRET-OFFICE-42');
    expect(sys).not.toContain('PROPOSED-SIZE');
  });

  it('a personal 1:1 turn gets no family-facts block', async () => {
    const personal = (await createGroup(db, { name: 'Mine', kind: 'personal', createdBy: owner })).id;
    const msgId = await seedMessage(db, personal, owner);
    const messages = await buildLlmContext(db, {
      groupId: personal,
      isPersonal: true,
      triggerMessageId: msgId,
      triggeringUserId: owner,
      attachments: [],
      useNativeTools: false,
    });
    expect(String(messages[0]?.content)).not.toContain('Facts about the family');
  });

  it('ADR 0333: two people sharing a label are never merged, and a fact whose person is gone is not shown', async () => {
    const otherGroup = (await createGroup(db, { name: 'Grandparents', kind: 'group', createdBy: owner })).id;
    const ben2 = (await createPersona(db, { groupId: otherGroup, name: 'Ben', householdRole: 'child', managedBy: owner })).id;
    const gone = (await createPersona(db, { groupId, name: 'Gone', householdRole: 'child', managedBy: owner })).id;
    for (const [g, subjectId, value] of [
      [groupId, benId, '155605322'],
      [otherGroup, ben2, '154800334'],
      [groupId, gone, '999'],
    ] as const) {
      await upsertMemory(db, {
        groupId: g,
        scope: 'group',
        key: 'global_entry_number',
        value,
        source: 'explicit',
        status: 'confirmed',
        subjectType: 'persona',
        subjectId,
      });
    }
    await db.deleteFrom('personas').where('id', '=', gone).execute();
    await db
      .insertInto('tasks')
      .values({
        id: newId('t'),
        group_id: groupId,
        title: 'Book dentist',
        status: 'open',
        due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        created_by: owner,
        created_at: new Date().toISOString(),
      })
      .execute();

    const ctx = await loadScanContext(db, owner);
    expect(ctx).toContain('global_entry_number: 155605322');
    expect(ctx).toContain('global_entry_number: 154800334');
    expect(ctx).not.toContain('999');
    expect(ctx).not.toContain('A family member');
  });

  it('the morning scan context carries FAMILY_FACTS with an [UPCOMING] tag on a dated school fact', async () => {
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'school_term_ends',
      value: 'last day of term',
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'household',
      subjectId: null,
      category: 'school',
      datedAt: soon,
    });
    // Give the scan something to brief about so it doesn't early-return.
    await db
      .insertInto('tasks')
      .values({
        id: newId('t'),
        group_id: groupId,
        title: 'Book dentist',
        status: 'open',
        due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        created_by: owner,
        created_at: new Date().toISOString(),
      })
      .execute();

    const ctx = await loadScanContext(db, owner);
    expect(ctx).toContain('FAMILY_FACTS:');
    expect(ctx).toContain('12 Oak St');
    expect(ctx).toMatch(/school_term_ends: last day of term \[UPCOMING in \d+d\]/);
  });
});
