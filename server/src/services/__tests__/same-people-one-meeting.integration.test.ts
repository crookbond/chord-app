/**
 * Same time, same people = one meeting (ADR 0223 addendum, owner rule).
 * Prod 2026-11-10: Mark Clark's invite "Follow up: Neural Ads/ Post Oak
 * Group" synced into the Outlook calendar at 15:27:03; at 15:27:14 an email
 * card "Introductory Meeting with Mark Clark" was staged for the same
 * 10:30-11:00 with Mark as guest, and confirming it created a second event
 * that invited Mark to his own meeting. The duplicate check compared titles.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  retractProposalsCoveredByExistingEvents,
  shouldStageEventProposal,
} from '@/services/event-convergence.service.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const MARK = 'mark.clark@postoakgroup.co';
const ME = 'john@neuralads.ai';
/** Nine days ahead, so the meeting never drifts into the past. */
const DAY = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
const START = `${DAY}T15:30:00Z`;
const END = `${DAY}T16:00:00Z`;
const CARD = {
  title: 'Introductory Meeting with Mark Clark',
  startsAt: `${DAY}T10:30:00-05:00`,
  endsAt: `${DAY}T11:00:00-05:00`,
  invitees: [MARK],
};

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'same-people');
  groupId = (await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: userId })).id;
  // Mark's invite as the Outlook pull writes it: someone else's, no chord_uid.
  const now = new Date().toISOString();
  await db
    .insertInto('events')
    .values({
      id: 'e_marks_invite',
      group_id: groupId,
      group_ids: '[]',
      owner_user_id: userId,
      organizer_user_id: null,
      role: 'attendee',
      google_calendar_id: 'outlook:ema_x:cal',
      created_by: userId,
      created_at: now,
      updated_at: now,
      title: 'Follow up: Neural Ads/ Post Oak Group',
      starts_at: `${DAY}T10:30:00-05:00`,
      ends_at: `${DAY}T11:00:00-05:00`,
      all_day: 0,
      status: 'confirmed',
      transparency: 'opaque',
      ical_uid: 'uid-marks-invite',
      chord_uid: null,
      gcal_event_id: 'AAk-marks-invite',
      sequence: 0,
      gcal_sync_status: 'synced',
      local_dirty: 0,
      guest_emails: JSON.stringify([MARK, ME]),
    })
    .execute();
});
afterEach(async () => {
  await closeTestDb(db);
});

const eventCount = async () =>
  Number((await db.selectFrom('events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n);

describe('same time, same people = one meeting', () => {
  it('no card is staged for a meeting already on the calendar', async () => {
    expect(await shouldStageEventProposal(db, userId, CARD)).toBe(false);
    // Someone else at that time is still a card.
    expect(await shouldStageEventProposal(db, userId, { ...CARD, invitees: ['other@x.example'] })).toBe(true);
  });

  it('a card already staged is withdrawn by the sweep', async () => {
    await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: CARD,
      provenance: 'gmail:ema_x:thread-accepted',
      targetGroupId: null,
    });
    expect(await retractProposalsCoveredByExistingEvents(db, userId)).toBe(1);
  });

  it('confirming makes no second event', async () => {
    const made = await createEvent(db, {
      groupId,
      createdBy: userId,
      title: CARD.title,
      startsAt: START,
      endsAt: END,
      guestEmails: [MARK],
    });
    expect(made.merged).toBe('covered');
    expect(made.id).toBe('e_marks_invite');
    expect(await eventCount()).toBe(1);
  });
});
