/**
 * ADR 0346 - the invite card says what the calendar says.
 *
 * Built on the 17 November recording: John had a 12:00-12:50 meeting with
 * someone else when a noon meeting with Rob was on offer, and nothing on the
 * card said so. Dates are relative so the test cannot rot into the past.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { calendarFitFor, recordOverlapAnswer } from '@/services/events/calendar-fit.service.js';
import { pendingSuggestionsForThreads } from '@/services/email/magics.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { attachSourceHrefs, createProposal, listProposalsForUser } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ROB = 'rob@acme.com';

function nyAt(days: number, hhmm: string): string {
  const base = new Date(Date.now() + days * 86_400_000);
  // A weekday, so work hours stay out of the way unless asked about.
  while ([0, 6].includes(base.getUTCDay())) base.setUTCDate(base.getUTCDate() + 1);
  const local = `${base.toISOString().slice(0, 10)}T${hhmm}:00`;
  return `${local}${offsetForLocalDatetime(TZ, local)}`;
}

let db: Kysely<DB>;
let userId: string;
let personalId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db.updateTable('users').set({ last_tz: TZ, email: 'john@example.com' }).where('id', '=', userId).execute();
  personalId = (await ensurePersonalGroup(db, userId)).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(gid: string, from: string, to: string[]): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'Catch up',
      snippet: 'Catch up',
      from_email: from,
      from_name: 'Rob',
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: id,
      gmail_message_id: `m_${gid}`,
      gmail_thread_id: gid,
      from_email: from,
      to_emails: JSON.stringify(to),
      cc_emails: JSON.stringify([]),
      subject: 'Catch up',
      snippet: 'Catch up',
      internal_date: now,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX']),
      created_at: now,
    })
    .execute();
  return id;
}

async function event(title: string, start: string, end: string, guests: string[] | null) {
  const ev = await createEvent(db, { groupId: personalId, title, startsAt: start, endsAt: end, createdBy: userId });
  if (guests) {
    await db.updateTable('events').set({ guest_emails: JSON.stringify(guests) }).where('id', '=', ev.id).execute();
  }
  return ev;
}

function invite(start: string, end: string, uid = 'rob-invite@acme.com') {
  return createProposal(db, {
    groupId: personalId,
    proposedByUserId: userId,
    proposedByMessageId: null,
    toolName: 'create_event',
    args: { title: 'Rob <> John', startsAt: start, endsAt: end, alreadyInGoogle: true, externalUid: uid, organizerEmail: ROB },
    provenance: 'gmail:g-invite',
  });
}

async function fitOf(proposalId: string) {
  const all = await attachSourceHrefs(db, userId, await listProposalsForUser(db, userId));
  return all.find((p) => p.id === proposalId)!.fit;
}

describe('the calendar verdict on an email event card', () => {
  it('names a meeting with other people inside the slot as a conflict', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const lunch = await event('Lunch meeting', nyAt(1, '12:00'), nyAt(1, '12:50'), ['sam@other.org', 'john@example.com']);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const fit = await fitOf(p.id);
    expect(fit?.verdict).toBe('conflict');
    expect(fit?.conflicts.map((c) => c.eventId)).toEqual([lunch.id]);
  });

  it('says it is already there when the same people are on an event at that time', async () => {
    await seedThread('g-invite', ROB, ['john@example.com', 'ana.assistant@acme.com']);
    // Agreed by email earlier; Rob's invite adds his CFO and drops his assistant.
    const agreed = await event('Call with Rob', nyAt(1, '12:00'), nyAt(1, '13:00'), [ROB, 'cfo@acme.com']);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const fit = await fitOf(p.id);
    expect(fit?.verdict).toBe('already');
    expect(fit?.already?.eventId).toBe(agreed.id);
  });

  it('does not count the invitation Outlook already placed on the calendar', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const placed = await event('Rob <> John', nyAt(1, '12:00'), nyAt(1, '13:00'), [ROB, 'john@example.com']);
    await db.updateTable('events').set({ ical_uid: 'ROB-INVITE@acme.com' }).where('id', '=', placed.id).execute();
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    expect((await fitOf(p.id))?.verdict).toBe('free');
  });

  it('asks whether a block of your own can move, once', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const gym = await event('Gym', nyAt(1, '12:00'), nyAt(1, '13:00'), null);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const fit = await fitOf(p.id);
    expect(fit?.verdict).toBe('ask');
    expect(fit?.questions).toEqual([expect.objectContaining({ eventId: gym.id, ask: 'movable' })]);

    expect(await recordOverlapAnswer(db, userId, p.id, gym.id, 'same')).toEqual({ ok: false, reason: 'wrong_answer' });
    expect(await recordOverlapAnswer(db, userId, p.id, gym.id, 'movable')).toEqual({ ok: true });
    expect((await fitOf(p.id))?.verdict).toBe('free');
  });

  it('a block that cannot move is a conflict from then on', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const pickup = await event('School pickup', nyAt(1, '12:00'), nyAt(1, '13:00'), null);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    await recordOverlapAnswer(db, userId, p.id, pickup.id, 'fixed');
    const fit = await fitOf(p.id);
    expect(fit?.verdict).toBe('conflict');
  });

  it('refuses an answer about an event the meeting never overlapped', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const elsewhere = await event('Gym', nyAt(1, '18:00'), nyAt(1, '19:00'), null);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    expect(await recordOverlapAnswer(db, userId, p.id, elsewhere.id, 'movable')).toEqual({ ok: false, reason: 'not_asked' });
  });

  it('a pre-meeting is shown as related, not a conflict', async () => {
    await seedThread('g-invite', ROB, ['john@example.com', 'lee@neural.ai']);
    await event('Prep for Rob', nyAt(1, '11:30'), nyAt(1, '12:15'), ['lee@neural.ai']);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const fit = await fitOf(p.id);
    expect(fit?.verdict).toBe('free');
    expect(fit?.related).toHaveLength(1);
  });

  it('reaches the card beside the email too', async () => {
    const threadRow = await seedThread('g-invite', ROB, ['john@example.com']);
    await event('Lunch meeting', nyAt(1, '12:00'), nyAt(1, '12:50'), ['sam@other.org']);
    await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const [card] = (await pendingSuggestionsForThreads(db, userId, [threadRow])).get(threadRow)!;
    expect(card?.fit?.verdict).toBe('conflict');
  });

  it('the same question can be answered in chat', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    await event('Gym', nyAt(1, '12:00'), nyAt(1, '13:00'), null);
    const p = await invite(nyAt(1, '12:00'), nyAt(1, '13:00'));
    const call = (args: Record<string, unknown>) =>
      applyToolCall(db, { groupId: personalId, actorUserId: userId, provenance: 'test', call: { name: 'answer_calendar_question', args } });
    expect((await call({ event: 'the dentist', answer: 'movable' })).data).toMatchObject({ ok: false, reason: 'not_found' });
    // "same" is not an answer to "can it move?".
    expect((await call({ event: 'gym', answer: 'same' })).data).toMatchObject({ ok: false, reason: 'not_found' });
    expect((await call({ event: 'my gym', answer: 'movable' })).data).toMatchObject({ ok: true, event: 'Gym' });
    expect((await fitOf(p.id))?.verdict).toBe('free');
  });

  it('notes a time outside work hours', async () => {
    await seedThread('g-invite', ROB, ['john@example.com']);
    const p = await invite(nyAt(1, '19:00'), nyAt(1, '20:00'));
    const fit = (await calendarFitFor(db, userId, [{ id: p.id, tool_name: 'create_event', args_json: JSON.stringify({ title: 'x', startsAt: nyAt(1, '19:00'), endsAt: nyAt(1, '20:00') }), provenance: 'gmail:g-invite' }])).get(p.id);
    expect(fit?.outsideWorkHours).toBe('after 5:00 PM');
  });
});
