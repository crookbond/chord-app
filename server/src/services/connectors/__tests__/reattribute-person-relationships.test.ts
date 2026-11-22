/**
 * docs/notes/0189 — an account fold (Apple → Google, `foldSignInAccountInto`)
 * calls `reattributeUserFkColumns` to move every row a shadow account owned
 * onto the real account. `person_relationships` needed two things: the plain
 * `owner_user_id` column (like `people`), and — because `subject_id`/
 * `related_id` are polymorphic — a re-point of whichever side holds a
 * `users.id` when its type is 'user', independent of ownership, with dedup
 * against the table's unique index so a fold can't crash on a collision.
 */
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { reattributeUserFkColumns } from '@/services/connectors/pairing.service.js';
import { addPersonRelationship, createPerson } from '@/services/people.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('reattributeUserFkColumns — person_relationships', () => {
  let db: Kysely<DB>;
  let shadowId: string;
  let ownerId: string;

  beforeEach(async () => {
    db = await openTestDb();
    shadowId = await createUser(db, 'shadow-account');
    ownerId = await createUser(db, 'real-account');
    return async () => closeTestDb(db);
  });

  it('moves owner_user_id from the shadow to the real account', async () => {
    const alice = await createPerson(db, { ownerUserId: shadowId, displayName: 'Alice' });
    const edge = await addPersonRelationship(db, {
      ownerUserId: shadowId,
      subjectType: 'user',
      subjectId: shadowId,
      relatedType: 'person',
      relatedId: alice.id,
      relation: 'spouse',
      source: 'extracted',
    });

    await db.transaction().execute((trx) => reattributeUserFkColumns(trx, shadowId, ownerId));

    const row = await db
      .selectFrom('person_relationships')
      .selectAll()
      .where('id', '=', edge.id)
      .executeTakeFirstOrThrow();
    expect(row.owner_user_id).toBe(ownerId);
    // The polymorphic subject_id must ALSO move — it held the shadow's own
    // user id, not just the row's ownership column.
    expect(row.subject_id).toBe(ownerId);
  });

  it('moves a provisional person (docs/notes/0191) with its owner', async () => {
    await db
      .insertInto('provisional_people')
      .values({
        id: 'p_prov_1',
        owner_user_id: shadowId,
        display_name: 'Robert Wells',
        email: null,
        notes: null,
        proposal_id: null,
        created_at: new Date().toISOString(),
      })
      .execute();

    await db.transaction().execute((trx) => reattributeUserFkColumns(trx, shadowId, ownerId));

    const row = await db
      .selectFrom('provisional_people')
      .select('owner_user_id')
      .where('id', '=', 'p_prov_1')
      .executeTakeFirstOrThrow();
    expect(row.owner_user_id).toBe(ownerId);
  });

  it('re-points related_id when its type is "user", independent of ownership', async () => {
    // owner_user_id here is a THIRD user (e.g. the asker in whatever group
    // this edge lives under) — only related_id points at the shadow.
    const thirdParty = await createUser(db, 'third-party-owner');
    const edge = await addPersonRelationship(db, {
      ownerUserId: thirdParty,
      subjectType: 'user',
      subjectId: thirdParty,
      relatedType: 'user',
      relatedId: shadowId,
      relation: 'friend',
      source: 'extracted',
    });

    await db.transaction().execute((trx) => reattributeUserFkColumns(trx, shadowId, ownerId));

    const row = await db
      .selectFrom('person_relationships')
      .selectAll()
      .where('id', '=', edge.id)
      .executeTakeFirstOrThrow();
    expect(row.owner_user_id).toBe(thirdParty); // untouched — this row was never the shadow's
    expect(row.related_id).toBe(ownerId);
  });

  it('dedups instead of colliding when the real account already has the identical edge', async () => {
    const kevin = await createPerson(db, { ownerUserId: shadowId, displayName: 'Kevin' });
    // Same person id can be pointed at from both accounts in this contrived
    // case (the real test is: does the unique index survive the move).
    await addPersonRelationship(db, {
      ownerUserId: ownerId,
      subjectType: 'user',
      subjectId: ownerId,
      relatedType: 'person',
      relatedId: kevin.id,
      relation: 'friend',
      source: 'extracted',
    });
    const shadowEdge = await addPersonRelationship(db, {
      ownerUserId: shadowId,
      subjectType: 'user',
      subjectId: shadowId,
      relatedType: 'person',
      relatedId: kevin.id,
      relation: 'friend',
      source: 'extracted',
    });

    await expect(
      db.transaction().execute((trx) => reattributeUserFkColumns(trx, shadowId, ownerId)),
    ).resolves.not.toThrow();

    const survivors = await db
      .selectFrom('person_relationships')
      .selectAll()
      .where('related_id', '=', kevin.id)
      .execute();
    expect(survivors).toHaveLength(1); // the shadow's duplicate was dropped, not doubled
    expect(survivors[0]!.owner_user_id).toBe(ownerId);

    const shadowRowGone = await db
      .selectFrom('person_relationships')
      .select('id')
      .where('id', '=', shadowEdge.id)
      .executeTakeFirst();
    expect(shadowRowGone).toBeUndefined();
  });
});
