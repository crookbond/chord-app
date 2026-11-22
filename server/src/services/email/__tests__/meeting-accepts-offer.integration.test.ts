/**
 * Prod 2026-11-17, Arthur's thread: the user offered "noon est tomorrow? Or
 * anytime between 2-4p est?", Arthur answered "2:00 works, I am in Seattle so
 * 11:00 PST." and no card came. Three things went wrong, each pinned here
 * with the real words and the block the model really returned:
 *  - "2:00 works" names no day, so the meeting never counted as agreed;
 *  - the user's own offered times, quoted under Arthur's reply, were stored
 *    as Arthur's offer and replaced the user's;
 *  - the model said Arthur would send the invite with nothing in his email
 *    saying so, which suppresses the invite card.
 * And the user's "Sending a calendar shortly" must mean the user sends.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSchedulingBlock, type SchedulingBlock } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { shouldStageEventProposal } from '@/services/event-convergence.service.js';
import { acceptedOffer, recordMeetingFromEmail } from '@/services/email/meetings.service.js';
import { finishScheduling, type SchedulingMessage } from '@/services/email/scheduling-block.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'jdoe@rudderstack.com';
const ARTHUR = 'arthur@optizent.com';
const KEY = 'gmail:acct:arthur-thread';

const OWN_OFFER = 'In NYC. how is noon est tomorrow? Or anytime between 2-4p est?';
const ARTHUR_REPLY = [
  '2:00 works, I am in Seattle so 11:00 PST.',
  '',
  'Arthur Baker',
  '206.555.0169',
  'Optizent.com',
  '',
  'From: John Doe <jdoe@rudderstack.com>',
  'Sent: Tuesday, November 17, 2026 1:15 PM',
  'To: Arthur Baker (Optizent) <arthur@optizent.com>',
  'Subject: Re: Partnerships',
  '',
  OWN_OFFER,
].join('\n');
const OWN_SENDING = 'My agent keeps sending from wrong outlook, Sending a calendar shortly';

const block = (o: Record<string, unknown>): SchedulingBlock => readSchedulingBlock(o)!;

describe('a dateless "2:00 works" against the times offered', () => {
  let db: Kysely<DB>;
  let userId: string;
  const today = () => svWall(new Date(), TZ).slice(0, 10);
  const tomorrow = () => new Date(Date.parse(`${today()}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const msg = (from: string, to: string, body: string): SchedulingMessage => ({
    bodyText: body,
    fromEmail: from,
    fromName: null,
    toEmails: [to],
    ccEmails: [],
    sentDay: today(),
    sentAt: new Date().toISOString(),
  });
  const record = async (m: SchedulingMessage, b: SchedulingBlock, side: 'them' | 'me') =>
    recordMeetingFromEmail(db, userId, KEY, finishScheduling(b, m, [ME]), side, {
      tz: TZ,
      people: { fromEmail: m.fromEmail, toEmails: m.toEmails, ccEmails: m.ccEmails },
      own: [ME],
    });

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db.updateTable('users').set({ email: ME, last_tz: TZ }).where('id', '=', userId).execute();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('becomes tomorrow 2 PM Eastern, with nobody yet named to send the invite', async () => {
    await record(
      msg(ME, ARTHUR, OWN_OFFER),
      block({ act: 'offer_slots', writer: 'principal', inviteBy: 'unknown', format: 'unknown', offered: ['noon est tomorrow', 'anytime between 2-4p est'] }),
      'me',
    );
    // What the model returned for Arthur's reply in prod, word for word.
    const row = await record(
      msg(ARTHUR, ME, ARTHUR_REPLY),
      block({
        act: 'agree',
        writer: 'principal',
        inviteBy: 'them',
        format: 'unknown',
        offered: ['noon est tomorrow', 'anytime between 2-4p est'],
        agreed: '2:00 works, I am in Seattle so 11:00 PST',
        title: 'Call with Arthur Baker (Optizent)',
      }),
      'them',
    );
    const two = `${tomorrow()}T14:00:00${offsetForLocalDatetime(TZ, `${tomorrow()}T14:00:00`)}`;
    expect(row?.state).toBe('agreed');
    expect(Date.parse(row!.agreed_start!)).toBe(Date.parse(two));
    expect(row?.invite_by).toBe('unknown');
    // The offer stays the user's.
    expect(row?.facts_json?.offeredBy).toBe('me');
  });

  it('"Sending a calendar shortly" from the user means the user sends', async () => {
    await record(msg(ME, ARTHUR, OWN_OFFER), block({ act: 'offer_slots', writer: 'principal', inviteBy: 'unknown', format: 'unknown', offered: ['noon est tomorrow', 'anytime between 2-4p est'] }), 'me');
    const row = await record(
      msg(ME, ARTHUR, OWN_SENDING),
      block({ act: 'fyi', writer: 'principal', inviteBy: 'them', inviteEvidence: 'Sending a calendar shortly', format: 'unknown', offered: [] }),
      'me',
    );
    expect(row?.invite_by).toBe('me');
  });

  it('a who-sends with no words behind it is not taken', () => {
    const f = finishScheduling(block({ act: 'agree', writer: 'principal', inviteBy: 'them', format: 'unknown', offered: [], agreed: '2:00 works' }), msg(ARTHUR, ME, ARTHUR_REPLY), [ME]);
    expect(f.inviteBy).toBe('unknown');
  });

  it('an email card never invites people to a time already gone today', async () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60 * 60_000);
    if (svWall(earlier, TZ).slice(0, 10) !== svWall(now, TZ).slice(0, 10)) return;
    const wall = svWall(earlier, TZ).slice(0, 16) + ':00';
    const startsAt = `${wall}${offsetForLocalDatetime(TZ, wall)}`;
    const tzOffset = offsetForLocalDatetime(TZ, wall);
    expect(await shouldStageEventProposal(db, userId, { title: 'Call with Arthur', startsAt, invitees: [ARTHUR] } as never, { tzOffset })).toBe(false);
    // Without guests the day rule stands: earlier today is still a record.
    expect(await shouldStageEventProposal(db, userId, { title: 'Dentist', startsAt } as never, { tzOffset })).toBe(true);
  });

  it('several matching readings pick nothing', () => {
    const d = tomorrow();
    const offers = [
      { text: 'a', day: d, minutes: 14 * 60, endMinutes: 16 * 60, timeZone: TZ },
      { text: 'b', day: d, minutes: 2 * 60, endMinutes: 3 * 60, timeZone: TZ },
    ];
    expect(acceptedOffer('2:00 works', offers, TZ)).toBeNull();
    expect(acceptedOffer('2pm works', offers, TZ)).toMatchObject({ day: d, minutes: 14 * 60 });
  });
});
