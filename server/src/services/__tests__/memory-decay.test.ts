/**
 * docs/notes/0189 — the `memories` lighter-bar: an attribute fact
 * (subject_type 'person'|'persona') about an already-real subject gets
 * `auto_confirm_at` set when confidence is high; `decayMemories` promotes it
 * to confirmed once due, reusing `confirmMemory`'s supersede logic. A new
 * person/relationship claim is never eligible — only checked structurally
 * here via `upsertMemory`'s own eligibility gate, exercised through its
 * public surface rather than reaching into the private constant.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createPerson } from '@/services/people.service.js';
import { decayMemories, upsertMemory } from '@/services/memory.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('decayMemories', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'decay-owner');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    return async () => closeTestDb(db);
  });

  it('a high-confidence attribute fact about a real person gets a 7-day decay window', async () => {
    const ben = await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    const memory = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'allergy',
      value: 'peanuts',
      source: 'extracted',
      confidence: 0.9,
      status: 'proposed',
      subjectType: 'person',
      subjectId: ben.id,
    });
    expect(memory.autoConfirmAt).not.toBeNull();
  });

  it('a low-confidence attribute fact never decays', async () => {
    const ben = await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    const memory = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'allergy',
      value: 'peanuts',
      source: 'extracted',
      confidence: 0.65,
      status: 'proposed',
      subjectType: 'person',
      subjectId: ben.id,
    });
    expect(memory.autoConfirmAt).toBeNull();
  });

  it('a self-fact about the asker (subject_type user) never decays, only person/persona do', async () => {
    const memory = await upsertMemory(db, {
      groupId,
      personaId: userId,
      scope: 'persona',
      key: 'favorite_cuisine',
      value: 'thai',
      source: 'passive',
      confidence: 0.95,
      status: 'proposed',
      subjectType: 'user',
      subjectId: userId,
    });
    expect(memory.autoConfirmAt).toBeNull();
  });

  it('promotes a due row to confirmed and supersedes the prior confirmed value', async () => {
    const ben = await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    const prior = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'favorite_cuisine',
      value: 'italian',
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'person',
      subjectId: ben.id,
    });
    const due = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'favorite_cuisine',
      value: 'thai',
      source: 'extracted',
      confidence: 0.9,
      status: 'proposed',
      subjectType: 'person',
      subjectId: ben.id,
    });
    // Force it due — `upsertMemory` sets +7 days; the sweep only acts on
    // rows whose `auto_confirm_at` has passed.
    await db
      .updateTable('memories')
      .set({ auto_confirm_at: new Date(Date.now() - 1000).toISOString() })
      .where('id', '=', due.id)
      .execute();

    const decayed = await decayMemories(db);
    expect(decayed).toEqual([{ id: due.id, groupId, supersededId: prior.id }]);

    const row = await db.selectFrom('memories').selectAll().where('id', '=', due.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
    const priorRow = await db
      .selectFrom('memories')
      .selectAll()
      .where('id', '=', prior.id)
      .executeTakeFirstOrThrow();
    expect(priorRow.superseded_by).toBe(due.id);
  });

  it('leaves a row with no auto_confirm_at untouched', async () => {
    const ben = await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    const memory = await upsertMemory(db, {
      groupId,
      scope: 'group',
      key: 'allergy',
      value: 'peanuts',
      source: 'extracted',
      confidence: 0.65, // below the lighter-bar threshold
      status: 'proposed',
      subjectType: 'person',
      subjectId: ben.id,
    });
    const decayed = await decayMemories(db);
    expect(decayed).toEqual([]);
    const row = await db.selectFrom('memories').selectAll().where('id', '=', memory.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('proposed');
  });
});
