/**
 * Email + pending to-dos in search (both paths: the user-facing ADR 0062
 * `searchHits` and the bot's ADR 0059 `searchEverything`).
 *
 * The load-bearing rule here is the scope one: mail is personal and has no
 * group of its own, so it is searchable ONLY from the personal 1:1. Surfacing
 * it in a shared group's search would push a member's private mail into a
 * shared context - the thing ADR 0032 exists to prevent.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { storageCategoryId } from '@/services/email/classification.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { searchEverything, searchHits } from '@/services/search.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedEmail(
  userId: string,
  subject: string,
  opts: { snippet?: string; from?: string; archived?: boolean; labels?: string[] } = {},
): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: id,
      subject,
      snippet: opts.snippet ?? '',
      from_email: opts.from ?? 'sender@example.com',
      is_archived: opts.archived ? 1 : 0,
      gmail_label_ids: JSON.stringify(opts.labels ?? (opts.archived ? [] : ['INBOX'])),
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

async function seedCategory(userId: string, title: string, localId: string): Promise<string> {
  const id = storageCategoryId(userId, localId);
  const now = new Date().toISOString();
  await db
    .insertInto('email_categories')
    .values({
      id,
      user_id: userId,
      parent_id: null,
      title,
      depth: 0,
      sort_order: 0,
      color: null,
      icon: null,
      gmail_label_id: null,
      updated_at: now,
    })
    .execute();
  return id;
}

async function setThreadCategory(threadId: string, categoryId: string): Promise<void> {
  await db
    .updateTable('email_threads')
    .set({ category_id: categoryId })
    .where('id', '=', threadId)
    .execute();
}

describe('category-matched email search (classifier replaces keyword match)', () => {
  it('surfaces a thread with no literal query text when its category matches', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const catId = await seedCategory(uid, 'School forms', 'mk:school-forms');
    const threadId = await seedEmail(uid, 'Permission slip due Friday', {
      snippet: 'please sign and return',
    });
    await setThreadCategory(threadId, catId);

    const bot = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'school',
      categories: ['emails'],
    });
    expect(bot.emails.map((e) => e.id)).toEqual([threadId]);

    const user = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'school',
      types: ['email'],
    });
    expect(user.hits.filter((h) => h.entityType === 'email').map((h) => h.entityId)).toEqual([
      threadId,
    ]);
  });

  it('excludes a thread that literally says the word but is classified elsewhere', async () => {
    // The exact case that motivated this feature: "$125 Chase High School
    // Checking promotion" literally contains "school" but is a bank promo,
    // not a school thread - the classifier already knows that.
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const schoolCat = await seedCategory(uid, 'School forms', 'mk:school-forms');
    const financeCat = await seedCategory(uid, 'Finance', 'mk:finance');
    const schoolThread = await seedEmail(uid, 'Permission slip due Friday');
    await setThreadCategory(schoolThread, schoolCat);
    const promoThread = await seedEmail(uid, '$125 Chase High School Checking promotion', {
      snippet: 'open an account and get a bonus',
    });
    await setThreadCategory(promoThread, financeCat);

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'school',
      categories: ['emails'],
    });

    expect(out.emails.map((e) => e.id)).toEqual([schoolThread]);
  });

  it('unions subtrees when more than one category name matches', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const sports = await seedCategory(uid, 'Kids sports', 'mk:kids-sports');
    const school = await seedCategory(uid, 'Kids school', 'mk:kids-school');
    const t1 = await seedEmail(uid, 'Soccer practice moved');
    await setThreadCategory(t1, sports);
    const t2 = await seedEmail(uid, 'Homework reminder');
    await setThreadCategory(t2, school);

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'kids',
      categories: ['emails'],
    });

    expect(out.emails.map((e) => e.id).sort()).toEqual([t1, t2].sort());
  });

  it('excludes a catch-all bucket from category matching', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const catchAll = await seedCategory(uid, 'Other', 'mk:other');
    const misfiled = await seedEmail(uid, 'Random newsletter', {
      snippet: 'nothing about the query word here',
    });
    await setThreadCategory(misfiled, catchAll);

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'other',
      categories: ['emails'],
    });

    // If "Other" were allowed to match, this thread would surface even
    // though nothing in it says "other" - proving the catch-all exclusion,
    // not just that keyword search still works.
    expect(out.emails).toHaveLength(0);
  });

  it('falls through to keyword search when nothing classified matches the query', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedCategory(uid, 'Finance', 'mk:finance');
    await seedEmail(uid, 'Plumber coming Tuesday', { snippet: 'the plumber comes at noon' });

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'plumber',
      categories: ['emails'],
    });

    expect(out.emails).toHaveLength(1);
  });

  it('an unclassified mailbox behaves exactly as before (no category rows at all)', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'School play tickets on sale');

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'school',
      categories: ['emails'],
    });

    expect(out.emails).toHaveLength(1);
  });
});

describe('email in the user-facing search', () => {
  it('finds a mail thread by subject from the personal chat', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Permission slip for the aquarium trip');

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'permission slip',
    });

    const email = out.hits.filter((h) => h.entityType === 'email');
    expect(email).toHaveLength(1);
    expect(email[0].title).toContain('Permission slip');
    expect(email[0].href).toBe(`/email/${email[0].entityId}`);
  });

  it('matches on the sender and the snippet, not just the subject', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Re: hello', { snippet: 'the plumber comes Tuesday' });

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'plumber',
    });

    expect(out.hits.some((h) => h.entityType === 'email')).toBe(true);
  });

  it('does NOT return mail when searching inside a shared group', async () => {
    const uid = await createUser(db, 'alice');
    const shared = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    await seedEmail(uid, 'Permission slip for the aquarium trip');

    const out = await searchHits(db, {
      userId: uid,
      groupId: shared.id,
      crossGroup: false,
      query: 'permission slip',
    });

    expect(out.hits.filter((h) => h.entityType === 'email')).toHaveLength(0);
  });

  it('never returns another user\'s mail', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const bobPersonal = await ensurePersonalGroup(db, bob);
    await seedEmail(alice, 'Alice private permission slip');

    const out = await searchHits(db, {
      userId: bob,
      groupId: bobPersonal.id,
      crossGroup: true,
      query: 'permission slip',
    });

    expect(out.hits.filter((h) => h.entityType === 'email')).toHaveLength(0);
  });

  it('finds archived mail — not knowing where it went is why you search', async () => {
    // This reverses the ADR 0073 posture ON THIS SURFACE ONLY (ADR 0108):
    // hiding archived mail from the LISTINGS is what keeps dealt-with threads
    // out of the decision queue, but a search that silently skips half the
    // mailbox answers a question nobody asked.
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Permission slip for the aquarium trip', { archived: true });

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'permission slip',
    });

    expect(out.hits.filter((h) => h.entityType === 'email')).toHaveLength(1);
  });

  it('finds mail you sent', async () => {
    // The case that forced this: a sent copy mirrors as SENT with no INBOX, so
    // `is_archived = 1` made every message the user sent unfindable.
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Borrowing the ladder', { archived: true, labels: ['SENT'] });

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'borrowing the ladder',
    });

    expect(out.hits.filter((h) => h.entityType === 'email')).toHaveLength(1);
  });

  it('still leaves deleted mail out', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Permission slip for the aquarium trip', {
      archived: true,
      labels: ['TRASH'],
    });

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'permission slip',
    });

    expect(out.hits.filter((h) => h.entityType === 'email')).toHaveLength(0);
  });

  it('the bot path agrees with the user path on all three', async () => {
    // ADR 0085: one matching rule for both surfaces. Visibility is part of it.
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedEmail(uid, 'Ladder archived', { archived: true });
    await seedEmail(uid, 'Ladder sent', { archived: true, labels: ['SENT'] });
    await seedEmail(uid, 'Ladder trashed', { archived: true, labels: ['TRASH'] });

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'ladder',
      categories: ['emails'],
    });

    expect((out.emails ?? []).map((e) => e.subject).sort()).toEqual([
      'Ladder archived',
      'Ladder sent',
    ]);
  });
});

describe('pending to-dos in search', () => {
  async function seedPendingProposal(
    userId: string,
    groupId: string,
    title: string,
  ): Promise<void> {
    await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title, startsAt: new Date().toISOString() },
      provenance: null,
    });
  }

  it('finds a pending proposal by its title', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedPendingProposal(uid, personal.id, 'Dentist for Maya');

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'dentist',
    });

    const todos = out.hits.filter((h) => h.entityType === 'todo');
    expect(todos).toHaveLength(1);
    expect(todos[0].title).toBe('Dentist for Maya');
    expect(todos[0].href).toBe('/catchup/actions');
  });

  it('ignores proposals that are no longer pending', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await seedPendingProposal(uid, personal.id, 'Dentist for Maya');
    await db.updateTable('proposals').set({ status: 'confirmed' }).execute();

    const out = await searchHits(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'dentist',
    });

    expect(out.hits.filter((h) => h.entityType === 'todo')).toHaveLength(0);
  });

  it('does not leak a to-do from a group the searcher is not in', async () => {
    const alice = await createUser(db, 'alice');
    const bob = await createUser(db, 'bob');
    const bobGroup = await createGroup(db, { name: 'Bob only', kind: 'group', createdBy: bob });
    const alicePersonal = await ensurePersonalGroup(db, alice);
    await seedPendingProposal(bob, bobGroup.id, 'Dentist for Maya');

    const out = await searchHits(db, {
      userId: alice,
      groupId: alicePersonal.id,
      crossGroup: true,
      query: 'dentist',
    });

    expect(out.hits.filter((h) => h.entityType === 'todo')).toHaveLength(0);
  });
});

describe('the bot search tool (ADR 0059)', () => {
  it('returns emails with their action from the personal chat', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const id = await seedEmail(uid, 'Permission slip for the aquarium trip');
    await db.updateTable('email_threads').set({ action: 'to_do' }).where('id', '=', id).execute();

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'permission slip',
    });

    expect(out.emails).toHaveLength(1);
    expect(out.emails[0].action).toBe('to_do');
    expect(out.totalHits).toBeGreaterThan(0);
  });

  it('returns no emails in a shared group, so the bot cannot leak them', async () => {
    const uid = await createUser(db, 'alice');
    const shared = await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid });
    await seedEmail(uid, 'Permission slip for the aquarium trip');

    const out = await searchEverything(db, {
      userId: uid,
      groupId: shared.id,
      crossGroup: false,
      query: 'permission slip',
    });

    expect(out.emails).toHaveLength(0);
  });

  it('carries a group NAME on a to-do hit, never a raw id (ADR 0032 scrubber)', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    const shared = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: uid });
    await createProposal(db, {
      groupId: shared.id,
      proposedByUserId: uid,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Dentist for Maya', startsAt: new Date().toISOString() },
      provenance: null,
    });

    const out = await searchEverything(db, {
      userId: uid,
      groupId: personal.id,
      crossGroup: true,
      query: 'dentist',
    });

    expect(out.todos).toHaveLength(1);
    expect(out.todos[0].group).toBe('Doe Family');
    expect(JSON.stringify(out.todos[0])).not.toContain(shared.id);
  });
});
