/**
 * ADR 0346 phase 4 - a time agreed by email is held in Chord until the other
 * side's invitation arrives. Never an event, never on a calendar.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock, type SchedulingFacts } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { busyIntervalsInWindow } from '@/services/conflicts.service.js';
import { linkInviteToMeeting, recordMeetingFromEmail } from '@/services/email/meetings.service.js';
import { finishScheduling } from '@/services/email/scheduling-block.js';
import { calendarFitFor } from '@/services/events/calendar-fit.service.js';
import { activeHolds, dropHold, renderWaitingSection } from '@/services/events/holds.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'john@example.com';
const ROB = 'rob@acme.com';

let db: Kysely<DB>;
let userId: string;
const sentDay = () => svWall(new Date(), TZ).slice(0, 10);
const tomorrow = () => new Date(Date.parse(`${sentDay()}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${tomorrow()}T${hhmm}:00${offsetForLocalDatetime(TZ, `${tomorrow()}T${hhmm}:00`)}`;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db.updateTable('users').set({ email: ME, last_tz: TZ }).where('id', '=', userId).execute();
});
afterEach(async () => {
  await closeTestDb(db);
});

function facts(block: Record<string, unknown>, from = ROB): SchedulingFacts {
  return finishScheduling(
    readSchedulingBlock(block)!,
    { bodyText: '', fromEmail: from, fromName: 'Rob Smith', toEmails: [ME], ccEmails: [], sentDay: sentDay() },
    [ME],
  );
}

/** Rob offered, and the user agreed 11:00 tomorrow by email. */
async function agreed(threadKey = 'gmail:t_rob', inviteBy: 'them' | 'unknown' | 'me' = 'them', person = ROB) {
  await recordMeetingFromEmail(db, userId, threadKey, facts({ act: 'offer_slots', offered: ['tomorrow from 10-1'], title: 'Catch up with Rob' }, person), 'them', {
    tz: TZ,
    people: { fromEmail: person, toEmails: [ME], ccEmails: [] },
  });
  // The user's own reply: "inviteBy" is read from the recipient's side, so
  // "them" here means the user sends; flip to say what the test means.
  const flip = { them: 'me', me: 'them', unknown: 'unknown' }[inviteBy];
  return recordMeetingFromEmail(db, userId, threadKey, facts({ act: 'agree', agreed: 'tomorrow at 11am', inviteBy: flip, ...(flip === 'unknown' ? {} : { inviteEvidence: 'the invite' }) }, ME), 'me', {
    tz: TZ,
    people: { fromEmail: ME, toEmails: [person], ccEmails: [] },
  });
}

describe('holds', () => {
  it('an agreed time whose invite Rob sends is held, and blocks free-time checks', async () => {
    const m = await agreed();
    expect(m).toMatchObject({ state: 'agreed', invite_by: 'them' });
    const holds = await activeHolds(db, userId);
    expect(holds).toEqual([expect.objectContaining({ title: 'Catch up with Rob', withName: 'Rob', startsAt: at('11:00') })]);
    const { intervals } = await busyIntervalsInWindow(db, { userId, startIso: at('09:00'), endIso: at('17:00') });
    expect(intervals).toEqual([{ startMs: Date.parse(at('11:00')), endMs: Date.parse(at('12:00')) }]);
    // Never an event.
    expect(await db.selectFrom('events').select('id').execute()).toHaveLength(0);
  });

  it('nothing is held when the user sends the invite', async () => {
    await agreed('gmail:t_rob', 'me');
    expect(await activeHolds(db, userId)).toEqual([]);
  });

  it('the hold goes when the invitation links, or an event is made from the thread', async () => {
    await agreed();
    await linkInviteToMeeting(db, userId, { uid: 'rob@acme', organizer: ROB, people: [ME], startsAt: at('11:00') }, TZ);
    expect(await activeHolds(db, userId)).toEqual([]);

    await agreed('gmail:t_two', 'unknown', 'kim@x.com');
    expect(await activeHolds(db, userId)).toHaveLength(1);
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    await createEvent(db, { groupId: personalId, title: 'Kim', startsAt: at('11:00'), endsAt: at('12:00'), createdBy: userId, sourceRawContext: 'gmail:t_two' });
    expect(await activeHolds(db, userId)).toEqual([]);
  });

  it('a hold nobody answered for a week lapses', async () => {
    const m = await agreed();
    await db.updateTable('meetings').set({ updated_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }).where('id', '=', m!.id).execute();
    expect(await activeHolds(db, userId)).toEqual([]);
  });

  it('the user can stop holding it; the meeting is left as it is', async () => {
    const m = await agreed();
    expect(await dropHold(db, userId, { name: 'nobody' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await dropHold(db, userId, { name: 'rob' })).toMatchObject({ ok: true });
    expect(await activeHolds(db, userId)).toEqual([]);
    const row = await db.selectFrom('meetings').select('state').where('id', '=', m!.id).executeTakeFirstOrThrow();
    expect(row.state).toBe('agreed');
  });

  it('another meeting\'s invitation over the held slot shows the hold; its own does not', async () => {
    await agreed();
    const fit = await calendarFitFor(db, userId, [
      {
        id: 'p_other',
        tool_name: 'create_event',
        args_json: JSON.stringify({ title: 'Board review', startsAt: at('11:00'), endsAt: at('12:00'), alreadyInGoogle: true, externalUid: 'board@x', organizerEmail: 'chair@board.org' }),
        provenance: 'gmail:t_board',
      },
      {
        id: 'p_rob',
        tool_name: 'create_event',
        args_json: JSON.stringify({ title: 'Rob / John', startsAt: at('11:00'), endsAt: at('12:00'), alreadyInGoogle: true, externalUid: 'rob2@acme', organizerEmail: ROB }),
        provenance: 'gmail:t_rob_invite',
      },
    ]);
    expect(fit.get('p_other')?.held).toEqual([expect.objectContaining({ title: 'Catch up with Rob' })]);
    expect(fit.get('p_rob')?.held).toBeUndefined();
  });

  it('the briefing says who it is waiting on', async () => {
    await agreed();
    const text = renderWaitingSection(await activeHolds(db, userId), TZ)!;
    expect(text).toContain("Waiting on Rob's invite");
    expect(text).toContain('Catch up with Rob');
    expect(renderWaitingSection([], TZ)).toBeNull();
  });

  it('chat lists and drops holds the same way', async () => {
    await agreed();
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    const call = (args: Record<string, unknown>) =>
      applyToolCall(db, { groupId: personalId, actorUserId: userId, provenance: 'test', call: { name: 'meeting_holds', args } });
    expect((await call({})).data).toMatchObject({ ok: true, holds: [expect.objectContaining({ with: 'Rob' })] });
    expect((await call({ drop: 'Rob' })).data).toMatchObject({ ok: true, dropped: 'Catch up with Rob' });
    expect((await call({})).data).toMatchObject({ holds: [] });
  });
});
