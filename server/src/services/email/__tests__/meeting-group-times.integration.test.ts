/**
 * ADR 0346 phase 7 - several people sending different times on one thread.
 *
 * The user asked Rob, Sam and Kim for a time. Rob can do Tuesday 10-1, Sam
 * Tuesday 11-3, Kim has not answered; then Kim says 12-2. Each message is one
 * scheduling block; Chord keeps each person's offers and works out the times
 * that suit everyone.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { groupTimesFor } from '@/services/email/compose-reply.service.js';
import { stageMeetingCards } from '@/services/email/magics.service.js';
import { recordMeetingFromEmail, waitingOnAnswers } from '@/services/email/meetings.service.js';
import { finishScheduling } from '@/services/email/scheduling-block.js';
import { renderWaitingSection } from '@/services/events/holds.service.js';
import { svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'john@example.com';
const ROB = 'rob@acme.com';
const SAM = 'sam@acme.com';
const KIM = 'kim@other.org';
const KEY = 'gmail:t_group';

let db: Kysely<DB>;
let userId: string;

const nextTuesday = (): string => {
  const d = new Date(Date.parse(`${svWall(new Date(), TZ).slice(0, 10)}T12:00:00Z`) + 86_400_000);
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db.updateTable('users').set({ email: ME, last_tz: TZ }).where('id', '=', userId).execute();
});
afterEach(async () => {
  await closeTestDb(db);
});

/** One message on the thread, from `from`, read into facts. */
async function message(from: string, block: Record<string, unknown>, to: string[] = [ME], cc: string[] = []) {
  const facts = finishScheduling(
    readSchedulingBlock({ act: 'offer_slots', title: 'Planning sync', ...block })!,
    { bodyText: '', fromEmail: from, fromName: null, toEmails: to, ccEmails: cc, sentDay: svWall(new Date(), TZ).slice(0, 10), sentAt: new Date().toISOString() },
    [ME],
    { askedOfUser: true },
  );
  return recordMeetingFromEmail(db, userId, KEY, facts, from === ME ? 'me' : 'them', {
    tz: TZ,
    own: [ME],
    people: { fromEmail: from, toEmails: to, ccEmails: cc },
  });
}

const meeting = () => db.selectFrom('meetings').selectAll().where('thread_key', '=', KEY).executeTakeFirstOrThrow();

