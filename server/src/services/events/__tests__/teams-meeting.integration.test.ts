/**
 * ADR 0323 — a Teams meeting on an Outlook / Microsoft 365 calendar.
 *
 * ADR 0319 gave a 365 calendar no video call at all, because Chord could only
 * make a Google Meet. Owner, 2026-11-05: "outlook: → none; could be Microsoft
 * Teams." Graph takes `isOnlineMeeting` + `onlineMeetingProvider` on the event
 * and initializes the read-only `onlineMeeting` whose `joinUrl` is the link.
 *
 * Microsoft Graph is mocked at the fetch boundary, as every other Outlook test
 * in this repo does; the calendar pre-check, the write, the verification, the
 * kernel rule and every DB write are real. Nothing here has round-tripped
 * against a live Microsoft tenant.
 *
 * The failure paths are the ones that matter most, and are the reason this is
 * a capability rather than a flag: a personal Outlook account has no Teams for
 * Business, an unlicensed tenant refuses, and Graph is reported to accept the
 * write and silently do nothing — which must read as a refusal and never as a
 * link (ADR 0102/0137).
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/email-accounts/outlook-oauth.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getOutlookAccessToken: vi.fn(async () => 'outlook-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { addVideoCall, eventVideoCallOption } from '@/services/events/guests.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetOutlookCalendarTokens } from '@/services/outlook-calendar/accounts.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { newId } from '@/utils/ids.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

const GRAPH_EVENT_ID = 'AAMkADGraphEvent';
const JOIN_URL =
  'https://teams.microsoft.com/l/meetup-join/19%3ameeting_ODkyNWFmNGY%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d';

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('a Teams meeting on an Outlook calendar (ADR 0323)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let accountId: string;
  let CAL: string;
  let calls: Call[];
  const savedFlag = env.OUTLOOK_CALENDAR_ENABLED;

  /**
   * The Graph calls this feature makes, as Microsoft documents them:
   * the calendar's allowed providers, the event, and the PATCH.
   *
   * @param allowed what `allowedOnlineMeetingProviders` lists on the calendar
   * @param onPatch what Graph answers the PATCH with
   */
  const stubGraph = (
    allowed: string[] | undefined,
    onPatch: () => Response = () =>
      res({ id: GRAPH_EVENT_ID, '@odata.etag': 'W/"2"', onlineMeeting: { joinUrl: JOIN_URL } }),
    stored: Record<string, unknown> = {},
  ): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const call: Call = {
          url: String(url),
          method: init?.method ?? 'GET',
          body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        };
        calls.push(call);
        if (call.url.includes('/me/calendars/') && call.url.includes('allowedOnlineMeetingProviders')) {
          return allowed === undefined
            ? res({ error: 'forbidden' }, 403)
            : res({ id: 'CAL1', allowedOnlineMeetingProviders: allowed });
        }
        if (call.url.includes('/me/events/') && call.method === 'PATCH') return onPatch();
        if (call.url.includes('/me/events/')) {
          return res({
            id: GRAPH_EVENT_ID,
            '@odata.etag': 'W/"1"',
            subject: 'Sync with Sarah',
            isOrganizer: true,
            ...stored,
          });
        }
        return res({});
      }),
    );
  };

  const providerCheck = () => calls.filter((c) => c.url.includes('allowedOnlineMeetingProviders'));
  const patches = () => calls.filter((c) => c.method === 'PATCH');

  const seedOutlookEvent = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = newId('e');
    const now = new Date().toISOString();
    const starts = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 19);
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        group_ids: JSON.stringify([groupId]),
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Sync with Sarah',
        starts_at: `${starts}Z`,
        created_at: now,
        updated_at: now,
        created_by: userId,
        status: 'confirmed',
        sequence: 0,
        local_dirty: 0,
        // Already on the 365 calendar, as a pushed event is.
        google_calendar_id: CAL,
        gcal_event_id: GRAPH_EVENT_ID,
        ...over,
      })
      .execute();
    return id;
  };

  beforeEach(async () => {
    (env as { OUTLOOK_CALENDAR_ENABLED: boolean }).OUTLOOK_CALENDAR_ENABLED = true;
    __resetOutlookCalendarTokens();
    calls = [];
    db = await openTestDb();
    userId = await createUser(db, 'threesixtyfive');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    accountId = newId('ema');
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({
        id: accountId,
        user_id: userId,
        provider: 'outlook',
        email_address: 'me@contoso.example',
        display_name: 'Me',
        preset_key: null,
        auth_ciphertext: null,
        auth_iv: null,
        auth_tag: null,
        sync_cursor: null,
        synced_at: null,
        status: 'ok',
        calendar_enabled: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    CAL = outlookCalendarKey(accountId, 'CAL1');
    await db
      .updateTable('email_accounts')
      .set({ calendar_default_id: CAL })
      .where('id', '=', accountId)
      .execute();
  });

  afterEach(async () => {
    (env as { OUTLOOK_CALENDAR_ENABLED: boolean }).OUTLOOK_CALENDAR_ENABLED = savedFlag;
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  describe('the write', () => {
    it('sets the two fields Graph takes and hands back the join link', async () => {
      stubGraph(['teamsForBusiness', 'skypeForBusiness']);
      const eventId = await seedOutlookEvent();

      const r = await addVideoCall(db, { eventId, actorUserId: userId });

      expect(r).toMatchObject({ ok: true, kind: 'teams', link: JOIN_URL, already: false });
      // Exactly the body Microsoft documents: `onlineMeeting` is read-only
      // and is Graph's to initialize, so it is never sent.
      expect(patches()).toHaveLength(1);
      expect(patches()[0]!.body).toEqual({
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
      });
      // Never Google's conference request on a 365 event.
      expect(patches()[0]!.body).not.toHaveProperty('conferenceData');
    });

    it('asks the calendar before it writes, which is Microsoft’s own test', async () => {
      stubGraph(['teamsForBusiness']);
      const eventId = await seedOutlookEvent();

      await addVideoCall(db, { eventId, actorUserId: userId });

      expect(providerCheck()).toHaveLength(1);
      const checkedAt = calls.indexOf(providerCheck()[0]!);
      expect(checkedAt).toBeLessThan(calls.indexOf(patches()[0]!));
    });

    it('answers an event that already has one with the link it has, writing nothing', async () => {
      // Graph will not let a Teams meeting be changed or turned off once set.
      stubGraph(['teamsForBusiness'], undefined, {
        isOnlineMeeting: true,
        onlineMeetingProvider: 'teamsForBusiness',
        onlineMeeting: { joinUrl: JOIN_URL },
      });
      const eventId = await seedOutlookEvent();

      const r = await addVideoCall(db, { eventId, actorUserId: userId });

      expect(r).toMatchObject({ ok: true, kind: 'teams', link: JOIN_URL, already: true });
      expect(patches()).toEqual([]);
    });
  });

  describe('when the calendar cannot host one', () => {
    it('a personal Outlook account is refused, and nothing is written', async () => {
      // A consumer account has no Teams for Business.
      stubGraph(['skypeForConsumer']);
      const eventId = await seedOutlookEvent();

      const r = await addVideoCall(db, { eventId, actorUserId: userId });

      expect(r).toEqual({ ok: false, reason: 'teams_unavailable' });
      expect(patches()).toEqual([]);
    });

    it('a calendar listing no provider at all is refused', async () => {
      stubGraph([]);
      const r = await addVideoCall(db, { eventId: await seedOutlookEvent(), actorUserId: userId });
      expect(r).toEqual({ ok: false, reason: 'teams_unavailable' });
      expect(patches()).toEqual([]);
    });

    it('a calendar that cannot be read is not taken as a yes', async () => {
      stubGraph(undefined);
      const r = await addVideoCall(db, { eventId: await seedOutlookEvent(), actorUserId: userId });
      expect(r).toEqual({ ok: false, reason: 'provider_error' });
      expect(patches()).toEqual([]);
    });

    it('an accepted write that did nothing is a refusal, never a claimed link', async () => {
      // Graph answers 200 with the provider still unknown: accepted, and the
      // meeting does not exist. The ADR 0137 shape.
      stubGraph(['teamsForBusiness'], () =>
        res({ id: GRAPH_EVENT_ID, '@odata.etag': 'W/"2"', isOnlineMeeting: false, onlineMeetingProvider: 'unknown' }),
      );
      const eventId = await seedOutlookEvent();

      const r = await addVideoCall(db, { eventId, actorUserId: userId });

      expect(r).toEqual({ ok: false, reason: 'teams_unavailable' });
      expect(r).not.toHaveProperty('link');
    });

    it('a refused write is reported as the provider failing', async () => {
      stubGraph(['teamsForBusiness'], () => res({ error: { code: 'ErrorAccessDenied' } }, 403));
      const r = await addVideoCall(db, { eventId: await seedOutlookEvent(), actorUserId: userId });
      expect(r).toEqual({ ok: false, reason: 'provider_error' });
    });
  });

  describe('eventVideoCallOption', () => {
    it('is the Teams meeting for an event on a connected Outlook calendar', async () => {
      stubGraph(['teamsForBusiness']);
      expect(await eventVideoCallOption(db, await seedOutlookEvent())).toBe('teams');
    });

    it('asks no provider, so an event open costs no Graph round trip (ADR 0204)', async () => {
      stubGraph(['teamsForBusiness']);
      await eventVideoCallOption(db, await seedOutlookEvent());
      expect(calls).toEqual([]);
    });

    it('is nothing once that mailbox is gone: the key names a provider, the connection makes it real', async () => {
      stubGraph(['teamsForBusiness']);
      const eventId = await seedOutlookEvent();
      await db.deleteFrom('email_accounts').where('id', '=', accountId).execute();
      expect(await eventVideoCallOption(db, eventId)).toBeNull();
    });
  });

  describe('through the bot', () => {
    const say = async (body: string): Promise<string> =>
      (await insertMessage(db, { groupId, senderId: userId, body })).id;

    const update = (args: Record<string, unknown>, triggeringMessageId: string) =>
      applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        mode: 'commit',
        tzOffset: '+00:00',
        call: { name: 'update_event', args } as never,
        triggeringMessageId,
      });

    it('an explicit ask adds it and the reply names Teams, not Meet', async () => {
      stubGraph(['teamsForBusiness']);
      await seedOutlookEvent();

      const res = await update(
        { titleContains: 'Sync with Sarah', videoCall: true },
        await say('@Chord add a video call to the sync with Sarah'),
      );

      expect(res.summary).toMatch(/added a Teams meeting link/);
      expect(res.summary).toContain(JOIN_URL);
      expect(res.summary).not.toMatch(/Google Meet/);
    });

    // ADR 0319's rule, now with something on the other side of it: the
    // default follows the calendar's provider, so a 365 calendar gets Teams.
    it('a videoCall nobody asked for still adds it, as a Google calendar gets its Meet', async () => {
      stubGraph(['teamsForBusiness']);
      await seedOutlookEvent();

      const res = await update(
        { titleContains: 'Sync with Sarah', location: 'Office', videoCall: true },
        await say('@Chord set up a meeting with Sarah tomorrow at 3pm'),
      );

      expect(res.summary).toMatch(/added a Teams meeting link/);
      expect(patches().some((p) => p.body?.isOnlineMeeting === true)).toBe(true);
    });

    it('an unasked one on a calendar that refuses says nothing at all', async () => {
      // An unlicensed tenant. Reporting this would be a complaint about a
      // meeting nobody asked for — the noise ADR 0319 removed.
      stubGraph([]);
      await seedOutlookEvent();

      const res = await update(
        { titleContains: 'Sync with Sarah', location: 'Office', videoCall: true },
        await say('@Chord set up a meeting with Sarah tomorrow at 3pm'),
      );

      expect(res.data).toMatchObject({ updated: true });
      expect(res.summary).not.toMatch(/Teams|Google Meet|video call/i);
    });

    it('an explicit ask on a calendar that refuses is told why, naming Teams', async () => {
      stubGraph([]);
      await seedOutlookEvent();

      const res = await update(
        { titleContains: 'Sync with Sarah', videoCall: true },
        await say('@Chord add a teams meeting to the sync'),
      );

      expect(res.summary).toMatch(/NO video call link was added/);
      expect(res.summary).toMatch(/does not offer Teams meetings/);
      // It must not offer the thing Chord cannot put there instead.
      expect(res.summary).toMatch(/do NOT offer a Google Meet instead/);
    });
    // Prod, 2026-11-11: "add to Neural Calendar - Call with Gautam @ A91 at
    // 830a. Teams meeting." The model sent no `calendar` and put "Teams
    // meeting" in `location` with no `videoCall`; the calendar is the Outlook
    // mailbox at the neural domain, which Settings shows only as "Outlook".
    it('the prod message: the mailbox named in words, and the Teams meeting asked for in words', async () => {
      await db
        .updateTable('email_accounts')
        .set({ email_address: 'john@neural.example' })
        .where('id', '=', accountId)
        .execute();
      const now = new Date().toISOString();
      await db
        .insertInto('calendar_sources')
        .values({
          id: newId('cs'),
          user_id: userId,
          provider: 'outlook',
          google_calendar_id: CAL,
          summary: 'Calendar',
          access_role: 'owner',
          is_primary: 0,
          selected_in_google: 1,
          counts_for_busy_auto: 1,
          first_seen_at: now,
          last_seen_at: now,
        })
        .execute();
      stubGraph(['teamsForBusiness']);
      const inner = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init?: RequestInit) => {
          if ((init?.method ?? 'GET') === 'POST' && /\/events(\?|$)/.test(String(url))) {
            calls.push({ url: String(url), method: 'POST', body: null });
            return res({ id: GRAPH_EVENT_ID, '@odata.etag': 'W/"1"', iCalUId: 'uid-1' });
          }
          return inner(url, init);
        }),
      );
      const starts = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

      const out = await applyToolCall(db, {
        groupId,
        actorUserId: userId,
        provenance: null,
        mode: 'commit',
        turnId: 'turn-1',
        tzOffset: '-05:00',
        call: {
          name: 'create_event',
          args: { title: 'Call with Gautam @ A91', startsAt: `${starts}T08:30:00-05:00`, location: 'Teams meeting' },
        } as never,
        triggeringMessageId: await say('add to Neural Calendar - Call with Gautam @ A91 at 830a. Teams meeting.'),
      });

      const row = await db
        .selectFrom('events')
        .select('google_calendar_id')
        .where('title', '=', 'Call with Gautam @ A91')
        .executeTakeFirstOrThrow();
      expect(row.google_calendar_id).toBe(CAL);
      expect(out.summary).toMatch(/Teams meeting/);
      expect(out.summary).not.toMatch(/Google Meet/);
      expect(patches().some((p) => p.body?.isOnlineMeeting === true)).toBe(true);
    });
  });
});
