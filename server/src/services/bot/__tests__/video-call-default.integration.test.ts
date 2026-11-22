/**
 * ADR 0319 — a video call nobody asked for follows the calendar's provider.
 *
 * Reported 2026-11-05: Google Meet behaved as Chord's default for meetings on
 * every calendar. ADR 0317 shipped `videoCall` with "Only set it when asked"
 * as a prompt instruction and nothing else, and ADR 0229 had already recorded
 * that models through OpenRouter fill every optional field — so a plain "set
 * up a meeting with Sarah at 3" arrives with `videoCall: true`, and the
 * executor acted on it wherever the event landed. On an Outlook / 365
 * calendar that produced a refusal note about a Google Meet nobody mentioned.
 *
 * This file is the rule: does the default follow the calendar's provider, and
 * is an unasked one silent. What each provider then WRITES has its own file —
 * Teams in events/__tests__/teams-meeting.integration.test.ts (ADR 0323). The
 * `outlook:` key here deliberately has no mailbox behind it, so it covers the
 * no-connection case rather than a working 365 calendar.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { eventVideoCallOption } from '@/services/events/guests.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

/** What the model sends for a plain meeting request, filled-in field and all. */
const MEETING = '@Chord set up a meeting with Sarah tomorrow at 3pm';
const ASKED = '@Chord set up a meeting with Sarah tomorrow at 3pm and add a google meet';
const OUTLOOK_CAL = 'outlook:acct_1:AAMkADExampleCalendar';

