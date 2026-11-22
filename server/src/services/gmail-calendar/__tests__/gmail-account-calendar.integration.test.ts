/**
 * ADR 0313 — an attached Gmail's calendar, end to end against a real
 * database. Google is mocked at the fetch boundary and the two token calls;
 * the point of every test is WHICH token reached WHICH calendar.
 */
import { randomBytes } from 'node:crypto';

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'login-token'),
  refreshAccessTokenWith: vi.fn(async (refreshToken: string) => `token-for-${refreshToken}`),
}));

import type { DB } from '@/db/schema.js';
import { busyCalendarIds, calendarLabel, upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { sealAuthBlob } from '@/services/email-accounts/account-utils.js';
import { disconnectAccount } from '@/services/email-accounts/accounts.service.js';
import { gmailAccountTransport, grantsGoogleCalendar } from '@/services/gmail-calendar/accounts.js';
import { gmailCalendarKey } from '@/services/gmail-calendar/ids.js';
import { respondToInvite } from '@/services/google/rsvp.service.js';
import { pushDirtyEvents, syncTwoWay } from '@/services/google/two-way-sync.service.js';
import { createGroup } from '@/services/groups.service.js';
import { calendarConnection } from '@/services/outlook-calendar/accounts.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const GOOGLE_WRITE = 'https://www.googleapis.com/auth/calendar';

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
  auth: string;
}

function stubFetch(handler: (c: Call) => Response | undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
        auth: headers.authorization ?? '',
      };
      calls.push(call);
      return handler(call) ?? res({});
    }),
  );
  return calls;
}

const inDays = (n: number, time = '15:00:00'): string =>
  `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${time}`;

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let accountId: string;
const ACCOUNT_TOKEN = 'Bearer token-for-second-refresh';

async function seedGmailAccount(over: Record<string, unknown> = {}): Promise<string> {
  const id = newId('ema');
  const now = new Date().toISOString();
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider: 'gmail',
      email_address: 'second@gmail.example',
      display_name: 'Second',
      preset_key: null,
      ...sealAuthBlob({ refreshToken: 'second-refresh', clientId: 'web' }),
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

async function seedEvent(over: Record<string, unknown>): Promise<string> {
  const id = newId('e');
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
      ends_at: `${inDays(2, '16:00:00')}Z`,
      created_at: now,
      updated_at: now,
      created_by: userId,
      status: 'confirmed',
      sequence: 0,
      local_dirty: 1,
      ...over,
    })
    .execute();
  return id;
}

const savedMasterKey = process.env.MASTER_KEY;

beforeEach(async () => {
  process.env.MASTER_KEY = randomBytes(32).toString('base64');
  db = await openTestDb();
  userId = await createUser(db, 'twogmails');
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
  accountId = await seedGmailAccount();
});

