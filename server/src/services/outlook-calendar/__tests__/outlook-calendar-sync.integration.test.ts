/**
 * ADR 0228 — two-way Outlook calendar sync, end to end against a real
 * database. Microsoft Graph and Google are mocked at the fetch boundary and
 * the two access-token calls; the sync engine, the reconcile rules and every
 * DB write are real.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tokens = vi.hoisted(() => ({ googleFails: false }));

vi.mock('@/services/google/oauth.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => {
    if (tokens.googleFails) throw new Error('google token dead');
    return 'google-token';
  }),
}));
vi.mock('@/services/email-accounts/outlook-oauth.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getOutlookAccessToken: vi.fn(async () => 'outlook-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import {
  calendarLabel,
  eventBlocksTime,
  loadBusyContext,
  matchCalendarsByName,
  resolveTargetCalendarId,
  upsertCalendarSource,
} from '@/services/calendar-sources.service.js';
import { disconnectAccount } from '@/services/email-accounts/accounts.service.js';
import { sweepCalendars } from '@/services/google/calendar-sweep.js';
import { respondToInvite } from '@/services/google/rsvp.service.js';
import {
  pullCalendarChanges,
  pushDirtyEvents,
  syncTwoWay,
} from '@/services/google/two-way-sync.service.js';
import { createGroup } from '@/services/groups.service.js';
import { __resetOutlookCalendarTokens, calendarConnection } from '@/services/outlook-calendar/accounts.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const GOOGLE_WRITE = 'https://www.googleapis.com/auth/calendar';
const NY = 'America/New_York';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

/** Stub fetch with a handler; returns the calls made, in order. */
function stubFetch(handler: (c: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      calls.push(call);
      return handler(call) ?? res({});
    }),
  );
  return calls;
}

const isGraph = (c: Call) => c.url.startsWith('https://graph.microsoft.com/');
const isGoogle = (c: Call) => c.url.startsWith('https://www.googleapis.com/');

const inDays = (n: number, time = '15:00:00'): string =>
  `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${time}`;

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let accountId: string;
let CAL: string;
const savedFlag = env.OUTLOOK_CALENDAR_ENABLED;
const setFlag = (on: boolean): void => {
  (env as { OUTLOOK_CALENDAR_ENABLED: boolean }).OUTLOOK_CALENDAR_ENABLED = on;
};

async function seedAccount(over: Record<string, unknown> = {}): Promise<string> {
  const id = newId('ema');
  const now = new Date().toISOString();
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider: 'outlook',
      email_address: 'me@outlook.example',
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
      ...over,
    })
    .execute();
  return id;
}

async function seedSource(key: string, summary: string, role: 'owner' | 'writer' | 'reader' = 'owner') {
  await upsertCalendarSource(db, userId, {
    provider: 'outlook',
    googleCalendarId: key,
    summary,
    accessRole: role,
    isPrimary: false,
    selectedInGoogle: true,
    isChordTarget: false,
  });
}

async function seedEvent(over: Record<string, unknown>): Promise<string> {
  const id = (over.id as string) ?? newId('e');
  const now = new Date().toISOString();
  await db
    .insertInto('events')
    .values({
      id,
      group_id: groupId,
      group_ids: JSON.stringify([groupId]),
      owner_user_id: userId,
      organizer_user_id: userId,
      role: 'organizer',
      title: 'Seed',
      starts_at: `${inDays(2)}Z`,
      created_at: now,
      updated_at: now,
      created_by: userId,
      status: 'confirmed',
      sequence: 0,
      local_dirty: 0,
      ...over,
    })
    .execute();
  return id;
}

const eventRow = (id: string) =>
  db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirst();

const allEvents = () =>
  db.selectFrom('events').selectAll().where('owner_user_id', '=', userId).orderBy('starts_at').execute();

const setGoogleScope = (scopes: string | null) =>
  db.updateTable('users').set({ refresh_token_scopes: scopes }).where('id', '=', userId).execute();

