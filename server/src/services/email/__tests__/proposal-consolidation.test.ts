/**
 * Duplicate email-derived event proposals collapse to one. A booking arrives
 * as several Gmail threads (confirmation, reminder, "coming up"), each mined
 * independently — without dedup the user sees the same "Stay at X" card N
 * times. Staging-time dedup skips repeats (or replaces them when the new
 * extraction is richer); a per-pass sweep heals duplicates that already
 * accumulated.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import {
  consolidateDuplicateEventProposals,
  consolidateDuplicateListItemProposals,
  isSameSuggestedEvent,
  isSameSuggestedListItem,
  retractPendingEmailEventProposalsNear,
  retractProposalsCoveredByExistingEvents,
} from '@/services/event-convergence.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * Fixture dates are relative (the ADR 0100 precedent, now load-bearing for
 * ADR 0137 too). A literal rots: once the day passes, staging refuses the
 * event and the sweep retracts it, so the test goes green having exercised
 * nothing at all.
 */
const day = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const D0 = day(30);
const D1 = day(31);
const D2 = day(32);

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

// ingestClassification snapshot-replaces the whole tree, so seed all threads
// first and classify them in one call.
async function seedClassifiedThreads(userId: string, threads: [gid: string, subject: string][]) {
  const now = new Date().toISOString();
  for (const [gid, subject] of threads) {
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  await ingestClassification(db, userId, {
    version: 1,
    userId,
    categories: [{ id: 'travel', parentId: null, title: 'Travel', depth: 0 }],
    assignments: threads.map(([gid]) => ({ gmailThreadId: gid, categoryId: 'travel' })),
  });
}

const stayArgs = (over: Record<string, unknown> = {}) => ({
  title: 'Stay at Teresita Home JKIA',
  startsAt: `${D0}T17:00:00+03:00`,
  ...over,
});

async function stagePending(userId: string, args: Record<string, unknown>, gid: string) {
  const personal = await ensurePersonalGroup(db, userId);
  return createProposal(db, {
    groupId: personal.id,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_event',
    args,
    provenance: `gmail:${gid}`,
    targetGroupId: null,
  });
}

const pendingEventProposals = () =>
  db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'status'])
    .where('tool_name', '=', 'create_event')
    .where('status', '=', 'pending')
    .execute();

describe('isSameSuggestedEvent', () => {
  it('matches exact, containment ("…, Nairobi" suffix), and hours of time drift', () => {
    const a = { title: 'Stay at Teresita Home JKIA, Nairobi', startsAt: `${D0}T17:00:00+03:00` };
    expect(isSameSuggestedEvent(a, stayArgs())).toBe(true); // containment
    expect(isSameSuggestedEvent(a, stayArgs({ startsAt: `${D0}T23:00:00+03:00` }))).toBe(true); // 6h drift
    expect(isSameSuggestedEvent(a, stayArgs({ startsAt: `${D2}T17:00:00+03:00` }))).toBe(false); // 2 days
    expect(
      isSameSuggestedEvent(a, { title: 'Flight to Nairobi', startsAt: `${D0}T17:00:00+03:00` }),
    ).toBe(false); // different thing, same slot
  });

  it('a shared invite UID is identity regardless of title/time', () => {
    const a = stayArgs({ externalUid: 'uid-1' });
    expect(isSameSuggestedEvent(a, { title: 'Other', startsAt: `${D1}T10:00:00Z`, externalUid: 'uid-1' })).toBe(
      true,
    );
    expect(isSameSuggestedEvent(a, stayArgs({ externalUid: 'uid-2' }))).toBe(false);
  });
});

describe('staging-time dedup', () => {
  it('a second thread extracting the same stay stages nothing', async () => {
    const userId = await createUser(db, 'dedup-stage');
    await seedClassifiedThreads(userId, [
      ['g-confirm', 'Booking confirmed: Teresita Home JKIA'],
      ['g-remind', 'Your stay is coming up'],
    ]);

    const stub: EmailExtractor = {
      async extract() {
        return { kind: 'event', ...stayArgs() };
      },
    };
    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.processed).toBe(2);
    expect(res.events).toBe(1);
    expect(await pendingEventProposals()).toHaveLength(1);
  });

  it('a richer extraction (location) replaces the pending bare one', async () => {
    const userId = await createUser(db, 'dedup-upgrade');
    await stagePending(userId, stayArgs(), 'g-old');
    await seedClassifiedThreads(userId, [['g-new', 'Booking update']]);

    const stub: EmailExtractor = {
      async extract() {
        return { kind: 'event', ...stayArgs({ location: 'Teresita Home JKIA, Nairobi' }) };
      },
    };
    await runEmailMagics(db, userId, { extractor: stub });

    const pending = await pendingEventProposals();
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].args_json)).toMatchObject({
      location: 'Teresita Home JKIA, Nairobi',
    });
  });
});

