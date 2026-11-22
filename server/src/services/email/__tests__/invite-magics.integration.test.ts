/**
 * Calendar-invite emails: the magics pass parses the .ics deterministically
 * (never the LLM), keys the proposal on the invite UID, and the executor's
 * dedup ladder reconciles it with a Google-side accept in either order —
 * no more one-UTC-one-local duplicate events.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Confirming an invitation answers the organizer first (ADR 0104 addendum).
// These tests are about dedup, not about reaching Google, so the reply is
// stubbed as delivered; rsvp.integration.test.ts covers the reply itself.
const respondToInvite = vi.hoisted(() => vi.fn(async () => ({ ok: true, via: 'email' })));
vi.mock('@/services/google/rsvp.service.js', () => ({ respondToInvite }));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import { __addGmailMockMessage, __resetGmailMock } from '@/services/google/gmail-api.js';
import { backfillGmail } from '@/services/google/gmail.service.js';
import type { GmailRawMessage } from '@/services/google/gmail-sync.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { findIcsPart, probeResultFromIcs } from '@/services/email/invite-ics.js';
import { runEmailMagics, type EmailExtractor } from '@/services/email/magics.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/**
 * Fixture dates are relative (ADR 0100's precedent, load-bearing again for
 * ADR 0137): a past `startsAt` stages nothing, so a literal date would rot
 * these into tests that pass having asserted nothing.
 *
 * D_INVITE is the meeting; D_LATER a couple of days after it; D_SENT is when
 * the invitation mail arrived, a week before.
 */
const day = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const D_INVITE = day(14);
const D_LATER = day(16);
const D_SENT = day(7);
/**
 * The UTC instant of a New York wall-clock time on `isoDay`, worked out from
 * the platform's zone data rather than a fixed offset: the meeting date moves
 * with today, so it is in summer time on some days and winter time on others.
 */
const newYorkWallToUtcMs = (isoDay: string, hh: number): number => {
  const guess = Date.parse(`${isoDay}T${String(hh).padStart(2, '0')}:00:00Z`);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(guess))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return guess - (wall - guess);
};

/** `YYYY-MM-DD` + `HHMMSS` as an RFC 5545 local/floating stamp. */
const at = (isoDay: string, hms: string): string => `${isoDay.replace(/-/g, '')}T${hms}`;

const INVITE_UID = 'abc123invite@google.com';

const INVITE_ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  `UID:${INVITE_UID}`,
  'SUMMARY:Coffee with Adrian',
  'LOCATION:Blue Bottle',
  `DTSTART;TZID=America/New_York:${at(D_INVITE, '110000')}`,
  `DTEND;TZID=America/New_York:${at(D_INVITE, '113000')}`,
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

function inviteMessage(): GmailRawMessage {
  return {
    id: 'm_invite1',
    threadId: 't_invite1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: 'Invitation: Coffee @ Mon Aug 10 11am',
    internalDate: String(Date.parse(`${D_SENT}T14:00:00Z`)),
    historyId: '2',
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Adrian <adrian@example.com>' },
        { name: 'To', value: 'you@example.com' },
        { name: 'Subject', value: 'Invitation: Coffee @ Mon Aug 10 11am' },
        { name: 'Date', value: 'Mon, 3 Aug 2026 10:00:00 -0400' },
        { name: 'Message-ID', value: '<invite1@example.com>' },
      ],
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('You are invited to coffee.').toString('base64url') },
        },
        {
          mimeType: 'text/calendar',
          body: { data: Buffer.from(INVITE_ICS, 'utf8').toString('base64url') },
        },
      ],
    },
  };
}

const throwingExtractor: EmailExtractor = {
  extract: () => {
    throw new Error('LLM extractor must not run for a calendar-invite email');
  },
};

describe('invite-ics part detection (pure)', () => {
  it('finds an inline text/calendar part and parses the VEVENT with its zone', () => {
    const part = findIcsPart(inviteMessage());
    expect(part?.data).toBeTruthy();
    const ev = probeResultFromIcs(Buffer.from(part!.data!, 'base64url')).event;
    expect(ev?.uid).toBe(INVITE_UID);
    expect(ev?.title).toBe('Coffee with Adrian');
    // 11:00 America/New_York in the sender's zone, not UTC-as-11:00.
    expect(Date.parse(ev!.startsAt)).toBe(newYorkWallToUtcMs(D_INVITE, 11));
  });

  it('returns null for a non-invite message', () => {
    const raw = inviteMessage();
    raw.payload!.parts = raw.payload!.parts!.filter((p) => p.mimeType !== 'text/calendar');
    expect(findIcsPart(raw)).toBeNull();
  });
});

