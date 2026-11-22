/**
 * ADR 0346 phase 5 - who sends the invite decides the card, and the format
 * fills it. Shapes from the planning thread: "I'll send an invite" (no card,
 * the slot is held), "Can you send an invite? Zoom is fine" (the user's card),
 * nobody saying (the card asks), and a Zoom link already in the email.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { meetingCardPlan, readSchedulingBlock } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, stageMeetingCards, type EmailExtractor } from '@/services/email/magics.service.js';
import { recordMeetingFromEmail } from '@/services/email/meetings.service.js';
import { finishScheduling } from '@/services/email/scheduling-block.js';
import { waitForTheirInvite } from '@/services/email/meeting-invite-choice.js';
import { activeHolds } from '@/services/events/holds.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'john@example.com';
const KIM = 'kim@startup.io';

describe('meetingCardPlan', () => {
  it('they send, or an assistant arranges it: no card', () => {
    expect(meetingCardPlan({ sender: 'them', format: 'unknown' }).skip).toBe(true);
    expect(meetingCardPlan({ sender: 'unknown', viaAssistant: true, format: 'unknown' }).skip).toBe(true);
  });
  it('unknown asks; a link already there is the call; a call with no link gets the calendar\'s', () => {
    expect(meetingCardPlan({ sender: 'unknown', format: 'unknown' })).toEqual({ skip: false, whoSends: 'ask' });
    expect(meetingCardPlan({ sender: 'me', format: 'video', link: { url: 'https://x.zoom.us/j/1' } })).toEqual({
      skip: false,
      location: 'https://x.zoom.us/j/1',
    });
    expect(meetingCardPlan({ sender: 'me', format: 'video' })).toEqual({ skip: false, videoCall: true });
    expect(meetingCardPlan({ sender: 'me', format: 'in_person', place: 'Blue Bottle' })).toEqual({
      skip: false,
      location: 'Blue Bottle',
    });
  });
});

describe('meeting cards from email', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;
  const day = () => {
    const today = svWall(new Date(), TZ).slice(0, 10);
    return new Date(Date.parse(`${today}T12:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
  };
  const at = (hhmm: string) => `${day()}T${hhmm}:00${offsetForLocalDatetime(TZ, `${day()}T${hhmm}:00`)}`;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db.updateTable('users').set({ email: ME, last_tz: TZ }).where('id', '=', userId).execute();
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  async function seed(gid: string, body: string): Promise<void> {
    const now = new Date().toISOString();
    const row = newId('emt');
    await db
      .insertInto('email_threads')
      .values({ id: row, user_id: userId, gmail_thread_id: gid, subject: 'Re: intro', snippet: body.slice(0, 40), from_email: KIM, from_name: 'Kim', last_message_at: now, created_at: now, updated_at: now, is_unread: 1 })
      .execute();
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: row,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'Re: intro',
        snippet: body.slice(0, 40),
        from_email: KIM,
        from_name: 'Kim',
        to_emails: JSON.stringify([ME]),
        cc_emails: JSON.stringify([]),
        body_excerpt: body,
        ics_text: '',
        is_unread: 1,
        internal_date: now,
        created_at: now,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:work', parentId: null, title: 'Work', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:work' }],
    });
  }

  /**
   * The model reads an agreed 2pm with Kim and the given scheduling block. The
   * agreed day is the event's own date, never a weekday name: a bare weekday
   * written on that weekday names no day (ADR 0245), so "Thursday" failed
   * every Thursday.
   */
  const stub = (block: Record<string, unknown>): EmailExtractor => ({
    async extract(input) {
      input.onScheduling?.(readSchedulingBlock({ act: 'agree', agreed: `${day()} at 2pm`, title: 'Intro with Kim', ...block })!);
      return { kind: 'event', title: 'Intro with Kim', startsAt: at('14:00'), invite: 'sender', askedOf: 'me' } as never;
    },
  });

  const cards = () =>
    db.selectFrom('proposals').select(['id', 'args_json', 'status']).where('proposed_by_user_id', '=', userId).where('tool_name', '=', 'create_event').execute();

  it('"I\'ll send an invite": no card, so the organizer is never sent a second invitation', async () => {
    await seed('t1', "Thursday at 2pm works. I'll send an invite.");
    await runEmailMagics(db, userId, { extractor: stub({ inviteBy: 'them', inviteEvidence: "I'll send an invite" }) });
    expect(await cards()).toHaveLength(0);
  });

  it('"Can you send an invite? Zoom is fine": the user\'s card, with the link already there', async () => {
    await seed('t2', 'Thursday at 2pm works. Can you send an invite? https://startup.zoom.us/j/555');
    await runEmailMagics(db, userId, { extractor: stub({ inviteBy: 'me', inviteEvidence: 'can you send', format: 'video' }) });
    const [c] = await cards();
    const args = JSON.parse(c!.args_json);
    expect(args).toMatchObject({ invitees: [KIM], location: 'https://startup.zoom.us/j/555' });
    expect(args.videoCall).toBeUndefined();
    expect(args.whoSends).toBeUndefined();
  });

  it('a call with no link, the user sending: the calendar\'s own video call', async () => {
    await seed('t3', 'Thursday at 2pm works, can you send a video invite?');
    await runEmailMagics(db, userId, { extractor: stub({ inviteBy: 'me', inviteEvidence: 'can you send', format: 'video' }) });
    expect(JSON.parse((await cards())[0]!.args_json)).toMatchObject({ videoCall: true });
  });

  it('nobody said: the card asks, and waiting holds the slot', async () => {
    await seed('t4', 'Thursday at 2pm works.');
    await runEmailMagics(db, userId, { extractor: stub({ inviteBy: 'unknown' }) });
    const [c] = await cards();
    expect(JSON.parse(c!.args_json)).toMatchObject({ whoSends: 'ask', invitees: [KIM] });
    // The time is agreed either way: held while nobody has said who sends.
    expect(await activeHolds(db, userId)).toHaveLength(1);

    expect(await waitForTheirInvite(db, userId, { proposalId: c!.id })).toMatchObject({ ok: true });
    expect((await cards())[0]!.status).toBe('rejected');
    expect(await activeHolds(db, userId)).toEqual([expect.objectContaining({ startsAt: expect.stringContaining('T14:00:00') })]);
  });

  it('chat can say wait too', async () => {
    await seed('t5', 'Thursday at 2pm works.');
    await runEmailMagics(db, userId, { extractor: stub({ inviteBy: 'unknown' }) });
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    const r = await applyToolCall(db, { groupId: personalId, actorUserId: userId, provenance: 'test', call: { name: 'wait_for_invite', args: { meeting: 'Kim' } } });
    expect(r.data).toMatchObject({ ok: true, held: true });
  });

  it('agreed in the user\'s own reply, the user sending: a card, once', async () => {
    const block = (b: Record<string, unknown>) =>
      finishScheduling(readSchedulingBlock(b)!, { bodyText: '', fromEmail: ME, fromName: 'John', toEmails: [KIM], ccEmails: [], sentDay: svWall(new Date(), TZ).slice(0, 10) }, [ME], { askedOfUser: true });
    const people = { fromEmail: KIM, toEmails: [ME], ccEmails: [] };
    await recordMeetingFromEmail(db, userId, 'gmail:t6', block({ act: 'offer_slots', offered: ['Thursday 2pm'], title: 'Intro with Kim' }), 'them', { tz: TZ, people });
    const m = await recordMeetingFromEmail(db, userId, 'gmail:t6', block({ act: 'agree', agreed: `${day()} at 2pm`, inviteBy: 'them', inviteEvidence: "I'll send it", format: 'in_person', place: 'Blue Bottle' }), 'me', { tz: TZ, people: { fromEmail: ME, toEmails: [KIM], ccEmails: [] } });
    expect(m).toMatchObject({ state: 'agreed', invite_by: 'me' });
    expect(await stageMeetingCards(db, userId)).toBe(1);
    expect(await stageMeetingCards(db, userId)).toBe(0);
    expect(JSON.parse((await cards())[0]!.args_json)).toMatchObject({ title: 'Intro with Kim', invitees: [KIM], location: 'Blue Bottle' });
  });

  it('their invite never came: after the hold lapses, the user is asked once', async () => {
    const block = (b: Record<string, unknown>, from: string) =>
      finishScheduling(readSchedulingBlock(b)!, { bodyText: '', fromEmail: from, fromName: 'x', toEmails: [], ccEmails: [], sentDay: svWall(new Date(), TZ).slice(0, 10) }, [ME], { askedOfUser: true });
    const m = await recordMeetingFromEmail(db, userId, 'gmail:t7', block({ act: 'agree', agreed: `${day()} at 2pm`, inviteBy: 'me', inviteEvidence: 'can you send it' }, ME), 'me', {
      tz: TZ,
      people: { fromEmail: ME, toEmails: [KIM], ccEmails: [] },
    });
    expect(m?.invite_by).toBe('them');
    expect(await stageMeetingCards(db, userId)).toBe(0);
    await db.updateTable('meetings').set({ updated_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }).where('id', '=', m!.id).execute();
    expect(await stageMeetingCards(db, userId)).toBe(1);
    expect(JSON.parse((await cards())[0]!.args_json)).toMatchObject({ lapsedNote: "kim's invite never came", invitees: [KIM] });
    expect(await stageMeetingCards(db, userId)).toBe(0);
  });
});