describe('several people, several times', () => {
  it('keeps each person\'s offers and works out the common time', async () => {
    const tue = nextTuesday();
    // The user asks everyone and will send the invite.
    await message(ME, { act: 'ask_times', inviteBy: 'them', inviteEvidence: "I'll send the invite" }, [ROB, SAM, KIM]);
    await message(ROB, { offered: [`${tue} 10-1pm`] }, [ME, SAM, KIM]);
    await message(SAM, { offered: [`${tue} 11am-3pm`] }, [ME, ROB, KIM]);
    let m = await meeting();
    expect(m.core_people.sort()).toEqual([KIM, ROB, SAM].sort());
    expect(m.facts_json?.offers?.map((o) => o.person).sort()).toEqual([ROB, SAM]);

    // The drafter is handed the common time, not Sam's, and told Kim is due.
    const g = groupTimesFor(m, TZ, Date.now())!;
    expect(g.slots).toEqual([{ day: tue, minutes: 660, endMinutes: 780 }]);
    expect(g.note).toContain('Still waiting to hear from: Kim');
    // Briefing: who the user is waiting on.
    expect(renderWaitingSection([], TZ, await waitingOnAnswers(db, userId))).toContain('Waiting on Kim to answer the times for Planning sync');
    // No card while Kim has not answered.
    expect(await stageMeetingCards(db, userId)).toBe(0);

    // Kim answers 12-2: one time suits everyone, the user sends, so a card.
    await message(KIM, { offered: [`${tue} 12-2pm`] }, [ME, ROB, SAM]);
    expect(await stageMeetingCards(db, userId)).toBe(1);
    m = await meeting();
    expect(m.state).toBe('agreed');
    const card = await db.selectFrom('proposals').select('args_json').where('provenance', '=', KEY).executeTakeFirstOrThrow();
    expect(JSON.parse(card.args_json)).toMatchObject({ startsAt: expect.stringContaining(`${tue}T12:00:00`), invitees: expect.arrayContaining([ROB, SAM, KIM]) });
  });

  it('one person saying "works for me" is not the group agreeing', async () => {
    const tue = nextTuesday();
    // Kim, on the thread, has not said anything yet.
    await message(ROB, { offered: [`${tue} 10-1pm`] }, [ME, SAM, KIM]);
    await message(SAM, { act: 'agree', agreed: `${tue} at 11am` }, [ME, ROB, KIM]);
    const m = await meeting();
    expect(m.state).toBe('offered');
    expect(m.agreed_start).toBeNull();
  });

  it('everyone saying it works is agreed', async () => {
    const tue = nextTuesday();
    await message(ROB, { act: 'agree', agreed: `${tue} at 11am` }, [ME, SAM]);
    await message(SAM, { act: 'agree', agreed: `${tue} at 11am` }, [ME, ROB]);
    expect((await meeting()).state).toBe('agreed');
  });

  it('someone on Cc is an onlooker until they speak', async () => {
    const tue = nextTuesday();
    await message(ROB, { offered: [`${tue} 10-1pm`] }, [ME], ['boss@acme.com']);
    expect((await meeting()).core_people).toEqual([ROB]);
  });

  it('times passed on for someone else count as theirs', async () => {
    const tue = nextTuesday();
    await message(ROB, { offered: [`${tue} 10-1pm`], others: [{ person: 'Sam', offered: [`${tue} 12-3pm`] }] }, [ME, SAM]);
    const m = await meeting();
    expect(m.facts_json?.offers?.find((o) => o.person === SAM)?.offered[0]).toMatchObject({ day: tue, minutes: 720 });
    expect(groupTimesFor(m, TZ, Date.now())!.slots).toEqual([{ day: tue, minutes: 720, endMinutes: 780 }]);
  });

  it('two times that suit everyone stay the user\'s choice: no card is picked for them', async () => {
    const tue = nextTuesday();
    await message(ME, { act: 'ask_times', inviteBy: 'them', inviteEvidence: "I'll send the invite" }, [ROB, SAM]);
    await message(ROB, { offered: [`${tue} 10-11am`, `${tue} 3-4pm`] }, [ME, SAM]);
    await message(SAM, { offered: [`${tue} 9am-5pm`] }, [ME, ROB]);
    expect(await stageMeetingCards(db, userId)).toBe(0);
    const m = await meeting();
    expect(m.state).not.toBe('agreed');
    expect(m.agreed_start).toBeNull();
    // The drafter is handed both, to offer the earliest free one.
    expect(groupTimesFor(m, TZ, Date.now())!.slots).toEqual([
      { day: tue, minutes: 600, endMinutes: 660 },
      { day: tue, minutes: 900, endMinutes: 960 },
    ]);
  });

  it('an assistant\'s times count as their boss\'s', async () => {
    const tue = nextTuesday();
    const ANA = 'ana@acme.com';
    // Ana writes for Rob; Rob and Sam are on the thread.
    await message(SAM, { offered: [`${tue} 11am-3pm`] }, [ME, ROB, ANA]);
    await message(ANA, { writer: 'assistant', onBehalfOf: 'Rob', assistants: ['Ana'], offered: [`${tue} 10-1pm`] }, [ME, ROB, SAM]);
    const m = await meeting();
    expect(m.not_core).toContain(ANA);
    expect(m.core_people).not.toContain(ANA);
    const people = (m.facts_json?.offers ?? []).map((o) => o.person).sort();
    expect(people).toEqual([ROB, SAM].sort());
    expect(groupTimesFor(m, TZ, Date.now())!.slots).toEqual([{ day: tue, minutes: 660, endMinutes: 780 }]);
  });

  it('nobody can make the same time: says so, with the one most can make', async () => {
    const tue = nextTuesday();
    await message(ROB, { offered: [`${tue} 10-11am`] }, [ME, SAM, KIM]);
    await message(SAM, { offered: [`${tue} 2-3pm`] }, [ME, ROB, KIM]);
    await message(KIM, { offered: [`${tue} 10-11am`] }, [ME, ROB, SAM]);
    const g = groupTimesFor(await meeting(), TZ, Date.now())!;
    expect(g.note).toContain('NO time suits everyone');
    expect(g.note).toContain('not Sam');
    expect(g.slots).toEqual([{ day: tue, minutes: 600, endMinutes: 660 }]);
  });
});
