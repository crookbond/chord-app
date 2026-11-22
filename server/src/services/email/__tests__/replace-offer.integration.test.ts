/**
 * ADR 0343 — a booking confirmation that is really a reschedule.
 *
 * Built on the real case: Westside Veterinary Center
 * (westsideveterinarycenternewyork@rapport2.com) booked MERLI K for
 * Mon 11/16 9:00, then sent its ordinary "Please make a note of your new
 * appointment" confirmation for 11/23 12:20 with no word of the old time. The
 * suggestion pass staged a NEW event, the user confirmed it, and the 11/16
 * event stayed: two vet visits on the calendar. Dates here are relative so
 * the tests cannot rot into a past slot.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { instantMs } from '@/db/text-instant.js';
import { replaceOffersFor, sharedSubjectWords } from '@/services/email/replace-offer.js';
import { pendingSuggestionsForThreads } from '@/services/email/magics.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  attachSourceHrefs,
  confirmProposal,
  createProposal,
  listProposalsForUser,
} from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const VET = 'westsideveterinarycenternewyork@rapport2.com';
const VET_NAME = 'Westside Veterinary Center';
const OLD_TITLE = 'Vet Appointment for MERLI K - Annual Wellness/Vaccination';
const NEW_TITLE = 'Vet Appointment for MERLI K with Dr. Rosenthal';

function nyAt(days: number, hhmm: string): string {
  const ymd = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const local = `${ymd}T${hhmm}:00`;
  return `${local}${offsetForLocalDatetime(TZ, local)}`;
}

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(gid: string, subject: string, fromEmail = VET, fromName = VET_NAME): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject,
      snippet: subject,
      from_email: fromEmail,
      from_name: fromName,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

/** The Nov 2 booking, confirmed into the calendar. */
async function bookedVisit(days = 7, title = OLD_TITLE, gid = 'g-request') {
  await seedThread(gid, 'Appointment Request Received');
  return createEvent(db, {
    groupId: personalId,
    title,
    startsAt: nyAt(days, '09:00'),
    endsAt: nyAt(days, '10:00'),
    createdBy: userId,
    sourceRawContext: `gmail:${gid}`,
  });
}

/** The Nov 8 "new appointment" email's card, as the model staged it. */
async function rescheduleCard(days = 14, title = NEW_TITLE, fromEmail = VET) {
  await seedThread('g-resched', 'Please make a note of your new appointment', fromEmail);
  return createProposal(db, {
    groupId: personalId,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_event',
    args: { title, startsAt: nyAt(days, '12:20'), invitees: [VET] },
    provenance: 'gmail:g-resched',
  });
}

async function listed(proposalId: string) {
  const all = await attachSourceHrefs(db, userId, await listProposalsForUser(db, userId));
  return all.find((p) => p.id === proposalId)!;
}

async function liveEvents() {
  return db
    .selectFrom('events')
    .select(['id', 'title', 'starts_at', 'ends_at'])
    .where('owner_user_id', '=', userId)
    .where('deleted_at', 'is', null)
    .execute();
}