describe('a video call nobody asked for (ADR 0319)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let google: FakeGoogleCalendar;

  const soon = (): string => {
    const d = new Date(Date.now() + 2 * 86_400_000);
    return `${d.toISOString().slice(0, 10)}T15:00:00+00:00`;
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
      .where('id', '=', userId)
      .execute();
    groupId = (await ensurePersonalGroup(db, userId)).id;
    google = installFakeGoogleCalendar();
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const say = async (body: string): Promise<string> =>
    (await insertMessage(db, { groupId, senderId: userId, body })).id;

  const call = (name: string, args: Record<string, unknown>, triggeringMessageId?: string) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tzOffset: '+00:00',
      call: { name, args } as never,
      ...(triggeringMessageId ? { triggeringMessageId } : {}),
    });

  /** Put the event on an Outlook calendar, as a 365 user's own event is. */
  const moveToOutlook = async (title: string): Promise<void> => {
    await settleBackgroundWork();
    await db
      .updateTable('events')
      .set({ google_calendar_id: OUTLOOK_CAL })
      .where('owner_user_id', '=', userId)
      .where('title', '=', title)
      .execute();
  };

  const conferencePatches = () => google.patches().filter((p) => p.body?.conferenceData);

  describe('Outlook / Microsoft 365', () => {
    it('the reported case: an unasked videoCall on a 365 calendar adds nothing and says nothing', async () => {
      await call('create_event', { title: 'Meeting with Sarah', startsAt: soon() });
      await moveToOutlook('Meeting with Sarah');

      const res = await call(
        'update_event',
        { titleContains: 'Meeting with Sarah', location: 'Office', videoCall: true },
        await say(MEETING),
      );

      expect(res.data).toMatchObject({ updated: true });
      // Nothing was written, and nothing about Meet reaches the model: a
      // refusal for something nobody asked for is noise (ADR 0229's posture).
      expect(conferencePatches()).toEqual([]);
      expect(res.summary).not.toMatch(/Google Meet|video call/i);
    });

    it('create_event with an unasked videoCall on a 365 calendar says nothing either', async () => {
      // The default target is the 365 calendar for this user's next event.
      await db
        .updateTable('users')
        .set({ default_calendar_id: OUTLOOK_CAL })
        .where('id', '=', userId)
        .execute();
      const res = await call(
        'create_event',
        { title: 'Sync with Sarah', startsAt: soon(), videoCall: true },
        await say(MEETING),
      );
      expect(conferencePatches()).toEqual([]);
      expect(res.summary).not.toMatch(/Google Meet|video call/i);
    });

    // ADR 0323 flipped this. It used to assert the refusal said Chord "cannot
    // create a Teams meeting" — it can now, so on a 365 calendar an explicit
    // ask is honoured (see events/__tests__/teams-meeting.integration.test.ts).
    // What is left here is the case this fixture really is: a 365 calendar key
    // with no mailbox behind it, which is not a connected calendar at all.
    it('an explicit ask on a 365 key with no mailbox says so, and never offers a Meet', async () => {
      await call('create_event', { title: 'Review with Sarah', startsAt: soon() });
      await moveToOutlook('Review with Sarah');

      const res = await call(
        'update_event',
        { titleContains: 'Review with Sarah', videoCall: true },
        await say('@Chord add a video call to the review'),
      );

      // A Google conference is never created for a 365 event, whatever else
      // happens: that is the half of ADR 0319 this ADR does not touch.
      expect(conferencePatches()).toEqual([]);
      expect(res.summary).toMatch(/NO video call link was added/);
      expect(res.summary).toMatch(/not on a connected calendar/);
    });
  });

  describe('a Google-driven calendar keeps Google Meet as its default', () => {
    it('an unasked videoCall still adds the Meet link', async () => {
      const res = await call(
        'create_event',
        { title: 'Meeting with Sarah', startsAt: soon(), videoCall: true },
        await say(MEETING),
      );
      expect(res.summary).toMatch(/added a Google Meet link/);
      expect(conferencePatches()).toHaveLength(1);
    });

    it('an explicit ask adds it too', async () => {
      const res = await call(
        'create_event',
        { title: 'Call with Sarah', startsAt: soon(), videoCall: true },
        await say(ASKED),
      );
      expect(res.summary).toMatch(/added a Google Meet link/);
    });

    it("an attached Gmail's calendar counts as Google-driven (ADR 0313)", async () => {
      await call('create_event', { title: 'Work sync', startsAt: soon() });
      await settleBackgroundWork();
      const ev = await db
        .selectFrom('events')
        .select('id')
        .where('owner_user_id', '=', userId)
        .where('title', '=', 'Work sync')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('events')
        .set({ google_calendar_id: 'gacct:acct_2:primary' })
        .where('id', '=', ev.id)
        .execute();
      expect(await eventVideoCallOption(db, ev.id)).toBe('google_meet');
    });
  });

  describe('a mailbox with no calendar of its own (IMAP)', () => {
    it('has no option and is told why when asked', async () => {
      // No calendar scope: nothing of Chord's reaches a provider.
      await db.updateTable('users').set({ refresh_token_scopes: null }).where('id', '=', userId).execute();
      const res = await call(
        'create_event',
        { title: 'Chat with Sarah', startsAt: soon(), videoCall: true },
        await say('@Chord add a video call to the chat with Sarah'),
      );
      expect(conferencePatches()).toEqual([]);
      expect(res.summary).toMatch(/NO video call link was added/);
      expect(res.summary).toMatch(/not on a connected calendar/);
    });

    it('an unasked videoCall there adds nothing and says nothing', async () => {
      await db.updateTable('users').set({ refresh_token_scopes: null }).where('id', '=', userId).execute();
      const res = await call(
        'create_event',
        { title: 'Chat with Sarah', startsAt: soon(), videoCall: true },
        await say(MEETING),
      );
      expect(conferencePatches()).toEqual([]);
      expect(res.summary).not.toMatch(/Google Meet|video call/i);
    });
  });

  it('with no message to read (ingest, a confirmed proposal), videoCall is taken as given', async () => {
    const res = await call('create_event', { title: 'Scripted', startsAt: soon(), videoCall: true });
    expect(res.summary).toMatch(/added a Google Meet link/);
  });

  describe('eventVideoCallOption', () => {
    it('is the Meet on a Google calendar and nothing on a 365 one', async () => {
      await call('create_event', { title: 'Option check', startsAt: soon() });
      await settleBackgroundWork();
      const ev = await db
        .selectFrom('events')
        .select('id')
        .where('owner_user_id', '=', userId)
        .where('title', '=', 'Option check')
        .executeTakeFirstOrThrow();
      expect(await eventVideoCallOption(db, ev.id)).toBe('google_meet');

      await moveToOutlook('Option check');
      expect(await eventVideoCallOption(db, ev.id)).toBeNull();
    });

    it('is nothing for an event mirrored from a phone', async () => {
      await call('create_event', { title: 'Phone event', startsAt: soon() });
      await settleBackgroundWork();
      const ev = await db
        .selectFrom('events')
        .select('id')
        .where('owner_user_id', '=', userId)
        .where('title', '=', 'Phone event')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('events')
        .set({ google_calendar_id: null, gcal_event_id: null, external_uid: 'device:CAL-1:evt-1' })
        .where('id', '=', ev.id)
        .execute();
      expect(await eventVideoCallOption(db, ev.id)).toBeNull();
    });
  });
});
