/**
 * ADR 0346 phase 3 - one meeting followed across its emails.
 *
 * Built on the 17 November recording: Rob offers "tomorrow from 10-1", the
 * user writes back agreeing a time, and Rob's invitation arrives in a thread
 * of its own with his CFO added and his assistant gone. Dates are relative.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextMeetingState, readSchedulingBlock } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runEmailMagics, runOwnReplyScheduling, type EmailExtractor } from '@/services/email/magics.service.js';
import { linkInviteToMeeting } from '@/services/email/meetings.service.js';
import { calendarFitFor } from '@/services/events/calendar-fit.service.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { offsetForLocalDatetime, svWall } from '@/utils/tz.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const TZ = 'America/New_York';
const ME = 'john@example.com';
const ROB = 'rob@acme.com';
const ANA = 'ana@acme.com';

describe('nextMeetingState', () => {
  it('moves through offered, proposed, agreed and cancelled', () => {
    expect(nextMeetingState(null, 'offer_slots', 'them', false)).toBe('offered');
    expect(nextMeetingState('offered', 'counter', 'me', false)).toBe('proposed');
    expect(nextMeetingState('proposed', 'agree', 'them', true)).toBe('agreed');
    expect(nextMeetingState('agreed', 'cancel', 'them', false)).toBe('cancelled');
  });

  it('an FYI, or an agreement whose time could not be read, moves nothing', () => {
    expect(nextMeetingState(null, 'fyi', 'them', false)).toBeNull();
    expect(nextMeetingState('offered', 'agree', 'them', false)).toBeNull();
    expect(nextMeetingState(null, 'cancel', 'them', false)).toBeNull();
  });

  it('once invited, new offers do not move it back', () => {
    expect(nextMeetingState('invited', 'offer_slots', 'them', false)).toBeNull();
    expect(nextMeetingState('invited', 'reschedule', 'them', true)).toBe('agreed');
  });
});

describe('a meeting followed across its emails', () => {
  let db: Kysely<DB>;
  let userId: string;
  let priorProvider: string;

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

  async function thread(gid: string): Promise<string> {
    const now = new Date().toISOString();
    const id = newId('emt');
    await db
      .insertInto('email_threads')
      .values({
        id,
        user_id: userId,
        gmail_thread_id: gid,
        subject: 'Catch up',
        snippet: 'Catch up',
        from_email: ROB,
        from_name: 'Rob Smith',
        last_message_at: now,
        created_at: now,
        updated_at: now,
        is_unread: 1,
      })
      .execute();
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:work', parentId: null, title: 'Work', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'c:work' }],
    });
    return id;
  }

  async function message(threadRow: string, gid: string, m: { from: string; to: string[]; cc?: string[]; body: string; sent?: boolean; at: string }) {
    await db
      .insertInto('email_messages')
      .values({
        id: newId('emm'),
        user_id: userId,
        thread_id: threadRow,
        gmail_message_id: newId('gm'),
        gmail_thread_id: gid,
        subject: 'Catch up',
        snippet: m.body.slice(0, 60),
        from_email: m.from,
        from_name: m.from === ME ? 'John' : 'Rob Smith',
        to_emails: JSON.stringify(m.to),
        cc_emails: JSON.stringify(m.cc ?? []),
        body_excerpt: m.body,
        ics_text: '',
        is_unread: m.sent ? 0 : 1,
        gmail_label_ids: JSON.stringify(m.sent ? ['SENT'] : ['INBOX', 'UNREAD']),
        internal_date: m.at,
        created_at: m.at,
      })
      .execute();
  }

  const stub = (block: Record<string, unknown>): EmailExtractor => ({
    async extract(input) {
      input.onScheduling?.(readSchedulingBlock(block)!);
      return null;
    },
  });

  const meeting = () =>
    db.selectFrom('meetings').selectAll().where('user_id', '=', userId).executeTakeFirst();

  it('Rob offers, the user agrees by email, and the meeting is agreed', async () => {
    const t0 = Date.now() - 3 * 3600_000;
    const row = await thread('t_rob');
    await message(row, 't_rob', {
      from: ROB,
      to: [ME],
      cc: [ANA],
      body: 'Hi John,\nI am mostly free tomorrow from 10-1. Anything work for you?\n\nBest\nRob',
      at: new Date(t0).toISOString(),
    });
    await runEmailMagics(db, userId, {
      extractor: stub({ act: 'offer_slots', offered: ['tomorrow from 10-1'], title: 'Catch up with Rob', assistants: [ANA] }),
    });
    let m = await meeting();
    expect(m).toMatchObject({ state: 'offered', thread_key: 'gmail:t_rob', core_people: [ROB], not_core: [ANA] });
    expect(m?.facts_json?.title).toBe('Catch up with Rob');

    // The user's reply, read for the scheduling block only.
    await message(row, 't_rob', {
      from: ME,
      to: [ROB],
      body: 'Tomorrow at 11am works. I will send an invite.\n\nOn Mon, Rob wrote:\n> mostly free tomorrow from 10-1',
      sent: true,
      at: new Date(t0 + 3600_000).toISOString(),
    });
    const read = await runOwnReplyScheduling(db, userId, {
      extractor: stub({ act: 'agree', agreed: 'tomorrow at 11am', inviteBy: 'them', inviteEvidence: 'I will send an invite' }),
    });
    expect(read).toBe(1);
    m = await meeting();
    expect(m?.state).toBe('agreed');
    // "I will send an invite" written BY the user: the user sends.
    expect(m?.invite_by).toBe('me');
    const sentDay = svWall(new Date(t0 + 3600_000), TZ).slice(0, 10);
    const tomorrow = new Date(Date.parse(`${sentDay}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(m?.agreed_start).toBe(`${tomorrow}T11:00:00${offsetForLocalDatetime(TZ, `${tomorrow}T11:00:00`)}`);

    // Read once: a second pass does not ask again.
    expect(await runOwnReplyScheduling(db, userId, { extractor: stub({ act: 'agree' }) })).toBe(0);
  });

  it('an FYI thread starts no meeting', async () => {
    const row = await thread('t_fyi');
    await message(row, 't_fyi', { from: 'sam@x.com', to: ['tom@x.com'], cc: [ME], body: 'Tom, when are you free?', at: new Date().toISOString() });
    await runEmailMagics(db, userId, { extractor: stub({ act: 'ask_times' }) });
    expect(await meeting()).toBeUndefined();
  });

  it('their invitation is that meeting: extra people and a dropped assistant change nothing', async () => {
    const row = await thread('t_rob');
    await message(row, 't_rob', { from: ROB, to: [ME], cc: [ANA], body: 'Free tomorrow from 10-1?', at: new Date().toISOString() });
    await runEmailMagics(db, userId, {
      extractor: stub({ act: 'offer_slots', offered: ['tomorrow from 10-1'], assistants: [ANA] }),
    });
    const m = await meeting();
    const day = m!.facts_json!.offered[0]!.day!;
    const start = `${day}T11:00:00${offsetForLocalDatetime(TZ, `${day}T11:00:00`)}`;

    // A stranger's invitation that day is not it.
    expect(
      await linkInviteToMeeting(db, userId, { uid: 'x@y', organizer: 'zed@other.org', people: [ME, ROB], startsAt: start }, TZ),
    ).toBeNull();
    // Rob's, with his CFO added and Ana gone, is.
    const linked = await linkInviteToMeeting(
      db,
      userId,
      { uid: 'ROB-INVITE@acme.com', organizer: ROB, people: [ME, 'cfo@acme.com'], startsAt: start },
      TZ,
    );
    expect(linked).toMatchObject({ state: 'invited', invite_uid: 'ROB-INVITE@acme.com' });
  });

  it('two meetings that could both be it: neither is picked', async () => {
    for (const gid of ['t_a', 't_b']) {
      const row = await thread(gid);
      await message(row, gid, { from: ROB, to: [ME], body: `Free tomorrow from 10-1 for ${gid}?`, at: new Date().toISOString() });
    }
    // One snapshot holding both (each ingest replaces the last).
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:work', parentId: null, title: 'Work', depth: 0 }],
      assignments: [
        { gmailThreadId: 't_a', categoryId: 'c:work' },
        { gmailThreadId: 't_b', categoryId: 'c:work' },
      ],
    });
    await runEmailMagics(db, userId, { extractor: stub({ act: 'offer_slots', offered: ['tomorrow from 10-1'] }) });
    const ms = await db.selectFrom('meetings').selectAll().where('user_id', '=', userId).execute();
    expect(ms).toHaveLength(2);
    const day = ms[0]!.facts_json!.offered[0]!.day!;
    const start = `${day}T11:00:00${offsetForLocalDatetime(TZ, `${day}T11:00:00`)}`;
    expect(await linkInviteToMeeting(db, userId, { uid: 'u', organizer: ROB, people: [ME], startsAt: start }, TZ)).toBeNull();
  });

  it('the linked invitation reads as already on the calendar beside the event agreed by email', async () => {
    const personalId = (await ensurePersonalGroup(db, userId)).id;
    const row = await thread('t_rob');
    await message(row, 't_rob', { from: ROB, to: [ME], cc: [ANA], body: 'Free tomorrow from 10-1?', at: new Date().toISOString() });
    await runEmailMagics(db, userId, { extractor: stub({ act: 'offer_slots', offered: ['tomorrow from 10-1'], assistants: [ANA] }) });
    const day = (await meeting())!.facts_json!.offered[0]!.day!;
    const at = (hhmm: string) => `${day}T${hhmm}:00${offsetForLocalDatetime(TZ, `${day}T${hhmm}:00`)}`;
    // Agreed by email and already put on the calendar from that thread, with
    // a title Rob's invitation does not share and no guest list.
    const agreed = await createEvent(db, {
      groupId: personalId,
      title: 'Coffee chat',
      startsAt: at('11:00'),
      endsAt: at('12:00'),
      createdBy: userId,
      sourceRawContext: 'gmail:t_rob',
    });
    // Sent by Ana for Rob: nobody on it overlaps the event made from the email.
    await linkInviteToMeeting(db, userId, { uid: 'ROB-INVITE@acme.com', organizer: ANA, people: [ME, ROB], startsAt: at('11:00') }, TZ);
    const fits = await calendarFitFor(db, userId, [
      {
        id: 'p1',
        tool_name: 'create_event',
        args_json: JSON.stringify({
          title: 'Q4 planning',
          startsAt: at('11:00'),
          endsAt: at('12:00'),
          alreadyInGoogle: true,
          externalUid: 'ROB-INVITE@acme.com',
          organizerEmail: ANA,
        }),
        provenance: 'gmail:t_invite',
      },
    ]);
    expect(fits.get('p1')).toMatchObject({ verdict: 'already', already: { eventId: agreed.id } });
  });
});