describe('ADR 0343 — the Westside Vet reschedule', () => {
  it('offers to replace the booked visit, and Move it leaves one event at the new time', async () => {
    const old = await bookedVisit();
    const card = await rescheduleCard();

    const p = await listed(card.id);
    expect(p.replaces).toEqual({ eventId: old.id, title: OLD_TITLE, startsAt: old.startsAt });

    const res = await confirmProposal(db, { id: card.id, resolvedByUserId: userId, replaceEventId: old.id });
    expect(res.ok).toBe(true);

    const events = await liveEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(old.id);
    expect(instantMs(events[0]!.starts_at)).toBe(Date.parse(nyAt(14, '12:20')));
    // The email gave no end: the visit keeps its hour.
    expect(instantMs(events[0]!.ends_at!)).toBe(Date.parse(nyAt(14, '13:20')));
    const row = await db.selectFrom('proposals').select('status').where('id', '=', card.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('confirmed');
  });

  it('shows the same offer on the card beside the email', async () => {
    const old = await bookedVisit();
    const card = await rescheduleCard();
    const threadRow = await db
      .selectFrom('email_threads')
      .select('id')
      .where('gmail_thread_id', '=', 'g-resched')
      .executeTakeFirstOrThrow();
    const docked = (await pendingSuggestionsForThreads(db, userId, [threadRow.id])).get(threadRow.id) ?? [];
    expect(docked.find((s) => s.proposalId === card.id)?.replaces?.eventId).toBe(old.id);
  });

  it('Add as new still adds a second event', async () => {
    await bookedVisit();
    const card = await rescheduleCard();
    const res = await confirmProposal(db, { id: card.id, resolvedByUserId: userId });
    expect(res.ok).toBe(true);
    expect(await liveEvents()).toHaveLength(2);
  });

  it('refuses to move an event the card did not offer', async () => {
    await bookedVisit();
    const other = await createEvent(db, {
      groupId: personalId,
      title: 'Dinner with Ana',
      startsAt: nyAt(3, '19:00'),
      createdBy: userId,
    });
    const card = await rescheduleCard();
    const res = await confirmProposal(db, { id: card.id, resolvedByUserId: userId, replaceEventId: other.id });
    expect(res).toMatchObject({ ok: false, reason: 'replace_unavailable' });
    const row = await db.selectFrom('proposals').select('status').where('id', '=', card.id).executeTakeFirstOrThrow();
    expect(row.status).toBe('pending');
    const dinner = await db.selectFrom('events').select('starts_at').where('id', '=', other.id).executeTakeFirstOrThrow();
    expect(dinner.starts_at).toBe(other.startsAt);
  });
});

describe('ADR 0343 — when not to ask', () => {
  it('another pet at the same clinic is a second visit', async () => {
    await bookedVisit(7, 'Vet Appointment for BUDDY - Annual Wellness');
    const card = await rescheduleCard();
    expect((await listed(card.id)).replaces).toBeUndefined();
  });

  it('a booking from a different sender is never offered', async () => {
    await bookedVisit();
    const card = await rescheduleCard(14, NEW_TITLE, 'appointments@otherclinic.com');
    expect((await listed(card.id)).replaces).toBeUndefined();
  });

  it('two matching visits are ambiguous, so the card stays plain', async () => {
    await bookedVisit(7);
    await bookedVisit(9, OLD_TITLE, 'g-request-2');
    const card = await rescheduleCard();
    expect((await listed(card.id)).replaces).toBeUndefined();
  });

  it('a visit that has already happened is not replaced', async () => {
    await seedThread('g-request', 'Appointment Request Received');
    await createEvent(db, {
      groupId: personalId,
      title: OLD_TITLE,
      startsAt: nyAt(-2, '09:00'),
      createdBy: userId,
      sourceRawContext: 'gmail:g-request',
    });
    const card = await rescheduleCard();
    expect((await listed(card.id)).replaces).toBeUndefined();
  });

  it('an event the user typed in has no sender to match', async () => {
    await createEvent(db, { groupId: personalId, title: OLD_TITLE, startsAt: nyAt(7, '09:00'), createdBy: userId });
    const card = await rescheduleCard();
    const offers = await replaceOffersFor(db, userId, [
      { id: card.id, tool_name: 'create_event', args_json: card.argsJson, provenance: card.provenance, status: 'pending' },
    ]);
    expect(offers.size).toBe(0);
  });
});

describe('sharedSubjectWords', () => {
  it('finds the dog, not the booking words or the clinic', () => {
    expect(sharedSubjectWords(OLD_TITLE, NEW_TITLE, ['westside', 'veterinary', 'center', 'rapport2', 'com'])).toEqual([
      'merli',
    ]);
    expect(sharedSubjectWords('Dentist - Leo', 'Dentist - Maya')).toEqual([]);
    expect(sharedSubjectWords('Westside Vet visit', 'Westside Vet checkup', ['westside'])).toEqual([]);
  });
});
