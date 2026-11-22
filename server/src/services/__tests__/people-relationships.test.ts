/**
 * docs/notes/0189 — relationship edges (completing ADR 0016) and the
 * "tell me about X" person-profile read.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { upsertMemory } from '@/services/memory.service.js';
import {
  addPersonRelationship,
  confirmPersonRelationship,
  createPerson,
  getPersonProfile,
  listRelationshipEdges,
  normalizeRelation,
  rejectPersonRelationship,
} from '@/services/people.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('normalizeRelation', () => {
  it('maps free text to the canonical vocabulary', () => {
    expect(normalizeRelation('wife')).toBe('spouse');
    expect(normalizeRelation('Husband')).toBe('spouse');
    expect(normalizeRelation('Child')).toBe('kid');
    expect(normalizeRelation('travel companion')).toBe('travel_companion');
    expect(normalizeRelation('coach')).toBe('coach');
  });

  it('falls back to "other" for anything unrecognized', () => {
    expect(normalizeRelation('archnemesis')).toBe('other');
  });
});

describe('person_relationships', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'relationship-owner');
    return async () => closeTestDb(db);
  });

  it('extracted relationships are proposed; explicit ones are confirmed', async () => {
    const alice = await createPerson(db, { ownerUserId: userId, displayName: 'Alice' });
    const extracted = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: alice.id,
      relation: 'wife',
      source: 'extracted',
      provenance: 'gmail:t1',
    });
    expect(extracted).toMatchObject({ relation: 'spouse', status: 'proposed' });

    const explicit = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: alice.id,
      relation: 'friend',
      source: 'explicit',
    });
    expect(explicit).toMatchObject({ relation: 'friend', status: 'confirmed' });
  });

  it('dedupes on the exact (subject, related, relation) triple', async () => {
    const ben = await createPerson(db, { ownerUserId: userId, displayName: 'Ben' });
    const first = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: ben.id,
      relation: 'kid',
      source: 'extracted',
    });
    const second = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: ben.id,
      relation: 'kid',
      source: 'extracted',
    });
    expect(second.id).toBe(first.id);

    const edges = await listRelationshipEdges(db, userId, 'user', userId);
    expect(edges).toHaveLength(1);
  });

  it('a second relation kind between the same two subjects is a separate edge', async () => {
    const sam = await createPerson(db, { ownerUserId: userId, displayName: 'Sam' });
    await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: sam.id,
      relation: 'friend',
      source: 'extracted',
    });
    await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: sam.id,
      relation: 'teacher',
      source: 'extracted',
    });
    const edges = await listRelationshipEdges(db, userId, 'person', sam.id);
    expect(edges.map((e) => e.relation).sort()).toEqual(['friend', 'teacher']);
  });

  it('confirm flips status; reject only removes a still-proposed edge', async () => {
    const kevin = await createPerson(db, { ownerUserId: userId, displayName: 'Kevin' });
    const edge = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: kevin.id,
      relation: 'friend',
      source: 'extracted',
    });
    expect(edge.status).toBe('proposed');

    const confirmed = await confirmPersonRelationship(db, userId, edge.id);
    expect(confirmed?.status).toBe('confirmed');

    const rejected = await rejectPersonRelationship(db, userId, edge.id);
    expect(rejected).toBe(false); // already confirmed — reject refuses it
  });
});

describe('getPersonProfile', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'profile-owner');
    return async () => closeTestDb(db);
  });

  it('returns null for a person owned by someone else', async () => {
    const otherId = await createUser(db, 'someone-else');
    const theirPerson = await createPerson(db, { ownerUserId: otherId, displayName: 'Not Yours' });
    expect(await getPersonProfile(db, userId, theirPerson.id)).toBeNull();
  });

  it('assembles confirmed relationships and confirmed person-scoped facts, never proposed ones', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    const alice = await createPerson(db, { ownerUserId: userId, displayName: 'Alice' });

    const edge = await addPersonRelationship(db, {
      ownerUserId: userId,
      subjectType: 'user',
      subjectId: userId,
      relatedType: 'person',
      relatedId: alice.id,
      relation: 'spouse',
      source: 'extracted',
    });
    // Still proposed — must not show up yet.
    let profile = await getPersonProfile(db, userId, alice.id);
    expect(profile?.relationships).toHaveLength(0);
    await confirmPersonRelationship(db, userId, edge.id);

    await upsertMemory(db, {
      groupId: personal.id,
      scope: 'group',
      key: 'favorite_cuisine',
      value: 'sushi',
      source: 'extracted',
      status: 'confirmed',
      subjectType: 'person',
      subjectId: alice.id,
    });
    await upsertMemory(db, {
      groupId: personal.id,
      scope: 'group',
      key: 'allergy',
      value: 'peanuts',
      source: 'extracted',
      status: 'proposed', // must not appear
      subjectType: 'person',
      subjectId: alice.id,
    });

    profile = await getPersonProfile(db, userId, alice.id);
    expect(profile).not.toBeNull();
    expect(profile!.person.displayName).toBe('Alice');
    expect(profile!.relationships).toEqual([
      {
        relation: 'spouse',
        subjectName: expect.any(String),
        subjectType: 'user',
        relatedName: 'Alice',
        relatedType: 'person',
        status: 'confirmed',
      },
    ]);
    expect(profile!.facts).toEqual([{ key: 'favorite_cuisine', value: 'sushi' }]);
  });
});
