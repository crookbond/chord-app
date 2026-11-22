/**
 * ADR 0328 — a group event invites the family.
 *
 * Before: a shared-group event wrote one silent copy onto each member's
 * calendar (ADR 0040 §7). When the organizer moved it, every calendar changed
 * and nobody was told; nobody could answer.
 *
 * Now the organizer's event carries the members as guests: the calendar mails
 * the invitation and later updates. A member Chord has no usable address for
 * (an Apple private-relay sign-in) still gets a copy. Google is the stateful
 * fake from `fake-google-calendar.ts`; every DB write is real.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

const sentMail: string[] = [];
vi.mock('@/services/google/gmail-api.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getGmailApi: vi.fn(async () => ({
    sendMessage: vi.fn(async (raw: string) => {
      sentMail.push(Buffer.from(raw, 'base64url').toString('utf8'));
      return { id: 'm1', threadId: 't1' };
    }),
  })),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { recordPendingFanout } from '@/services/bot/pending-fanout.js';
import { createEvent, deleteEvent, updateEvent } from '@/services/events.service.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { pullCalendarChanges, pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import type { CalendarTransport } from '@/services/google/calendar-transport.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { waitForFamilyInvites } from '../family-invite-tracker.js';
import { describeAnswers, eventGuestAnswers, responseFromPartstat, setGuestAnswer, waitingInvitations } from '../guest-answers.js';
import { answerFamilyInvite } from '../answer-invite.js';
import { parseIcsBuffer } from '@/services/ingest/ics/parse.js';

const CALENDAR = 'openid https://www.googleapis.com/auth/calendar';
const GMAIL_ONLY = 'openid https://www.googleapis.com/auth/gmail.modify';

const soon = (hour = 15): string => {
  const d = new Date(Date.now() + 5 * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hour}:00:00-04:00`;
};

describe('a group event invites the family (ADR 0328)', () => {
  let db: Kysely<DB>;
  let john: string;
  let priya: string;
  let ben: string;
  let familyId: string;
  let google: FakeGoogleCalendar;
  const saved = env.FAMILY_EVENT_INVITES;
  const setFlag = (on: boolean) => {
    (env as { FAMILY_EVENT_INVITES: boolean }).FAMILY_EVENT_INVITES = on;
  };

  const signIn = async (userId: string, fields: Record<string, unknown>) => {
    await db.updateTable('users').set(fields).where('id', '=', userId).execute();
  };

  const rowsOf = (title: string) =>
    db
      .selectFrom('events')
      .selectAll()
      .where('title', '=', title)
      .where('deleted_at', 'is', null)
      .execute();

  beforeEach(async () => {
    setFlag(true);
    sentMail.length = 0;
    db = await openTestDb();
    john = await createUser(db, 'john', 'John Doe');
    priya = await createUser(db, 'priya', 'Priya Doe');
    ben = await createUser(db, 'ben', 'Ben Doe');
    // The organizer: Google sign-in, calendar connected.
    await signIn(john, {
      google_sub: 'g-john',
      email: 'john@example.com',
      refresh_token_scopes: CALENDAR,
      google_connected_at: new Date().toISOString(),
    });
    // Signed in with Google but never connected the calendar to Chord: the
    // Google account still has a calendar the invitation lands on.
    await signIn(priya, { google_sub: 'g-priya', email: 'priya@example.com' });
    // Apple private relay: mail reaches him, a calendar does not.
    await signIn(ben, { apple_sub: 'a-ben', email: 'x7q2@privaterelay.appleid.com' });
    familyId = (await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true })).id;
    await addMember(db, familyId, priya);
    await addMember(db, familyId, ben);
    google = installFakeGoogleCalendar();
  });

  afterEach(async () => {
    await settleBackgroundWork();
    setFlag(saved);
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const createInFamily = async (title: string, startsAt = soon()) => {
    const out = await applyToolCall(db, {
      groupId: familyId,
      actorUserId: john,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      tzOffset: '-04:00',
      call: { name: 'create_event', args: { title, startsAt } } as never,
    });
    await settleBackgroundWork();
    return out;
  };

  it('invites the members it can address and gives the rest a copy', async () => {
    const out = await createInFamily('Dinner at Mazaa');

    const rows = await rowsOf('Dinner at Mazaa');
    const mine = rows.find((r) => r.owner_user_id === john)!;
    const hers = rows.find((r) => r.owner_user_id === priya)!;
    const his = rows.find((r) => r.owner_user_id === ben)!;

    // One provider event carries Priya as a guest; the invitation is the
    // calendar's to send.
    expect(google.guests(mine.gcal_event_id!)).toEqual(['priya@example.com']);
    expect(google.patches().at(-1)!.url).toContain('sendUpdates=all');

    // Priya's row is Chord's record of the invitation: never pushed, on no
    // calendar of hers, keyed by the UID the invitation arrives under.
    expect(hers).toMatchObject({
      invite_email: 'priya@example.com',
      invite_via: 'calendar',
      invite_uid: google.events.get(mine.gcal_event_id!)!.iCalUID,
      local_dirty: 0,
      google_calendar_id: null,
      gcal_event_id: null,
      role: 'attendee',
    });

    // Ben has no usable address: the copy he always had, queued for his
    // own calendar (he has not connected one, so nothing is sent yet).
    expect(his).toMatchObject({ invite_email: null, google_calendar_id: 'primary', chord_uid: his.id, local_dirty: 1 });
    // One provider event: John's. Nothing written for Priya.
    expect(google.requests.filter((r) => r.method === 'POST')).toHaveLength(1);

    expect(out.summary).toContain('invited Priya Doe from your calendar');
  });

  it("the invitation on the member's own calendar is the row she already has, not a second one", async () => {
    await createInFamily('Dinner at Mazaa');
    const hers = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;

    // Priya connects her calendar later. Google filed the invitation there
    // under the organizer's event's UID, with an id of its own.
    const item = {
      id: 'g_priya_invite',
      iCalUID: hers.invite_uid!,
      status: 'confirmed',
      summary: 'Dinner at Mazaa',
      start: { dateTime: hers.starts_at },
      end: { dateTime: soon(16) },
      updated: new Date().toISOString(),
      sequence: 0,
      organizer: { email: 'john@example.com', self: false },
      attendees: [
        { email: 'john@example.com', organizer: true, responseStatus: 'accepted' },
        { email: 'priya@example.com', self: true, responseStatus: 'needsAction' },
      ],
    };
    const transport = {
      listChanges: async () => ({ items: [item], nextSyncToken: 'tok', wasFullSync: true }),
    } as unknown as CalendarTransport;
    await pullCalendarChanges(db, priya, 'primary', 'fake-token', transport);

    const after = (await rowsOf('Dinner at Mazaa')).filter((r) => r.owner_user_id === priya);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: hers.id, gcal_event_id: 'g_priya_invite', invite_email: 'priya@example.com' });
  });

  describe('who is coming', () => {
    /** The organizer's calendar, as Google holds it after guests answered. */
    const organizerPull = async (attendees: Array<Record<string, unknown>>) => {
      const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;
      const remote = google.events.get(mine.gcal_event_id!)!;
      const item = {
        ...remote,
        status: 'confirmed',
        updated: new Date().toISOString(),
        attendees,
      };
      const transport = {
        listChanges: async () => ({ items: [item], nextSyncToken: 'tok2', wasFullSync: true }),
      } as unknown as CalendarTransport;
      await pullCalendarChanges(db, john, 'primary', 'fake-token', transport);
      return mine;
    };

    it('a just-invited member shows as not answered, on her copy as well as the organizer’s', async () => {
      await createInFamily('Dinner at Mazaa');
      const rows = await rowsOf('Dinner at Mazaa');
      const mine = rows.find((r) => r.owner_user_id === john)!;
      const hers = rows.find((r) => r.owner_user_id === priya)!;

      const expected = [{ email: 'priya@example.com', name: 'Priya Doe', response: 'needsAction' }];
      expect(await eventGuestAnswers(db, mine.id, john)).toEqual(expected);
      expect(await eventGuestAnswers(db, hers.id, priya)).toEqual(expected);
    });

    it('an answer given in Google reaches Chord through the organizer’s calendar sync', async () => {
      await createInFamily('Dinner at Mazaa');
      const mine = await organizerPull([
        { email: 'john@example.com', organizer: true, self: true, responseStatus: 'accepted' },
        { email: 'priya@example.com', responseStatus: 'accepted' },
      ]);

      expect(await eventGuestAnswers(db, mine.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'accepted' },
      ]);
    });

    it('a no still shows to the organizer after the member’s own copy is gone', async () => {
      await createInFamily('Dinner at Mazaa');
      const hers = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;
      // Priya declines on her calendar: her pull drops her copy (Chord does
      // not show a meeting someone said no to).
      const declined = {
        id: 'g_priya_invite',
        iCalUID: hers.invite_uid!,
        status: 'confirmed',
        summary: 'Dinner at Mazaa',
        start: { dateTime: hers.starts_at },
        end: { dateTime: soon(16) },
        updated: new Date().toISOString(),
        sequence: 0,
        organizer: { email: 'john@example.com', self: false },
        attendees: [{ email: 'priya@example.com', self: true, responseStatus: 'declined' }],
      };
      await pullCalendarChanges(db, priya, 'primary', 'fake-token', {
        listChanges: async () => ({ items: [declined], nextSyncToken: 'tok', wasFullSync: true }),
      } as unknown as CalendarTransport);
      expect((await rowsOf('Dinner at Mazaa')).some((r) => r.owner_user_id === priya)).toBe(false);

      const mine = await organizerPull([
        { email: 'john@example.com', organizer: true, self: true, responseStatus: 'accepted' },
        { email: 'priya@example.com', responseStatus: 'declined' },
      ]);
      expect(await eventGuestAnswers(db, mine.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'declined' },
      ]);
    });

    it('a mailed reply records the answer on an event invited by mail', async () => {
      await signIn(john, { refresh_token_scopes: GMAIL_ONLY });
      const ev = await createEvent(db, { groupId: familyId, createdBy: john, title: 'Dinner at Mazaa', startsAt: soon() });
      await waitForFamilyInvites(ev.id);
      const org = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;
      expect(await eventGuestAnswers(db, ev.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'needsAction' },
      ]);

      // What Google sends the organizer when Priya says yes on her calendar.
      const reply = [
        'BEGIN:VCALENDAR',
        'METHOD:REPLY',
        'BEGIN:VEVENT',
        `UID:${org.ical_uid}`,
        'DTSTART:20261115T190000Z',
        'SUMMARY:Dinner at Mazaa',
        'ORGANIZER:mailto:john@example.com',
        'ATTENDEE;PARTSTAT=ACCEPTED;CN=Priya Doe;X-NUM-GUESTS=0:mailto:priya@exam',
        ' ple.com',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n');
      const replies = parseIcsBuffer(Buffer.from(reply, 'utf8')).replies;
      expect(replies).toEqual([{ uid: org.ical_uid, email: 'priya@example.com', partstat: 'ACCEPTED' }]);
      for (const r of replies) {
        await setGuestAnswer(db, {
          organizerId: john,
          icalUid: r.uid,
          email: r.email,
          response: responseFromPartstat(r.partstat)!,
        });
      }

      expect(await eventGuestAnswers(db, ev.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'accepted' },
      ]);
      expect(describeAnswers(await eventGuestAnswers(db, ev.id, john))).toBe('Priya Doe: yes');
    });
  });

  it('a retitle tells nobody; a new time tells the guests and leaves the invited row unpushed', async () => {
    await createInFamily('Dinner at Mazaa');
    const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;
    const before = google.patches().length;

    await updateEvent(db, mine.id, { title: 'Dinner at Mazaa (UWS)' });
    await settleBackgroundWork();
    await pushDirtyEvents(db, john);
    const retitle = google.patches().slice(before).filter((p) => p.url.includes(mine.gcal_event_id!));
    expect(retitle.length).toBeGreaterThan(0);
    expect(retitle.every((p) => !p.url.includes('sendUpdates=all'))).toBe(true);

    const mid = google.patches().length;
    await updateEvent(db, mine.id, { startsAt: soon(18) });
    await settleBackgroundWork();
    await pushDirtyEvents(db, john);
    const moved = google.patches().slice(mid).filter((p) => p.url.includes(mine.gcal_event_id!));
    expect(moved.some((p) => p.url.includes('sendUpdates=all'))).toBe(true);

    const hers = (await rowsOf('Dinner at Mazaa (UWS)')).find((r) => r.owner_user_id === priya)!;
    expect(hers.starts_at).toBe(soon(18));
    expect(hers.local_dirty).toBe(0);
    expect(hers.guest_notice_due).toBe(0);
    const mineAfter = (await rowsOf('Dinner at Mazaa (UWS)')).find((r) => r.owner_user_id === john)!;
    expect(mineAfter.guest_notice_due).toBe(0);
  });

  it('deleting the event cancels it for the guests', async () => {
    await createInFamily('Dinner at Mazaa');
    const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;

    await deleteEvent(db, mine.id);
    await settleBackgroundWork();

    const del = google.requests.find((r) => r.method === 'DELETE' && r.url.includes(mine.gcal_event_id!));
    expect(del?.url).toContain('sendUpdates=all');
    expect(await rowsOf('Dinner at Mazaa')).toHaveLength(0);
  });

  it('an invitation that cannot go out leaves the members with copies, and says so', async () => {
    // The organizer's calendar refuses the event, so there is no provider
    // event to put guests on.
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'POST') {
          return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
        }
        return realFetch(url, init);
      }),
    );

    const out = await createInFamily('Dinner at Mazaa');

    const hers = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;
    expect(hers.invite_email).toBeNull();
    expect(hers.google_calendar_id).toBe('primary');
    expect(out.summary).toContain('NO invitations went out');
    expect(out.summary).not.toContain('invited Priya');
  });

  it('an organizer with a mailbox but no calendar mails the invitation and the cancellation', async () => {
    await signIn(john, { refresh_token_scopes: GMAIL_ONLY });

    const ev = await createEvent(db, { groupId: familyId, createdBy: john, title: 'Dinner at Mazaa', startsAt: soon() });
    const result = await waitForFamilyInvites(ev.id);
    await settleBackgroundWork();

    expect(result).toMatchObject({ ok: true, via: 'mail' });
    // Calendar lines fold at 75 octets (RFC 5545 §3.1); read them unfolded.
    const request = sentMail.find((m) => m.includes('METHOD:REQUEST'))!.replace(/\r\n /g, '');
    expect(request).toContain('To: priya@example.com');
    expect(request).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Priya Doe:mailto:priya@example.com');
    expect(request).toContain('ORGANIZER;CN=John Doe:mailto:john@example.com');
    const hers = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;
    expect(hers).toMatchObject({ invite_via: 'mail', invite_uid: hers.ical_uid });

    await updateEvent(db, ev.id, { startsAt: soon(19) });
    await settleBackgroundWork();
    expect(sentMail.filter((m) => m.includes('METHOD:REQUEST'))).toHaveLength(2);

    await deleteEvent(db, ev.id);
    await settleBackgroundWork();
    const cancel = sentMail.find((m) => m.includes('METHOD:CANCEL'))!;
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(cancel).toContain(`UID:${hers.ical_uid}`);
  });

  it('with the flag off every member still gets a copy', async () => {
    setFlag(false);
    await createInFamily('Dinner at Mazaa');

    const rows = await rowsOf('Dinner at Mazaa');
    expect(rows.every((r) => r.invite_email === null)).toBe(true);
    const mine = rows.find((r) => r.owner_user_id === john)!;
    expect(google.guests(mine.gcal_event_id!)).toEqual([]);
  });

  it('sharing a personal event moves it and invites the family, keeping its guests', async () => {
    const personalId = (await ensurePersonalGroup(db, john)).id;
    const ev = await createEvent(db, { groupId: personalId, createdBy: john, title: 'Call with Kevin', startsAt: soon() });
    await settleBackgroundWork();
    const before = (await rowsOf('Call with Kevin'))[0]!;
    // A guest already on it (ADR 0295), which the old re-create refused.
    google.events.get(before.gcal_event_id!)!.attendees = [{ email: 'kevin@example.com' }];
    await recordPendingFanout(db, personalId, john, {
      kind: 'event',
      entityId: ev.id,
      title: 'Call with Kevin',
      groups: ['Doe Family'],
    });

    const out = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: john,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      tzOffset: '-04:00',
      call: { name: 'share_event', args: {} } as never,
    });
    await settleBackgroundWork();

    expect(out.data).toMatchObject({ ok: true, moved: true });
    const rows = await rowsOf('Call with Kevin');
    const mine = rows.find((r) => r.owner_user_id === john)!;
    // The same row and the same provider event, now the group's.
    expect(mine.id).toBe(ev.id);
    expect(mine.group_id).toBe(familyId);
    expect(mine.gcal_event_id).toBe(before.gcal_event_id);
    expect(google.guests(mine.gcal_event_id!)).toEqual(['kevin@example.com', 'priya@example.com']);
    expect(rows.find((r) => r.owner_user_id === priya)?.invite_email).toBe('priya@example.com');
    expect(rows.find((r) => r.owner_user_id === ben)?.invite_email).toBeNull();
    expect(google.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  describe('answering from inside Chord', () => {
    /** Priya can send mail: Google sign-in with Gmail. The invitation is not
     *  on her calendar (Chord was never given it), so her answer goes as a
     *  reply email to the organizer, the way Gmail's own buttons do. */
    const setUp = async () => {
      await signIn(priya, { refresh_token_scopes: GMAIL_ONLY });
      await createInFamily('Dinner at Mazaa');
      return (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;
    };

    it('a yes goes to the organizer and shows as her answer', async () => {
      const hers = await setUp();
      const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;

      const r = await answerFamilyInvite(db, { eventId: hers.id, userId: priya, response: 'accepted' });

      expect(r).toEqual({ ok: true, response: 'accepted', via: 'email', removed: false });
      const reply = sentMail.find((m) => m.includes('METHOD:REPLY'))!.replace(/\r\n /g, '');
      expect(reply).toContain('To: john@example.com');
      expect(reply).toContain(`UID:${hers.invite_uid}`);
      expect(reply).toContain('PARTSTAT=ACCEPTED');
      expect(reply).toContain('mailto:priya@example.com');
      expect(await eventGuestAnswers(db, mine.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'accepted' },
      ]);
      expect(await waitingInvitations(db, priya)).toMatchObject([{ id: hers.id, response: 'accepted' }]);
    });

    it('a no takes it off her calendar in Chord and the organizer still sees it', async () => {
      const hers = await setUp();
      const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;

      const r = await answerFamilyInvite(db, { eventId: hers.id, userId: priya, response: 'declined' });

      expect(r).toMatchObject({ ok: true, removed: true });
      expect((await rowsOf('Dinner at Mazaa')).some((x) => x.owner_user_id === priya)).toBe(false);
      expect(await eventGuestAnswers(db, mine.id, john)).toEqual([
        { email: 'priya@example.com', name: 'Priya Doe', response: 'declined' },
      ]);
      // Her delete stays in Chord: the organizer's event is not touched.
      expect(google.requests.some((x) => x.method === 'DELETE')).toBe(false);
    });

    it('an answer that cannot be sent is not recorded', async () => {
      // Signed in with Google but no Gmail: nothing can carry the reply.
      await createInFamily('Dinner at Mazaa');
      const hers = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === priya)!;
      const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;
      const { getGmailApi } = await import('@/services/google/gmail-api.js');
      vi.mocked(getGmailApi).mockRejectedValueOnce(new Error('no gmail scope'));

      const r = await answerFamilyInvite(db, { eventId: hers.id, userId: priya, response: 'accepted' });

      expect(r.ok).toBe(false);
      expect(await eventGuestAnswers(db, mine.id, john)).toMatchObject([{ response: 'needsAction' }]);
    });

    it('the organizer’s own copy is not an invitation to answer', async () => {
      await createInFamily('Dinner at Mazaa');
      const mine = (await rowsOf('Dinner at Mazaa')).find((r) => r.owner_user_id === john)!;
      expect(await answerFamilyInvite(db, { eventId: mine.id, userId: john, response: 'accepted' })).toEqual({
        ok: false,
        reason: 'not_invited',
      });
    });

    it('in chat, "count me in for dinner" answers her invitation', async () => {
      const hers = await setUp();
      const personal = (await ensurePersonalGroup(db, priya)).id;

      const out = await applyToolCall(db, {
        groupId: personal,
        actorUserId: priya,
        provenance: null,
        turnId: `turn-${Math.random()}`,
        tzOffset: '-04:00',
        call: { name: 'answer_invitation', args: { eventTitle: 'dinner', response: 'yes' } } as never,
      });

      expect(out.data).toMatchObject({ answered: true, response: 'yes', via: 'email' });
      expect(await waitingInvitations(db, priya)).toMatchObject([{ id: hers.id, response: 'accepted' }]);
    });

    it('in chat, a title matching nothing answers nothing and lists what is waiting', async () => {
      const hers = await setUp();
      const personal = (await ensurePersonalGroup(db, priya)).id;

      const out = await applyToolCall(db, {
        groupId: personal,
        actorUserId: priya,
        provenance: null,
        turnId: `turn-${Math.random()}`,
        tzOffset: '-04:00',
        call: { name: 'answer_invitation', args: { eventTitle: 'soccer', response: 'no' } } as never,
      });

      expect(out.data).toMatchObject({ answered: false, reason: 'not_found', candidates: [{ eventId: hers.id }] });
      expect(sentMail.some((m) => m.includes('METHOD:REPLY'))).toBe(false);
    });
  });
});