afterEach(async () => {
  await settleBackgroundWork();
  if (savedMasterKey === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedMasterKey;
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

describe('the grant', () => {
  it('reads the calendar scope out of the granted set', () => {
    expect(grantsGoogleCalendar(`openid email ${GOOGLE_WRITE} https://www.googleapis.com/auth/gmail.modify`)).toBe(true);
    expect(grantsGoogleCalendar('openid email https://www.googleapis.com/auth/gmail.modify')).toBe(false);
    // calendar.readonly is not write access.
    expect(grantsGoogleCalendar(`${GOOGLE_WRITE}.readonly`)).toBe(false);
  });
});

describe('pushing to an attached Gmail calendar', () => {
  it("writes with that account's token, never the login account's", async () => {
    await db.updateTable('users').set({ refresh_token_scopes: GOOGLE_WRITE }).where('id', '=', userId).execute();
    const calls = stubFetch((c) =>
      c.method === 'POST' ? res({ id: 'G-NEW', etag: '"1"', iCalUID: 'uid-1' }) : undefined,
    );
    const key = gmailCalendarKey(accountId, 'primary');
    const id = await seedEvent({ title: 'Dentist', google_calendar_id: key });

    const result = await pushDirtyEvents(db, userId);
    expect(result).toMatchObject({ created: 1, errored: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://www.googleapis.com/calendar/v3/calendars/primary/events');
    expect(calls[0]!.auth).toBe(ACCOUNT_TOKEN);

    const row = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ gcal_event_id: 'G-NEW', google_calendar_id: key, local_dirty: 0 });
  });

  it('pushes with no login-account calendar at all', async () => {
    const calls = stubFetch((c) => (c.method === 'POST' ? res({ id: 'G-2', etag: '"1"' }) : undefined));
    await seedEvent({ google_calendar_id: gmailCalendarKey(accountId, 'primary') });

    expect(await pushDirtyEvents(db, userId)).toMatchObject({ created: 1 });
    expect(calls.every((c) => c.auth === ACCOUNT_TOKEN)).toBe(true);
  });

  it('holds the event when the mailbox was connected without calendar access', async () => {
    await db.updateTable('email_accounts').set({ calendar_enabled: 0 }).where('id', '=', accountId).execute();
    const calls = stubFetch(() => undefined);
    const id = await seedEvent({ google_calendar_id: gmailCalendarKey(accountId, 'primary') });

    await pushDirtyEvents(db, userId);
    expect(calls).toHaveLength(0);
    const row = await db.selectFrom('events').select('local_dirty').where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.local_dirty).toBe(1);
    expect(await calendarConnection(db, userId, gmailCalendarKey(accountId, 'primary'))).toEqual({
      provider: 'google',
      state: 'expired',
    });
  });

  it("refuses another account's calendar through this account's client", async () => {
    const calls = stubFetch(() => undefined);
    const api = gmailAccountTransport(accountId, 'tok');
    await expect(api.insert(gmailCalendarKey('other', 'primary'), {}, false)).rejects.toThrow(/not on gmail account/);
    await expect(api.insert('primary', {}, false)).rejects.toThrow(/not on gmail account/);
    expect(calls).toHaveLength(0);
  });
});

describe('syncing an attached Gmail calendar', () => {
  it("discovers the account's calendars, makes its primary the mailbox default, and pulls with its token", async () => {
    const start = `${inDays(3, '14:00:00')}Z`;
    const calls = stubFetch((c) => {
      if (c.url.includes('/users/me/calendarList')) {
        return res({
          items: [
            { id: 'second@gmail.example', summary: 'second@gmail.example', primary: true, accessRole: 'owner' },
            { id: 'team@group.calendar.google.com', summary: 'Team', accessRole: 'writer' },
          ],
        });
      }
      if (c.url.includes('/calendars/second%40gmail.example/events')) {
        return res({
          items: [
            {
              id: 'R1',
              iCalUID: 'r1@google.com',
              status: 'confirmed',
              summary: 'Soccer',
              start: { dateTime: start },
              end: { dateTime: `${inDays(3, '15:00:00')}Z` },
              updated: new Date().toISOString(),
              etag: '"1"',
            },
          ],
          nextSyncToken: 'S1',
        });
      }
      if (c.url.includes('/events')) return res({ items: [], nextSyncToken: 'S0' });
      return undefined;
    });

    const out = await syncTwoWay(db, userId);
    const primaryKey = gmailCalendarKey(accountId, 'second@gmail.example');
    expect(Object.keys(out.pull).sort()).toEqual(
      [primaryKey, gmailCalendarKey(accountId, 'team@group.calendar.google.com')].sort(),
    );
    // No login-account calendar: nothing went out on its token.
    expect(calls.every((c) => c.auth === ACCOUNT_TOKEN)).toBe(true);

    const account = await db
      .selectFrom('email_accounts')
      .select('calendar_default_id')
      .where('id', '=', accountId)
      .executeTakeFirstOrThrow();
    expect(account.calendar_default_id).toBe(primaryKey);

    const sources = await db
      .selectFrom('calendar_sources')
      .select(['google_calendar_id', 'provider', 'is_primary'])
      .where('user_id', '=', userId)
      .execute();
    expect(sources.every((s) => s.provider === 'google' && Number(s.is_primary) === 0)).toBe(true);
    // Free/busy reads every mailbox's calendars: its own calendar blocks time.
    expect((await busyCalendarIds(db, userId)).has(primaryKey)).toBe(true);

    const events = await db
      .selectFrom('events')
      .select(['title', 'google_calendar_id', 'gcal_event_id'])
      .where('owner_user_id', '=', userId)
      .execute();
    expect(events).toEqual([{ title: 'Soccer', google_calendar_id: primaryKey, gcal_event_id: 'R1' }]);

    expect(await calendarLabel(db, userId, primaryKey)).toBe('second@gmail.example');
    expect(await calendarLabel(db, userId, gmailCalendarKey(accountId, 'team@group.calendar.google.com'))).toBe(
      'Team (second@gmail.example)',
    );
  });

  it('forgets what its calendars pulled when the mailbox is disconnected', async () => {
    const key = gmailCalendarKey(accountId, 'primary');
    await seedEvent({ google_calendar_id: key, gcal_event_id: 'R9', local_dirty: 0 });
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: userId,
        provider: 'google',
        google_calendar_id: key,
        summary: 'Second',
        access_role: 'owner',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 1,
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      } as never)
      .execute();

    await disconnectAccount(db, userId, accountId);
    const left = await db.selectFrom('events').select('id').where('owner_user_id', '=', userId).execute();
    expect(left).toHaveLength(0);
    const sources = await db.selectFrom('calendar_sources').select('id').where('user_id', '=', userId).execute();
    expect(sources).toHaveLength(0);
  });
});