beforeEach(async () => {
  setFlag(true);
  (env as { CALENDAR_SWEEP_ENABLED: boolean }).CALENDAR_SWEEP_ENABLED = true;
  tokens.googleFails = false;
  __resetOutlookCalendarTokens();
  db = await openTestDb();
  userId = await createUser(db, 'outlooker');
  await db.updateTable('users').set({ last_tz: NY }).where('id', '=', userId).execute();
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
  accountId = await seedAccount();
  CAL = outlookCalendarKey(accountId, 'CAL1');
  await db.updateTable('email_accounts').set({ calendar_default_id: CAL }).where('id', '=', accountId).execute();
  await seedSource(CAL, 'Calendar');
});

afterEach(async () => {
  setFlag(savedFlag);
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

describe('pushing to Outlook', () => {
  it('creates an event on the Outlook calendar it belongs to', async () => {
    const calls = stubFetch((c) =>
      c.method === 'POST' ? res({ id: 'O-NEW', '@odata.etag': 'W/"1"', iCalUId: 'uid-outlook' }, 201) : undefined,
    );
    const id = await seedEvent({
      title: 'Recital',
      location: 'Hall',
      starts_at: `${inDays(3, '18:00:00')}-04:00`,
      ends_at: `${inDays(3, '19:00:00')}-04:00`,
      google_calendar_id: CAL,
      local_dirty: 1,
    });

    const result = await pushDirtyEvents(db, userId);
    expect(result).toMatchObject({ created: 1, errored: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/calendars/CAL1/events');
    expect(calls[0]!.headers.authorization).toBe('Bearer outlook-token');
    expect(calls[0]!.headers.Prefer).toContain('IdType="ImmutableId"');
    expect(calls[0]!.body).toMatchObject({
      subject: 'Recital',
      location: { displayName: 'Hall' },
      isAllDay: false,
      showAs: 'busy',
      start: { dateTime: `${inDays(3, '22:00:00')}`, timeZone: 'UTC' },
    });
    expect(String(calls[0]!.body!.transactionId)).toMatch(/^ce_/);

    const row = await eventRow(id);
    expect(row).toMatchObject({
      gcal_event_id: 'O-NEW',
      etag: 'W/"1"',
      ical_uid: 'uid-outlook',
      google_calendar_id: CAL,
      gcal_sync_status: 'synced',
      local_dirty: 0,
    });
    expect(row!.chord_uid).toBe(calls[0]!.body!.transactionId);
  });

  it('sends an event with no calendar to Outlook when there is no Google calendar', async () => {
    const calls = stubFetch((c) => (c.method === 'POST' ? res({ id: 'O-1' }, 201) : undefined));
    const id = await seedEvent({ google_calendar_id: null, local_dirty: 1 });

    expect((await pushDirtyEvents(db, userId)).created).toBe(1);
    expect(calls.filter(isGoogle)).toEqual([]);
    expect(calls[0]!.url).toContain('/me/calendars/CAL1/events');
    expect((await eventRow(id))!.google_calendar_id).toBe(CAL);
  });

  it('keeps sending an event with no calendar to Google when Google is connected', async () => {
    await setGoogleScope(GOOGLE_WRITE);
    const calls = stubFetch((c) => (c.method === 'POST' ? res({ id: 'g-1', iCalUID: 'g-uid' }) : undefined));
    const id = await seedEvent({ google_calendar_id: null, local_dirty: 1 });

    expect((await pushDirtyEvents(db, userId)).created).toBe(1);
    expect(calls.filter(isGraph)).toEqual([]);
    expect(calls[0]!.url).toContain('/calendars/primary/events');
    expect((await eventRow(id))!.google_calendar_id).toBe('primary');
  });

  it('sends each event to its own provider in one pass', async () => {
    await setGoogleScope(GOOGLE_WRITE);
    const calls = stubFetch((c) => {
      if (c.method !== 'POST') return undefined;
      return isGraph(c) ? res({ id: 'O-1' }, 201) : res({ id: 'g-1' });
    });
    const onOutlook = await seedEvent({ google_calendar_id: CAL, local_dirty: 1 });
    const onGoogle = await seedEvent({ google_calendar_id: 'primary', local_dirty: 1 });

    expect((await pushDirtyEvents(db, userId)).created).toBe(2);
    expect(calls.filter(isGraph)).toHaveLength(1);
    expect(calls.filter(isGoogle)).toHaveLength(1);
    expect((await eventRow(onOutlook))!.gcal_event_id).toBe('O-1');
    expect((await eventRow(onGoogle))!.gcal_event_id).toBe('g-1');
  });

  it('leaves an event queued when its mailbox has no calendar access', async () => {
    await db.updateTable('email_accounts').set({ calendar_enabled: 0 }).where('id', '=', accountId).execute();
    await setGoogleScope(GOOGLE_WRITE);
    const calls = stubFetch(() => undefined);
    const id = await seedEvent({ google_calendar_id: CAL, local_dirty: 1 });

    const result = await pushDirtyEvents(db, userId);
    expect(result).toMatchObject({ created: 0, errored: 0 });
    expect(calls).toEqual([]);
    // Still waiting, and not marked as a failure.
    expect(await eventRow(id)).toMatchObject({ local_dirty: 1, gcal_event_id: null });
  });

  it('still pushes to Outlook when the Google token is dead, then reports that', async () => {
    await setGoogleScope(GOOGLE_WRITE);
    tokens.googleFails = true;
    stubFetch((c) => (c.method === 'POST' && isGraph(c) ? res({ id: 'O-1' }, 201) : undefined));
    const onOutlook = await seedEvent({ google_calendar_id: CAL, local_dirty: 1 });
    const onGoogle = await seedEvent({ google_calendar_id: 'primary', local_dirty: 1 });

    await expect(pushDirtyEvents(db, userId)).rejects.toThrow('google token dead');
    expect((await eventRow(onOutlook))!.gcal_event_id).toBe('O-1');
    // The Google row is back in the queue for after a reconnect.
    expect(await eventRow(onGoogle)).toMatchObject({ local_dirty: 1, gcal_event_id: null });
  });

  it('edits and deletes by event id, with no etag condition', async () => {
    const calls = stubFetch((c) => (c.method === 'PATCH' ? res({ id: 'O-9', '@odata.etag': 'W/"2"' }) : undefined));
    const edited = await seedEvent({
      title: 'Moved',
      google_calendar_id: CAL,
      gcal_event_id: 'O-9',
      etag: 'W/"1"',
      chord_uid: 'ce_x',
      local_dirty: 1,
    });
    const removed = await seedEvent({
      google_calendar_id: CAL,
      gcal_event_id: 'O-8',
      status: 'cancelled',
      deleted_at: new Date().toISOString(),
      local_dirty: 1,
    });

    const result = await pushDirtyEvents(db, userId);
    expect(result).toMatchObject({ updated: 1, deleted: 1, errored: 0 });

    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://graph.microsoft.com/v1.0/me/events/O-9');
    expect(patch.headers['if-match']).toBeUndefined();
    expect(patch.body!.subject).toBe('Moved');
    // An edit must not flatten the user's own "show as" in Outlook.
    expect(patch.body!.showAs).toBeUndefined();
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('https://graph.microsoft.com/v1.0/me/events/O-8');

    expect(await eventRow(edited)).toMatchObject({ etag: 'W/"2"', local_dirty: 0 });
    expect(await eventRow(removed)).toBeUndefined();
  });

  it('gives up on an event Outlook rejects, and says why', async () => {
    stubFetch((c) => (c.method === 'POST' ? res({ error: { message: 'bad time range' } }, 400) : undefined));
    const id = await seedEvent({ google_calendar_id: CAL, local_dirty: 1 });

    expect((await pushDirtyEvents(db, userId)).errored).toBe(1);
    const row = await eventRow(id);
    expect(row).toMatchObject({ local_dirty: 0, gcal_sync_status: 'error' });
    expect(row!.gcal_last_error).toContain('outlook events.insert 400');
    expect(row!.gcal_last_error).toContain('bad time range');
  });
});

describe('pulling from Outlook', () => {
  const graphEvent = (id: string, subject: string, day: number, extra: Record<string, unknown> = {}) => ({
    id,
    '@odata.etag': `W/"${id}"`,
    iCalUId: `uid-${id}`,
    subject,
    type: 'singleInstance',
    isAllDay: false,
    showAs: 'busy',
    start: { dateTime: `${inDays(day, '19:30:00')}.0000000`, timeZone: 'UTC' },
    end: { dateTime: `${inDays(day, '20:30:00')}.0000000`, timeZone: 'UTC' },
    lastModifiedDateTime: new Date().toISOString(),
    ...extra,
  });

  const DELTA = 'https://graph.microsoft.com/v1.0/me/calendars/CAL1/calendarView/delta?$deltatoken=d1';

  it('stores each event in the reader zone and saves the cursor', async () => {
    const calls = stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({ value: [graphEvent('A', 'Dentist', 2), graphEvent('B', 'Swim', 4)], '@odata.deltaLink': DELTA })
        : undefined,
    );

    const result = await pullCalendarChanges(db, userId, CAL);
    expect(result).toMatchObject({ inserted: 2, failed: 0 });

    // The first listing asks for the same window the engine reverse-deletes in.
    expect(calls[0]!.url).toContain('/me/calendars/CAL1/calendarView/delta?startDateTime=');
    expect(calls[0]!.headers.Prefer).toContain('outlook.timezone="UTC"');

    const rows = await allEvents();
    expect(rows.map((r) => r.title)).toEqual(['Dentist', 'Swim']);
    const dentist = rows[0]!;
    expect(dentist).toMatchObject({
      gcal_event_id: 'A',
      ical_uid: 'uid-A',
      google_calendar_id: CAL,
      start_tz: NY,
      role: 'attendee',
      local_dirty: 0,
      group_ids: [],
    });
    // 19:30Z shown on the New York wall clock, as an offset time.
    expect(dentist.starts_at).toMatch(/T1[45]:30:00-0[45]:00$/);
    expect(Date.parse(dentist.starts_at)).toBe(Date.parse(`${inDays(2, '19:30:00')}Z`));

    const source = await db
      .selectFrom('calendar_sources')
      .select('sync_token')
      .where('google_calendar_id', '=', CAL)
      .executeTakeFirstOrThrow();
    expect(JSON.parse(source.sync_token!)).toMatchObject({ link: DELTA });
  });

  it('continues from the saved cursor, and a removal there deletes the event', async () => {
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({ value: [graphEvent('A', 'Dentist', 2)], '@odata.deltaLink': DELTA })
        : undefined,
    );
    await pullCalendarChanges(db, userId, CAL);

    const calls = stubFetch((c) =>
      c.url === DELTA
        ? res({ value: [{ id: 'A', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA}2` })
        : undefined,
    );
    const result = await pullCalendarChanges(db, userId, CAL);
    expect(calls[0]!.url).toBe(DELTA);
    expect(result.deleted).toBe(1);
    expect(await allEvents()).toEqual([]);
  });

  it('applies an Outlook edit to an event Chord has edited before', async () => {
    // An organizer edit in Chord bumps `sequence`; Outlook has none to send.
    // Read as zero, the Outlook copy would look older than ours forever and
    // nothing changed in Outlook would ever reach Chord again.
    const id = await seedEvent({
      title: 'Lunch',
      google_calendar_id: CAL,
      gcal_event_id: 'A',
      sequence: 3,
      updated_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({ value: [graphEvent('A', 'Lunch at Nopa', 2)], '@odata.deltaLink': DELTA })
        : undefined,
    );

    const result = await pullCalendarChanges(db, userId, CAL);
    expect(result.applied).toBe(1);
    const row = await eventRow(id);
    expect(row!.title).toBe('Lunch at Nopa');
    // Our own version counter is left alone.
    expect(row!.sequence).toBe(3);
  });

  // Prod 2026-11-19, "Follow up: Neural Ads/ Post Oak Group": the delta gave
  // only Graph's 255-character bodyPreview, so the description stopped at
  // "…or smartphone. https://cale".
  it('reads the full body when the delta gives only a cut-off preview', async () => {
    const preview =
      'Join with Google Meet – Event Details: Invitee: John Doe Invitee Email: john@neuralads.ai ' +
      'Location: This is a Google Meet web conference. You can join this meeting from your computer, ' +
      'tablet, or smartphone. https://cale';
    const full = `${preview}ndar.google.com/calendar/event?eid=abc\n\nJoin with Google Meet\nhttps://meet.google.com/eex-vixv-cmh`;
    const calls = stubFetch((c) => {
      if (c.url.includes('/calendarView/delta')) {
        return res({
          value: [
            graphEvent('A', 'Follow up: Neural Ads/ Post Oak Group', 2, { body: undefined, bodyPreview: preview }),
            graphEvent('B', 'Short', 3, { body: undefined, bodyPreview: 'Bring snacks' }),
            graphEvent('C', 'Html', 4, {
              body: { contentType: 'html', content: '<p>Agenda</p><p style="display:none">hidden</p><p>Budget</p>' },
              bodyPreview: 'Agenda Budget',
            }),
          ],
          '@odata.deltaLink': DELTA,
        });
      }
      if (c.url.includes('/me/events/A?$select=body')) return res({ body: { contentType: 'text', content: full } });
      return undefined;
    });

    await pullCalendarChanges(db, userId, CAL);
    const byTitle = new Map((await allEvents()).map((r) => [r.title, r.description]));
    expect(byTitle.get('Follow up: Neural Ads/ Post Oak Group')).toBe(full);
    // A short preview is the whole body: nothing more is fetched for it.
    expect(byTitle.get('Short')).toBe('Bring snacks');
    expect(calls.filter((c) => c.url.includes('$select=body')).map((c) => c.url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/events/A?$select=body',
    ]);
    // An HTML body is read as visible text, not stored as markup.
    expect(byTitle.get('Html')).toMatch(/^Agenda\s+Budget$/);
  });

  it('keeps a newer unsent Chord edit over an older Outlook copy', async () => {
    const id = await seedEvent({
      title: 'Chord title',
      google_calendar_id: CAL,
      gcal_event_id: 'A',
      local_dirty: 1,
      updated_at: new Date(Date.now() + 60_000).toISOString(),
    });
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({
            value: [graphEvent('A', 'Outlook title', 2, { lastModifiedDateTime: new Date(Date.now() - 60_000).toISOString() })],
            '@odata.deltaLink': DELTA,
          })
        : undefined,
    );

    expect((await pullCalendarChanges(db, userId, CAL)).pushBack).toBe(1);
    expect(await eventRow(id)).toMatchObject({ title: 'Chord title', local_dirty: 1 });
  });

  it('keeps one row per occurrence of a series, and removes them with it', async () => {
    const master = {
      ...graphEvent('M', 'Standup', 1),
      type: 'seriesMaster',
      recurrence: { pattern: { type: 'weekly' }, range: { type: 'noEnd' } },
    };
    const occurrence = (id: string, day: number) => ({
      id,
      type: 'occurrence',
      seriesMasterId: 'M',
      start: { dateTime: `${inDays(day, '13:00:00')}.0000000`, timeZone: 'UTC' },
      end: { dateTime: `${inDays(day, '13:15:00')}.0000000`, timeZone: 'UTC' },
    });
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({ value: [master, occurrence('O1', 1), occurrence('O2', 8), occurrence('O3', 15)], '@odata.deltaLink': DELTA })
        : undefined,
    );

    expect((await pullCalendarChanges(db, userId, CAL)).inserted).toBe(3);
    const rows = await allEvents();
    expect(rows.map((r) => r.gcal_event_id)).toEqual(['O1', 'O2', 'O3']);
    expect(rows.every((r) => r.title === 'Standup' && r.recurring_event_id === 'M')).toBe(true);

    // The series is deleted in Outlook: one removal, for the master.
    stubFetch((c) =>
      c.url === DELTA
        ? res({ value: [{ id: 'M', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${DELTA}2` })
        : undefined,
    );
    expect((await pullCalendarChanges(db, userId, CAL)).deleted).toBe(3);
    expect(await allEvents()).toEqual([]);
  });

  it('removes an event a full listing no longer contains', async () => {
    const stale = await seedEvent({ title: 'Deleted in Outlook', google_calendar_id: CAL, gcal_event_id: 'GONE' });
    const kept = await seedEvent({ title: 'Still there', google_calendar_id: CAL, gcal_event_id: 'A' });
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({ value: [graphEvent('A', 'Still there', 2)], '@odata.deltaLink': DELTA })
        : undefined,
    );

    await pullCalendarChanges(db, userId, CAL);
    expect(await eventRow(stale)).toBeUndefined();
    expect(await eventRow(kept)).toBeDefined();
  });

  it('starts over when Outlook no longer knows the cursor', async () => {
    await db
      .updateTable('calendar_sources')
      .set({
        sync_token: JSON.stringify({ link: DELTA, at: new Date().toISOString() }),
        full_synced_at: new Date().toISOString(),
      })
      .where('google_calendar_id', '=', CAL)
      .execute();
    const calls = stubFetch((c) => {
      if (c.url === DELTA) return res({ error: { code: 'SyncStateNotFound' } }, 410);
      if (c.url.includes('/calendarView/delta?startDateTime=')) {
        return res({ value: [graphEvent('A', 'Dentist', 2)], '@odata.deltaLink': `${DELTA}2` });
      }
      return undefined;
    });

    expect((await pullCalendarChanges(db, userId, CAL)).inserted).toBe(1);
    expect(calls.map((c) => c.url.includes('startDateTime='))).toEqual([false, true]);
  });

  it('drops a declined meeting and the phone copy of an event it now holds', async () => {
    // The phone mirrored this Outlook event before the calendar was connected.
    const start = `${inDays(2, '19:30:00')}Z`;
    const phoneCopy = await seedEvent({
      title: 'dentist ',
      starts_at: start,
      external_uid: 'device:DEVCAL:evt1',
      ical_uid: 'something-else',
      group_ids: '[]',
    });
    const declined = await seedEvent({ title: 'Offsite', google_calendar_id: CAL, gcal_event_id: 'D' });
    stubFetch((c) =>
      c.url.includes('/calendarView/delta')
        ? res({
            value: [
              graphEvent('A', 'Dentist', 2),
              graphEvent('D', 'Offsite', 5, { responseStatus: { response: 'declined' } }),
            ],
            '@odata.deltaLink': DELTA,
          })
        : undefined,
    );

    await pullCalendarChanges(db, userId, CAL);
    expect(await eventRow(phoneCopy)).toBeUndefined();
    expect(await eventRow(declined)).toBeUndefined();
    const rows = await allEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: 'Dentist', gcal_event_id: 'A' });
  });
});

describe('a full sync pass', () => {
  const calendarsPage = {
    value: [
      { id: 'CAL1', name: 'Calendar', canEdit: true, isDefaultCalendar: true, hexColor: '#0078d4', owner: { address: 'me@outlook.example' } },
      { id: 'HOL', name: 'US Holidays', canEdit: false, owner: { address: 'me@outlook.example' } },
    ],
  };
  const emptyDelta = (c: Call) =>
    c.url.includes('/calendarView/delta') ? res({ value: [], '@odata.deltaLink': `${c.url}&done` }) : undefined;

  it('lists the mailbox calendars and judges which ones block time', async () => {
    await db.deleteFrom('calendar_sources').where('user_id', '=', userId).execute();
    await db.updateTable('email_accounts').set({ calendar_default_id: null }).where('id', '=', accountId).execute();
    stubFetch((c) => (c.url.includes('/me/calendars?') ? res(calendarsPage) : emptyDelta(c)));

    const result = await syncTwoWay(db, userId);
    expect(Object.keys(result.pull).sort()).toEqual([CAL, outlookCalendarKey(accountId, 'HOL')].sort());

    const sources = await db
      .selectFrom('calendar_sources')
      .selectAll()
      .where('user_id', '=', userId)
      .orderBy('summary')
      .execute();
    expect(sources.map((s) => [s.provider, s.summary, s.access_role, s.counts_for_busy_auto, s.is_primary])).toEqual([
      ['outlook', 'Calendar', 'owner', 1, 0],
      ['outlook', 'US Holidays', 'reader', 0, 0],
    ]);
    expect(sources[0]!.color).toBe('#0078d4');

    const account = await db
      .selectFrom('email_accounts')
      .select('calendar_default_id')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.calendar_default_id).toBe(CAL);

    // An event on the holiday calendar is informational; one on Calendar blocks.
    const ctx = await loadBusyContext(db, userId);
    expect(eventBlocksTime({ external_uid: null, google_calendar_id: CAL }, ctx)).toBe(true);
    expect(
      eventBlocksTime({ external_uid: null, google_calendar_id: outlookCalendarKey(accountId, 'HOL') }, ctx),
    ).toBe(false);
  });

  it('forgets a calendar the mailbox no longer has, with what was pulled from it', async () => {
    const OLD = outlookCalendarKey(accountId, 'OLD');
    await seedSource(OLD, 'Old team');
    const pulled = await seedEvent({ google_calendar_id: OLD, gcal_event_id: 'X', group_ids: '[]' });
    stubFetch((c) => (c.url.includes('/me/calendars?') ? res(calendarsPage) : emptyDelta(c)));

    await syncTwoWay(db, userId);
    expect(await eventRow(pulled)).toBeUndefined();
    expect(
      await db.selectFrom('calendar_sources').select('id').where('google_calendar_id', '=', OLD).execute(),
    ).toEqual([]);
  });

  it('syncs Outlook even when the Google token is dead, and still reports Google', async () => {
    await setGoogleScope(GOOGLE_WRITE);
    tokens.googleFails = true;
    stubFetch((c) => (c.url.includes('/me/calendars?') ? res(calendarsPage) : emptyDelta(c)));

    await expect(syncTwoWay(db, userId)).rejects.toThrow('google token dead');
    const sources = await db.selectFrom('calendar_sources').select('summary').where('user_id', '=', userId).execute();
    expect(sources.map((s) => s.summary).sort()).toEqual(['Calendar', 'US Holidays']);
  });

  it('does nothing for Outlook while the feature is off', async () => {
    setFlag(false);
    await setGoogleScope(GOOGLE_WRITE);
    const calls = stubFetch((c) => (isGoogle(c) && c.url.includes('calendarList') ? res({ items: [] }) : undefined));
    await seedEvent({ google_calendar_id: CAL, local_dirty: 1 });

    await syncTwoWay(db, userId);
    expect(calls.filter(isGraph)).toEqual([]);
  });

  it('the background sweep reaches a user whose only calendar is Outlook', async () => {
    stubFetch((c) => (c.url.includes('/me/calendars?') ? res(calendarsPage) : emptyDelta(c)));
    expect(await sweepCalendars(db)).toBe(1);
    const user = await db
      .selectFrom('users')
      .select('google_calendar_synced_at')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(user.google_calendar_synced_at).not.toBeNull();
    // Just synced: not due again.
    expect(await sweepCalendars(db)).toBe(0);
  });
});

describe('disconnecting the mailbox', () => {
  it('removes what came from Outlook and keeps what Chord made', async () => {
    const pulled = await seedEvent({ title: 'From Outlook', google_calendar_id: CAL, gcal_event_id: 'A', group_ids: '[]' });
    const ours = await seedEvent({
      title: 'Family dinner',
      google_calendar_id: CAL,
      gcal_event_id: 'B',
      chord_uid: 'ce_dinner',
      etag: 'W/"1"',
    });
    await db.updateTable('users').set({ default_calendar_id: CAL }).where('id', '=', userId).execute();

    expect(await disconnectAccount(db, userId, accountId)).toBe(true);

    expect(await eventRow(pulled)).toBeUndefined();
    expect(await eventRow(ours)).toMatchObject({
      title: 'Family dinner',
      google_calendar_id: null,
      gcal_event_id: null,
      etag: null,
    });
    expect(await db.selectFrom('calendar_sources').select('id').where('user_id', '=', userId).execute()).toEqual([]);
    const user = await db.selectFrom('users').select('default_calendar_id').where('id', '=', userId).executeTakeFirstOrThrow();
    expect(user.default_calendar_id).toBeNull();
  });
});

describe('choosing a calendar by name', () => {
  it('"outlook" means the mailbox default calendar', async () => {
    expect(await matchCalendarsByName(db, userId, 'Outlook')).toEqual({ calendarId: CAL });
    expect(await matchCalendarsByName(db, userId, 'my outlook calendar')).toEqual({ calendarId: CAL });
    expect(await calendarLabel(db, userId, CAL)).toBe('Calendar (Outlook)');
  });

  it('asks which mailbox when there are two', async () => {
    const second = await seedAccount({ email_address: 'work@contoso.example' });
    const workCal = outlookCalendarKey(second, 'W1');
    await db.updateTable('email_accounts').set({ calendar_default_id: workCal }).where('id', '=', second).execute();

    const match = await matchCalendarsByName(db, userId, 'outlook');
    expect(match.calendarId).toBeNull();
    expect(match.candidates!.map((c) => c.summary)).toEqual([
      'Outlook me@outlook.example',
      'Outlook work@contoso.example',
    ]);
    // Reading a candidate back resolves it.
    expect(await matchCalendarsByName(db, userId, 'Outlook work@contoso.example')).toEqual({ calendarId: workCal });
  });

  it('asks when Google and Outlook both have a calendar of that name, and a read-back resolves', async () => {
    const FAMILY = outlookCalendarKey(accountId, 'FAM');
    await seedSource(FAMILY, 'Family');
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'family@group.calendar.google.com',
      summary: 'Family',
      accessRole: 'owner',
      isPrimary: false,
      selectedInGoogle: true,
      isChordTarget: false,
    });

    const match = await matchCalendarsByName(db, userId, 'family');
    expect(match.calendarId).toBeNull();
    expect(match.candidates!.map((c) => c.summary).sort()).toEqual(['Family (Google)', 'Family (Outlook)']);
    expect(await matchCalendarsByName(db, userId, 'Family (Outlook)')).toEqual({ calendarId: FAMILY });
    expect(await matchCalendarsByName(db, userId, 'Family (Google)')).toEqual({
      calendarId: 'family@group.calendar.google.com',
    });
  });

  it('never offers a read-only Outlook calendar as a place to write', async () => {
    await seedSource(outlookCalendarKey(accountId, 'HOL'), 'US Holidays', 'reader');
    expect(await matchCalendarsByName(db, userId, 'US Holidays')).toEqual({ calendarId: null });
  });

  it('reports the Outlook calendar as the destination when there is no Google calendar', async () => {
    const pick = await resolveTargetCalendarId(db, { userId });
    expect(pick).toMatchObject({ calendarId: CAL, source: 'primary' });
    expect(await calendarConnection(db, userId, pick.calendarId)).toEqual({ provider: 'outlook', state: 'connected' });

    // With Google connected, `primary` keeps meaning the Google primary.
    await setGoogleScope(GOOGLE_WRITE);
    expect((await resolveTargetCalendarId(db, { userId })).calendarId).toBe('primary');
  });

  it('says so when the mailbox needs a reconnect', async () => {
    await db.updateTable('email_accounts').set({ status: 'reconnect' }).where('id', '=', accountId).execute();
    expect(await calendarConnection(db, userId, CAL)).toEqual({ provider: 'outlook', state: 'expired' });
  });
});

describe('answering an invitation that is on the Outlook calendar', () => {
  it('uses Outlook own answer call, which tells the organizer', async () => {
    tokens.googleFails = true; // no Google at all
    const calls = stubFetch((c) => {
      if (c.url.includes('/me/events?')) return res({ value: [{ id: 'INV1' }] });
      if (c.url.endsWith('/me/events/INV1/tentativelyAccept')) return res({}, 202);
      return undefined;
    });

    // ADR 0312 — the invitation came to the Outlook mailbox, so it answers.
    const result = await respondToInvite(db, userId, {
      icalUid: "uid-o'brien",
      response: 'tentative',
      provenance: `gmail:${accountId}:thread-1`,
    });
    expect(result).toEqual({ ok: true, via: 'calendar' });

    const lookup = new URL(calls[0]!.url);
    // The UID is quoted for OData, with its apostrophe doubled.
    expect(lookup.searchParams.get('$filter')).toBe("iCalUId eq 'uid-o''brien'");
    expect(calls[1]).toMatchObject({ method: 'POST', body: { sendResponse: true } });
  });

  it('reports no route when neither calendar holds it', async () => {
    tokens.googleFails = true;
    stubFetch((c) => (c.url.includes('/me/events?') ? res({ value: [] }) : undefined));
    expect(await respondToInvite(db, userId, { icalUid: 'nope', response: 'accepted' })).toEqual({
      ok: false,
      via: null,
      reason: 'no_google',
    });
  });
});
