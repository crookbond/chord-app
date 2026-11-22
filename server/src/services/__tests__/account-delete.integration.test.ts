/**
 * Account deletion (ADR 0043). The user-row FK graph mixes `ON DELETE
 * CASCADE`, `SET NULL`, and bare (delete-blocking) `REFERENCES users(id)`, so
 * `deleteAccount` has to tear down in dependency order. This test exercises a
 * realistic two-user setup and asserts the two halves of the contract:
 *
 *   - everything the deleted user solely owns is gone (personal group + its
 *     tasks/lists, personal files, people, calendar sources, sessions);
 *   - the shared group survives for the remaining member, with ownership and
 *     uploaded files reassigned and the deleted user's provenance anonymized.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { deleteAccount } from '@/services/account.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const now = () => new Date().toISOString();

describe('deleteAccount', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('erases solo-owned data and anonymizes the user in shared groups', async () => {
    const alice = await createUser(db, 'alice', 'Alice');
    const bob = await createUser(db, 'bob', 'Bob');

    // Alice's personal group + its content.
    const personal = await createGroup(db, {
      name: 'My Chord',
      kind: 'personal',
      createdBy: alice,
    });
    await db
      .insertInto('tasks')
      .values({ id: 't_personal', group_id: personal.id, title: 'pay rent', status: 'open', created_by: alice, created_at: now() })
      .execute();
    await db
      .insertInto('lists')
      .values({ id: 'l_personal', group_id: personal.id, name: 'Costco', created_by: alice, created_at: now() })
      .execute();

    // Shared group Alice created; Bob is a member.
    const shared = await createGroup(db, { name: 'Family', kind: 'group', createdBy: alice });
    await addMember(db, shared.id, bob, 'member');
    await db
      .insertInto('tasks')
      .values({ id: 't_shared', group_id: shared.id, title: 'book flights', status: 'open', created_by: alice, assignee_id: alice, created_at: now() })
      .execute();

    // Personal file (deleted) + shared-group file (reassigned to Bob).
    await db.insertInto('attachments').values({
      id: 'a_personal', scope_kind: 'user', scope_id: alice, uploaded_by: alice,
      filename: 'passport.pdf', mime_type: 'application/pdf', size: 1, path: 'x/a_personal.pdf',
      summary: null, extracted_text: null, image_meta: null, pinned: 0, indexed_at: null, created_at: now(),
    }).execute();
    await db.insertInto('attachments').values({
      id: 'a_shared', scope_kind: 'group', scope_id: shared.id, uploaded_by: alice,
      filename: 'itinerary.pdf', mime_type: 'application/pdf', size: 1, path: 'x/a_shared.pdf',
      summary: null, extracted_text: null, image_meta: null, pinned: 0, indexed_at: null, created_at: now(),
    }).execute();

    // Person + important date, a calendar source, and a session.
    await db.insertInto('people').values({ id: 'p1', owner_user_id: alice, display_name: 'Mom', notes: null, created_at: now(), updated_at: now() }).execute();
    await db.insertInto('important_dates').values({ id: 'd1', person_id: 'p1', kind: 'birthday', date: '1960-04-01', recurs: 1 }).execute();
    await db.insertInto('calendar_sources').values({ id: 'cs1', user_id: alice, google_calendar_id: 'primary', summary: 'Primary', access_role: 'owner', is_primary: 1, selected_in_google: 1, counts_for_busy_auto: 1, counts_for_busy_override: null, first_seen_at: now(), last_seen_at: now() }).execute();
    await db.insertInto('sessions').values({ token: 'sess_alice', user_id: alice, created_at: now(), last_seen_at: now() }).execute();

    const summary = await deleteAccount(db, alice);

    expect(summary).toMatchObject({ groupsDeleted: 1, groupsReassigned: 1, attachmentsDeleted: 1 });

    // Alice and everything she solely owns is gone.
    expect(await db.selectFrom('users').select('id').where('id', '=', alice).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('groups').select('id').where('id', '=', personal.id).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('tasks').select('id').where('id', '=', 't_personal').executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('lists').select('id').where('id', '=', 'l_personal').executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('attachments').select('id').where('id', '=', 'a_personal').executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('people').select('id').where('owner_user_id', '=', alice).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('important_dates').select('id').where('id', '=', 'd1').executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('calendar_sources').select('id').where('user_id', '=', alice).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('sessions').select('token').where('user_id', '=', alice).executeTakeFirst()).toBeUndefined();
    expect(await db.selectFrom('group_members').select('user_id').where('user_id', '=', alice).executeTakeFirst()).toBeUndefined();

    // Bob and the shared group survive.
    expect(await db.selectFrom('users').select('id').where('id', '=', bob).executeTakeFirst()).toBeDefined();
    const sharedGroup = await db.selectFrom('groups').selectAll().where('id', '=', shared.id).executeTakeFirst();
    expect(sharedGroup?.created_by).toBe(bob); // ownership handed to Bob

    const bobMembership = await db.selectFrom('group_members').selectAll().where('group_id', '=', shared.id).where('user_id', '=', bob).executeTakeFirst();
    expect(bobMembership?.role).toBe('owner'); // promoted, Alice was owner

    // Shared content kept but anonymized; shared file reassigned.
    const sharedTask = await db.selectFrom('tasks').selectAll().where('id', '=', 't_shared').executeTakeFirst();
    expect(sharedTask).toBeDefined();
    expect(sharedTask?.created_by).toBeNull();
    expect(sharedTask?.assignee_id).toBeNull();

    const sharedFile = await db.selectFrom('attachments').selectAll().where('id', '=', 'a_shared').executeTakeFirst();
    expect(sharedFile?.uploaded_by).toBe(bob);
  });
});