describe('invite email → deterministic proposal → accepted-invite dedup', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    __resetGmailMock();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    (env as { EMAIL_CLASSIFIER: string }).EMAIL_CLASSIFIER = '';
    db = await openTestDb();
    userId = await createUser(db, 'invite-user');
    await ensurePersonalGroup(db, userId);
    __addGmailMockMessage(userId, inviteMessage());
    await backfillGmail(db, userId);
    // Magics only processes classified threads — assign a category directly
    // (the classifier is off in this suite).
    const now = new Date().toISOString();
    await db
      .insertInto('email_categories')
      .values({
        id: 'cat_inv',
        user_id: userId,
        parent_id: null,
        title: 'Events & invites',
        depth: 0,
        sort_order: 0,
        updated_at: now,
      })
      .execute();
    await db
      .updateTable('email_threads')
      .set({ category_id: 'cat_inv', classified_at: now })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_invite1')
      .execute();
  });

  afterEach(async () => {
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    await closeTestDb(db);
  });

  const pendingProposal = () =>
    db
      .selectFrom('proposals')
      .selectAll()
      .where('proposed_by_user_id', '=', userId)
      .where('provenance', '=', 'gmail:t_invite1')
      .executeTakeFirst();

  it('an invite synced inline is read from the mirror, not fetched again', async () => {
    // Sync fetched the message in full, so its .ics is already stored; the
    // probe used to fetch the whole message again (plus the attachment) for
    // every thread. With the provider unreachable, only the stored copy can
    // answer.
    const stored = await db
      .selectFrom('email_messages')
      .select('ics_text')
      .where('user_id', '=', userId)
      .where('gmail_message_id', '=', 'm_invite1')
      .executeTakeFirstOrThrow();
    expect(stored.ics_text).toContain('BEGIN:VCALENDAR');
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    const res = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(res.events).toBe(1);
    expect(await pendingProposal()).toBeDefined();
  });

  it('an invitation to an event the user already has stages no card (ADR 0328)', async () => {
    // A family member's group event: Chord already gave this user a row for
    // it, keyed by the UID the invitation email arrives under. A card would
    // ask them to add what is already on their calendar.
    const groupId = (await ensurePersonalGroup(db, userId)).id;
    const ev = await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Coffee with Adrian',
      startsAt: `${D_INVITE}T11:00:00-04:00`,
    });
    await db.updateTable('events').set({ invite_uid: INVITE_UID }).where('id', '=', ev.id).execute();

    await runEmailMagics(db, userId, { extractor: throwingExtractor });

    expect(await pendingProposal()).toBeUndefined();
  });

  it('a failing invite probe DEFERS the thread — no LLM parse, no permanent mark', async () => {
    // A row from before the .ics was captured at sync (NULL) still needs the
    // provider. Simulate the API being unreachable (e.g. OAuth env missing on
    // a dev box): provider 'real' with no OAuth configured throws in the probe.
    await db.updateTable('email_messages').set({ ics_text: null }).where('user_id', '=', userId).execute();
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'real';
    const res = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(res.events).toBe(0);
    expect(await pendingProposal()).toBeUndefined();
    const marks = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', userId)
      .where('kind', '=', 'magic')
      .execute();
    expect(marks).toHaveLength(0); // deferred, not consumed

    // API back → the same thread stages its UID proposal on the next pass.
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    const retry = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(retry.events).toBe(1);
    expect(await pendingProposal()).toBeDefined();
  });

  it('stages a UID-keyed event proposal from the .ics without calling the LLM', async () => {
    const res = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(res.events).toBe(1);

    const p = await pendingProposal();
    expect(p).toBeDefined();
    expect(p!.tool_name).toBe('create_event');
    const args = JSON.parse(p!.args_json) as { externalUid: string; startsAt: string };
    expect(args.externalUid).toBe(INVITE_UID);
    expect(Date.parse(args.startsAt)).toBe(newYorkWallToUtcMs(D_INVITE, 11));
  });

  it('a re-mined invite whose card was already confirmed stages no second card (ADR 0244 addendum)', async () => {
    // The invite branch skipped `threadAlreadyProposed`, the once-per-thread
    // rule every other email card follows (ADR 0187/0243): confirmed cards are
    // not "pending", so the UID dedup missed them and a re-mine (extraction
    // marks wiped, a second process) offered the same invitation again.
    await runEmailMagics(db, userId, { extractor: throwingExtractor });
    await db
      .updateTable('proposals')
      .set({ status: 'confirmed', resolved_at: new Date().toISOString() })
      .where('provenance', '=', 'gmail:t_invite1')
      .execute();
    await db.deleteFrom('email_extraction_marks').where('user_id', '=', userId).execute();

    const again = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(again.events).toBe(0);
    const cards = await db
      .selectFrom('proposals')
      .select('status')
      .where('provenance', '=', 'gmail:t_invite1')
      .execute();
    expect(cards.map((c) => c.status)).toEqual(['confirmed']);
  });

  it('an already-accepted invite (same UID on the calendar) auto-retracts its card', async () => {
    // The user accepted in Google: the synced copy carries the invite's UID.
    const synced = await createEvent(db, {
      groupId: (await ensurePersonalGroup(db, userId)).id,
      createdBy: userId,
      title: 'Coffee with Adrian',
      startsAt: `${D_INVITE}T11:00:00-04:00`,
      endsAt: `${D_INVITE}T11:30:00-04:00`,
      externalUid: `gcal:evt1`,
    });
    await db
      .updateTable('events')
      .set({ ical_uid: INVITE_UID })
      .where('id', '=', synced.id)
      .execute();

    // The sweep sees the UID already on the calendar: no pending card left,
    // nothing for the user to act on, and no twin event either.
    await runEmailMagics(db, userId, { extractor: throwingExtractor });
    const p = await pendingProposal();
    expect(p?.status).toBe('expired');

    const rows = await db
      .selectFrom('events')
      .select(['id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(synced.id);
  });

  it('a METHOD:CANCEL email retracts the proposal and cancels the event — never creates', async () => {
    // Invite arrives and is staged; the user also confirmed it into an event.
    await runEmailMagics(db, userId, { extractor: throwingExtractor });
    const p = await pendingProposal();
    const confirmed = await confirmProposal(db, { id: p!.id, resolvedByUserId: userId });
    expect(confirmed.ok).toBe(true);
    expect(respondToInvite).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      expect.objectContaining({ response: 'accepted' }),
    );

    // The organizer cancels: same UID, METHOD:CANCEL, no STATUS on the VEVENT.
    const cancelIcs = [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      `UID:${INVITE_UID}`,
      'SUMMARY:Coffee with Adrian',
      `DTSTART;TZID=America/New_York:${at(D_INVITE, '110000')}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    __addGmailMockMessage(userId, {
      id: 'm_cancel1',
      threadId: 't_cancel1',
      labelIds: ['INBOX'],
      snippet: 'Canceled event: Coffee',
      internalDate: String(Date.parse(`${D_SENT}T09:00:00Z`)),
      historyId: '3',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'Adrian <adrian@example.com>' },
          { name: 'Subject', value: 'Canceled event: Coffee @ Mon Aug 10 11am' },
          { name: 'Date', value: 'Tue, 4 Aug 2026 05:00:00 -0400' },
          { name: 'Message-ID', value: '<cancel1@example.com>' },
        ],
        parts: [
          {
            mimeType: 'text/calendar',
            body: { data: Buffer.from(cancelIcs, 'utf8').toString('base64url') },
          },
        ],
      },
    });
    await backfillGmail(db, userId);
    const now = new Date().toISOString();
    await db
      .updateTable('email_threads')
      .set({ category_id: 'cat_inv', classified_at: now })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_cancel1')
      .execute();

    const res = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(res.events).toBe(0); // the cancellation staged NOTHING

    const evt = await db
      .selectFrom('events')
      .select(['status', 'local_dirty'])
      .where('owner_user_id', '=', userId)
      .where('ical_uid', '=', INVITE_UID)
      .executeTakeFirstOrThrow();
    expect(evt.status).toBe('cancelled');
    expect(evt.local_dirty).toBe(1); // cancel propagates on the next push
  });

  it('a cancellation with no prior invite is a silent no-op (nothing staged)', async () => {
    // Reject the staged invite proposal so only the cancel thread is fresh.
    await runEmailMagics(db, userId, { extractor: throwingExtractor });

    const cancelIcs = [
      'BEGIN:VCALENDAR',
      'METHOD:CANCEL',
      'BEGIN:VEVENT',
      'UID:never-seen-uid@google.com',
      'SUMMARY:Mystery meeting',
      `DTSTART;TZID=America/New_York:${at(D_LATER, '090000')}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    __addGmailMockMessage(userId, {
      id: 'm_cancel2',
      threadId: 't_cancel2',
      labelIds: ['INBOX'],
      snippet: 'Canceled event: Mystery meeting',
      internalDate: String(Date.parse(`${D_SENT}T10:00:00Z`)),
      historyId: '4',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'Subject', value: 'Canceled event: Mystery meeting' },
          { name: 'Message-ID', value: '<cancel2@example.com>' },
        ],
        parts: [
          {
            mimeType: 'text/calendar',
            body: { data: Buffer.from(cancelIcs, 'utf8').toString('base64url') },
          },
        ],
      },
    });
    await backfillGmail(db, userId);
    const now = new Date().toISOString();
    await db
      .updateTable('email_threads')
      .set({ category_id: 'cat_inv', classified_at: now })
      .where('user_id', '=', userId)
      .where('gmail_thread_id', '=', 't_cancel2')
      .execute();

    const res = await runEmailMagics(db, userId, { extractor: throwingExtractor });
    expect(res.events).toBe(0);
    const count = await db
      .selectFrom('events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('owner_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(0);
  });

  it('fuzzy net: a keyless same-title same-hour twin dedups too', async () => {
    const personal = await ensurePersonalGroup(db, userId);
    await createEvent(db, {
      groupId: personal.id,
      createdBy: userId,
      title: 'Coffee with Adrian',
      startsAt: `${D_INVITE}T11:15:00-04:00`,
    });
    await runEmailMagics(db, userId, { extractor: throwingExtractor });
    const p = await pendingProposal();
    const confirmed = await confirmProposal(db, { id: p!.id, resolvedByUserId: userId });
    expect(confirmed.ok).toBe(true);

    const rows = await db
      .selectFrom('events')
      .select(['id', 'title'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