describe('consolidateDuplicateEventProposals', () => {
  it('collapses an accumulated pile to the richest card, leaves distinct events alone', async () => {
    const userId = await createUser(db, 'dedup-sweep');
    await stagePending(userId, stayArgs(), 'g-1');
    await stagePending(userId, stayArgs({ title: 'Stay at Teresita Home JKIA, Nairobi' }), 'g-2');
    await stagePending(userId, stayArgs({ startsAt: `${D0}T23:00:00+03:00` }), 'g-3');
    await stagePending(
      userId,
      stayArgs({ location: 'Teresita Home JKIA, Nairobi', endsAt: `${D1}T11:00:00+03:00` }),
      'g-4',
    );
    await stagePending(
      userId,
      { title: 'Flight to Nairobi', startsAt: `${D0}T10:00:00+03:00` },
      'g-5',
    );

    const expired = await consolidateDuplicateEventProposals(db, userId);
    expect(expired).toBe(3);

    const pending = await pendingEventProposals();
    expect(pending).toHaveLength(2);
    const titles = pending.map((p) => JSON.parse(p.args_json) as { title: string; location?: string });
    expect(titles.some((t) => t.title === 'Flight to Nairobi')).toBe(true);
    expect(titles.some((t) => t.location === 'Teresita Home JKIA, Nairobi')).toBe(true); // richest kept
  });

  it('list-item magics: a LinkedIn invite + its reminder yield ONE to-do', async () => {
    const userId = await createUser(db, 'dedup-listitem');
    await seedClassifiedThreads(userId, [
      ['g-invite', 'Stephen Walker wants to connect'],
      ['g-remind', 'Reminder: Stephen Walker is waiting'],
    ]);
    const stub: EmailExtractor = {
      async extract() {
        return { kind: 'list', listName: 'To-dos', item: 'Add Stephen Walker on LinkedIn' };
      },
    };
    const res = await runEmailMagics(db, userId, { extractor: stub });
    expect(res.processed).toBe(2);
    expect(res.lists).toBe(1);

    const pending = await db
      .selectFrom('proposals')
      .select('id')
      .where('tool_name', '=', 'add_list_item')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(1);
  });

  it('list-item sweep collapses an accumulated pile, distinct items survive', async () => {
    const userId = await createUser(db, 'dedup-listsweep');
    const personal = await ensurePersonalGroup(db, userId);
    const stage = (item: string, gid: string) =>
      createProposal(db, {
        groupId: personal.id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'add_list_item',
        args: { listName: 'To-dos', items: [item] },
        provenance: `gmail:${gid}`,
        targetGroupId: null,
      });
    await stage('Add Stephen Walker on LinkedIn', 'g-1');
    await stage('Add Stephen Walker on LinkedIn', 'g-2');
    await stage('add stephen walker on linkedin!', 'g-3'); // case/punct variant
    await stage('RSVP to the bake sale', 'g-4');

    expect(await consolidateDuplicateListItemProposals(db, userId)).toBe(2);
    const pending = await db
      .selectFrom('proposals')
      .select('args_json')
      .where('tool_name', '=', 'add_list_item')
      .where('status', '=', 'pending')
      .execute();
    expect(pending).toHaveLength(2);
  });

  it('isSameSuggestedListItem requires exact normalized equality (no containment)', () => {
    const a = { listName: 'To-dos', item: 'Buy milk' };
    expect(isSameSuggestedListItem(a, { listName: 'To-dos', item: 'buy milk!' })).toBe(true);
    expect(isSameSuggestedListItem(a, { listName: 'To-dos', item: 'Buy milk and eggs' })).toBe(false);
    expect(isSameSuggestedListItem(a, { listName: 'Shopping', item: 'Buy milk' })).toBe(false);
  });

  it('wide net: an arriving invite retracts a same-title proposal hours off', async () => {
    const userId = await createUser(db, 'dedup-widenet');
    await stagePending(userId, stayArgs(), 'g-1'); // 17:00
    await stagePending(userId, { title: 'Flight to Nairobi', startsAt: `${D0}T21:00:00+03:00` }, 'g-2');

    // Real calendar item at 23:00 same day, matching title → the 6h-off
    // proposal goes; the different-title one within 2h stays.
    const n = await retractPendingEmailEventProposalsNear(
      db,
      userId,
      `${D0}T23:00:00+03:00`,
      'Stay at Teresita Home JKIA, Nairobi',
    );
    expect(n).toBe(1);
    const left = await pendingEventProposals();
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0].args_json)).toMatchObject({ title: 'Flight to Nairobi' });
  });

  it('sweep: a proposal whose slot an existing calendar event covers retracts', async () => {
    const userId = await createUser(db, 'dedup-covered');
    const personal = await ensurePersonalGroup(db, userId);
    await createEvent(db, {
      groupId: personal.id,
      createdBy: userId,
      title: 'test',
      startsAt: `${D0}T15:00:00-04:00`,
    });
    // LLM-parsed twin of the same meeting, hours off.
    await stagePending(userId, { title: 'test', startsAt: `${D0}T09:00:00-04:00` }, 'g-1');
    // Unrelated same-day proposal survives.
    await stagePending(userId, { title: 'Dentist', startsAt: `${D0}T15:30:00-04:00` }, 'g-2');

    expect(await retractProposalsCoveredByExistingEvents(db, userId)).toBe(1);
    const left = await pendingEventProposals();
    expect(left).toHaveLength(1);
    expect(JSON.parse(left[0].args_json)).toMatchObject({ title: 'Dentist' });
  });

  it('a UID-bearing proposal still merges with a non-UID one via title+time, but two different UIDs never merge even at the same title/time', async () => {
    const userId = await createUser(db, 'dedup-uid-edges');
    // Invite-derived (has externalUid) and independently LLM-mined (no UID)
    // proposals for the same meeting — must still merge on title+time, since
    // isSameSuggestedEvent only skips that check when BOTH sides carry a UID.
    await stagePending(userId, { title: 'Sync with Bill', startsAt: `${D0}T09:00:00-04:00`, externalUid: 'uid-a' }, 'g-1');
    await stagePending(userId, { title: 'Sync with Bill', startsAt: `${D0}T09:05:00-04:00` }, 'g-2');
    // Two DIFFERENT real invites that happen to share a title and instant —
    // must stay separate; a shared UID is required, title/time alone is not
    // enough once both sides have their own identity.
    await stagePending(userId, { title: 'Standup', startsAt: `${D1}T10:00:00-04:00`, externalUid: 'uid-b' }, 'g-3');
    await stagePending(userId, { title: 'Standup', startsAt: `${D1}T10:00:00-04:00`, externalUid: 'uid-c' }, 'g-4');

    expect(await consolidateDuplicateEventProposals(db, userId)).toBe(1);
    const left = await pendingEventProposals();
    expect(left).toHaveLength(3);
    // g-1 (uid-a) and g-2 (no uid) merged and g-1 is richer (carries the
    // uid), so it survives and g-2 is what got expired; uid-b/uid-c never
    // merge with each other despite sharing title+time.
    const uids = left
      .map((p) => (JSON.parse(p.args_json) as { externalUid?: string }).externalUid)
      .filter((u): u is string => !!u)
      .sort();
    expect(uids).toEqual(['uid-a', 'uid-b', 'uid-c']);
  });

  it('only touches pending gmail-derived proposals', async () => {
    const userId = await createUser(db, 'dedup-scope');
    const personal = await ensurePersonalGroup(db, userId);
    // A chat-derived proposal (no gmail provenance) duplicating an email one.
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: stayArgs(),
      provenance: null,
      targetGroupId: null,
    });
    await stagePending(userId, stayArgs(), 'g-1');

    expect(await consolidateDuplicateEventProposals(db, userId)).toBe(0);
    expect(await pendingEventProposals()).toHaveLength(2);
  });
});

describe('isSameSuggestedListItem — filler tail', () => {
  const bare = 'Decide whether to sell or use US Open tickets for Sun, Aug 30, 12:00 PM';

  it('the same to-do with and without trailing padding is one item', () => {
    expect(
      isSameSuggestedListItem(
        { listName: 'To-dos', item: bare },
        { listName: 'To-dos', item: `${bare} and take action accordingly` },
      ),
    ).toBe(true);
  });

  it('a trailing clause that carries content still splits them', () => {
    expect(
      isSameSuggestedListItem(
        { listName: 'Shopping', item: 'buy milk' },
        { listName: 'Shopping', item: 'buy milk and eggs' },
      ),
    ).toBe(false);
  });

  it('cards staged before the strip existed collapse on the sweep', async () => {
    const userId = await createUser(db, 'filler-heal');
    const personal = await ensurePersonalGroup(db, userId);
    for (const item of [bare, `${bare} and take action accordingly`]) {
      await createProposal(db, {
        groupId: personal.id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'add_list_item',
        args: { listName: 'To-dos', items: [item] },
        provenance: `gmail:g-${item.length}`,
        targetGroupId: null,
      });
    }
    expect(await consolidateDuplicateListItemProposals(db, userId)).toBe(1);
  });
});