describe('ADR 0312 routing for an attached Gmail with its calendar connected', () => {
  const FAMILY = 'family123@group.calendar.google.com';
  let ACCOUNT_CAL: string;

  beforeEach(async () => {
    // The login account has a calendar and a family default: exactly where an
    // event from the OTHER mailbox must not land.
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: GOOGLE_WRITE, default_calendar_id: FAMILY, email: 'me@gmail.example' })
      .where('id', '=', userId)
      .execute();
    for (const [key, summary] of [
      [FAMILY, 'Family'],
      [gmailCalendarKey(accountId, 'second@gmail.example'), 'second@gmail.example'],
    ]) {
      await upsertCalendarSource(db, userId, {
        provider: 'google',
        googleCalendarId: key!,
        summary: summary!,
        accessRole: 'owner',
        isPrimary: false,
        selectedInGoogle: true,
        isChordTarget: false,
      });
    }
    ACCOUNT_CAL = gmailCalendarKey(accountId, 'second@gmail.example');
    await db
      .updateTable('email_accounts')
      .set({ calendar_default_id: ACCOUNT_CAL })
      .where('id', '=', accountId)
      .execute();
  });

  async function stageEvent(provenance: string): Promise<string> {
    const id = newId('p');
    await db
      .insertInto('proposals')
      .values({
        id,
        group_id: groupId,
        proposed_by_user_id: userId,
        proposed_by_message_id: null,
        tool_name: 'create_event',
        args_json: JSON.stringify({
          title: 'Parent-teacher conference',
          startsAt: `${inDays(5)}Z`,
          endsAt: `${inDays(5, '16:00:00')}Z`,
        }),
        provenance,
        target_group_id: null,
        status: 'pending',
        resolved_by_user_id: null,
        resolved_by_message_id: null,
        resolved_at: null,
        bundle_id: null,
        expires_at: new Date(Date.now() + 72 * 3600_000).toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();
    return id;
  }

  it("puts the email's event on that account's calendar and pushes it with that account's token", async () => {
    // The confirm's sync lists calendars and then events; answer as Google
    // would (the event it was just sent is on it). Both tokens get the same
    // list: the second account's calendar is also shared with the login
    // account, so the login pull sees this event too and must leave it on
    // the second account's calendar (no rebind, no twin).
    const onGoogle: Record<string, unknown>[] = [];
    const calls = stubFetch((c) => {
      if (c.url.includes('/users/me/calendarList')) {
        return res({
          items: [{ id: 'second@gmail.example', summary: 'second@gmail.example', primary: true, accessRole: 'owner' }],
        });
      }
      if (c.method === 'POST') {
        const created = { id: 'G-CONF', etag: '"1"', iCalUID: 'g-conf@google.com' };
        onGoogle.push({ ...c.body, ...created, status: 'confirmed', updated: new Date().toISOString() });
        return res(created);
      }
      return res({ items: onGoogle, nextSyncToken: 'S0' });
    });
    const p = await stageEvent(`gmail:${accountId}:18f2a9c0d1e2b3a4`);
    const result = await confirmProposal(db, { id: p, resolvedByUserId: userId });
    expect(result.ok).toBe(true);
    // The confirm starts a calendar sync of its own; that is the push.
    await settleBackgroundWork();
    await pushDirtyEvents(db, userId);

    const events = await db
      .selectFrom('events')
      .select(['google_calendar_id', 'gcal_event_id', 'local_dirty'])
      .where('owner_user_id', '=', userId)
      .execute();
    expect(events).toEqual([{ google_calendar_id: ACCOUNT_CAL, gcal_event_id: 'G-CONF', local_dirty: 0 }]);

    const writes = calls.filter((c) => c.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/second%40gmail.example/events',
    );
    expect(writes[0]!.auth).toBe(ACCOUNT_TOKEN);
    expect(calls.some((c) => c.url.includes(encodeURIComponent(FAMILY)) && c.method !== 'GET')).toBe(false);
  });

  it("still asks on the card when that mailbox's calendar is not connected", async () => {
    await db.updateTable('email_accounts').set({ calendar_enabled: 0 }).where('id', '=', accountId).execute();
    const p = await stageEvent(`gmail:${accountId}:18f2a9c0d1e2b3a4`);
    expect(await confirmProposal(db, { id: p, resolvedByUserId: userId })).toEqual({
      ok: false,
      reason: 'calendar_required',
    });
  });

  it("answers its invitation on that account's calendar, never the login account's", async () => {
    const calls = stubFetch((c) => {
      if (c.method === 'GET' && c.url.includes('iCalUID=')) {
        return res({
          items: [
            {
              id: 'INV1',
              attendees: [
                { email: 'teacher@school.example', organizer: true, responseStatus: 'accepted' },
                { email: 'second@gmail.example', self: true, responseStatus: 'needsAction' },
              ],
            },
          ],
        });
      }
      if (c.method === 'PATCH') return res({ id: 'INV1' });
      return undefined;
    });

    const result = await respondToInvite(db, userId, {
      icalUid: 'conf-2026-11@school.example',
      response: 'accepted',
      organizerEmail: 'teacher@school.example',
      title: 'Parent-teacher conference',
      provenance: `gmail:${accountId}:18f2a9c0d1e2b3a4`,
    });

    expect(result).toEqual({ ok: true, via: 'calendar' });
    expect(calls.every((c) => c.auth === ACCOUNT_TOKEN)).toBe(true);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe(
      'https://www.googleapis.com/calendar/v3/calendars/second%40gmail.example/events/INV1?sendUpdates=all',
    );
    expect(patch.body).toEqual({
      attendees: [
        { email: 'teacher@school.example', organizer: true, responseStatus: 'accepted' },
        { email: 'second@gmail.example', self: true, responseStatus: 'accepted' },
      ],
    });
  });

  it("does not look on the attached account's calendar for an invitation to the primary Gmail", async () => {
    const calls = stubFetch(() => res({ items: [] }));
    await respondToInvite(db, userId, {
      icalUid: 'other@example.org',
      response: 'accepted',
      organizerEmail: 'host@example.org',
      provenance: 'gmail:18f2a9c0d1e2b3a4',
    });
    expect(calls.some((c) => c.auth === ACCOUNT_TOKEN)).toBe(false);
    expect(calls.some((c) => c.url.includes('gacct'))).toBe(false);
  });
});
