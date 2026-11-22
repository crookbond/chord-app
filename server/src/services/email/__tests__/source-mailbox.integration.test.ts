/**
 * ADR 0312 — what an email produces stays with the mailbox it came to.
 *
 * The leak this pins: a user with a work Outlook mailbox and a family Google
 * calendar set as their default. A meeting suggested from the WORK mail was
 * confirmed onto the FAMILY calendar, and an invitation to the work address
 * was answered from the personal Gmail. Google and Graph are faked at the
 * fetch boundary; the IMAP and Outlook mail senders run their mocks.
 */
import { Kysely } from 'kysely';
import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  UnknownRow,
} from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'google-token'),
}));
vi.mock('@/services/email-accounts/outlook-oauth.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getOutlookAccessToken: vi.fn(async () => 'outlook-token'),
}));

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { __imapMockSentRaw } from '@/services/email-accounts/imap-api.js';
import { __outlookMockSentMime } from '@/services/email-accounts/outlook-api.js';
import { respondToInvite } from '@/services/google/rsvp.service.js';
import { createGroup } from '@/services/groups.service.js';
import { attachCalendarChoices } from '@/services/email/source-mailbox.js';
import { __resetOutlookCalendarTokens } from '@/services/outlook-calendar/accounts.js';
import { outlookCalendarKey } from '@/services/outlook-calendar/ids.js';
import {
  attachSourceHrefs,
  confirmProposal,
  listProposalsForGroup,
} from '@/services/proposals.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const GOOGLE_WRITE = 'https://www.googleapis.com/auth/calendar';
const FAMILY = 'family123@group.calendar.google.com';

type Env = {
  OUTLOOK_CALENDAR_ENABLED: boolean;
  OUTLOOK_PROVIDER: 'real' | 'mock';
  IMAP_PROVIDER: 'real' | 'mock';
};
const saved = {
  OUTLOOK_CALENDAR_ENABLED: env.OUTLOOK_CALENDAR_ENABLED,
  OUTLOOK_PROVIDER: env.OUTLOOK_PROVIDER,
  IMAP_PROVIDER: env.IMAP_PROVIDER,
};
const setEnv = (over: Partial<Env>) => Object.assign(env as unknown as Env, over);

interface Call {
  url: string;
  method: string;
}
let calls: Call[];

function stubFetch(): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ items: [], value: [] }),
        text: async () => '{}',
      } as unknown as Response;
    }),
  );
}

const inDays = (n: number, time = '15:00:00'): string =>
  `${new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function seedAccount(provider: 'outlook' | 'imap' | 'gmail', email: string, over: Record<string, unknown> = {}) {
  const id = newId('ema');
  const now = new Date().toISOString();
  await db
    .insertInto('email_accounts')
    .values({
      id,
      user_id: userId,
      provider,
      email_address: email,
      display_name: 'John',
      preset_key: provider === 'imap' ? 'yahoo' : null,
      auth_ciphertext: null,
      auth_iv: null,
      auth_tag: null,
      sync_cursor: null,
      synced_at: null,
      status: 'ok',
      calendar_enabled: 0,
      created_at: now,
      updated_at: now,
      ...over,
    })
    .execute();
  return id;
}

async function seedSource(provider: 'google' | 'outlook', key: string, summary: string) {
  await upsertCalendarSource(db, userId, {
    provider,
    googleCalendarId: key,
    summary,
    accessRole: 'owner',
    isPrimary: false,
    selectedInGoogle: true,
    isChordTarget: false,
  });
}

/** A pending email suggestion, as the magics pass stages it. */
async function stageEvent(provenance: string, args: Record<string, unknown> = {}): Promise<string> {
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
        title: 'Quarterly planning',
        startsAt: inDays(5),
        endsAt: inDays(5, '16:00:00'),
        ...args,
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

const createdEvents = () =>
  db
    .selectFrom('events')
    .select(['title', 'google_calendar_id', 'source_raw_context'])
    .where('owner_user_id', '=', userId)
    .execute();

const proposalStatus = async (id: string) =>
  (await db.selectFrom('proposals').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;

beforeEach(async () => {
  setEnv({ OUTLOOK_CALENDAR_ENABLED: true, OUTLOOK_PROVIDER: 'real', IMAP_PROVIDER: 'mock' });
  __resetOutlookCalendarTokens();
  stubFetch();
  db = await openTestDb();
  userId = await createUser(db, 'john');
  await db
    .updateTable('users')
    // Just synced: the confirm's follow-up sync (throttled) stays out of
    // these tests, whose fetch stub says every mailbox has no calendars.
    .set({
      refresh_token_scopes: GOOGLE_WRITE,
      default_calendar_id: FAMILY,
      email: 'john@gmail.example',
      google_calendar_synced_at: new Date().toISOString(),
    })
    .where('id', '=', userId)
    .execute();
  await seedSource('google', FAMILY, 'Family');
  groupId = (await createGroup(db, { name: 'Me', kind: 'group', createdBy: userId })).id;
});

afterEach(async () => {
  await settleBackgroundWork();
  setEnv(saved);
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

describe('an event from email goes on its own mailbox calendar', () => {
  it('puts a work-Outlook meeting on the work calendar, not the family default', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await seedSource('outlook', WORK_CAL, 'Calendar');

    const p = await stageEvent(`gmail:${work}:AAMkAGI2THREAD`);
    const result = await confirmProposal(db, { id: p, resolvedByUserId: userId });

    expect(result.ok).toBe(true);
    const events = await createdEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.google_calendar_id).toBe(WORK_CAL);
    expect(events[0]!.google_calendar_id).not.toBe(FAMILY);
  });

  it('puts Outlook mail on that mailbox calendar even when the default is another of its calendars', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    const TEAM_CAL = outlookCalendarKey(work, 'TEAMCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await seedSource('outlook', WORK_CAL, 'Calendar');
    await seedSource('outlook', TEAM_CAL, 'Team');
    await db.updateTable('users').set({ default_calendar_id: TEAM_CAL }).where('id', '=', userId).execute();

    const p = await stageEvent(`gmail:${work}:AAMkAGI2THREAD`);
    expect((await confirmProposal(db, { id: p, resolvedByUserId: userId })).ok).toBe(true);
    expect((await createdEvents())[0]!.google_calendar_id).toBe(WORK_CAL);
  });

  it('puts primary-Gmail mail on the Google default calendar', async () => {
    const p = await stageEvent('gmail:18f2a9c0d1e2b3a4');
    expect((await confirmProposal(db, { id: p, resolvedByUserId: userId })).ok).toBe(true);
    expect((await createdEvents())[0]!.google_calendar_id).toBe(FAMILY);
  });

  it('keeps primary-Gmail mail off an Outlook calendar even when that is the default', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await seedSource('outlook', WORK_CAL, 'Calendar');
    await db.updateTable('users').set({ default_calendar_id: WORK_CAL }).where('id', '=', userId).execute();

    const p = await stageEvent('gmail:18f2a9c0d1e2b3a4');
    expect((await confirmProposal(db, { id: p, resolvedByUserId: userId })).ok).toBe(true);
    expect((await createdEvents())[0]!.google_calendar_id).toBe('primary');
  });

  it('asks on the card for an IMAP mailbox, and places nothing without an answer', async () => {
    const yahoo = await seedAccount('imap', 'john@yahoo.example');
    const p = await stageEvent(`gmail:${yahoo}:4711`);

    const refused = await confirmProposal(db, { id: p, resolvedByUserId: userId });
    expect(refused).toEqual({ ok: false, reason: 'calendar_required' });
    expect(await proposalStatus(p)).toBe('pending');
    expect(await createdEvents()).toHaveLength(0);

    const bogus = await confirmProposal(db, { id: p, resolvedByUserId: userId, calendarId: 'someone-else@group.calendar.google.com' });
    expect(bogus).toEqual({ ok: false, reason: 'calendar_not_writable' });
    expect(await createdEvents()).toHaveLength(0);

    const picked = await confirmProposal(db, { id: p, resolvedByUserId: userId, calendarId: FAMILY });
    expect(picked.ok).toBe(true);
    expect((await createdEvents())[0]!.google_calendar_id).toBe(FAMILY);
  });

  it('saves it in Chord when the user has no calendar at all, rather than refusing', async () => {
    await db.updateTable('users').set({ refresh_token_scopes: null, default_calendar_id: null }).where('id', '=', userId).execute();
    await db.deleteFrom('calendar_sources').where('user_id', '=', userId).execute();
    const yahoo = await seedAccount('imap', 'john@yahoo.example');
    const p = await stageEvent(`gmail:${yahoo}:4711`);
    expect((await confirmProposal(db, { id: p, resolvedByUserId: userId })).ok).toBe(true);
    expect(await createdEvents()).toHaveLength(1);
  });

  it('asks for a secondary Gmail too, since its calendar is not connected', async () => {
    const other = await seedAccount('gmail', 'john.other@gmail.example');
    const p = await stageEvent(`gmail:${other}:18f2a9c0`);
    expect(await confirmProposal(db, { id: p, resolvedByUserId: userId })).toEqual({
      ok: false,
      reason: 'calendar_required',
    });
  });
});

describe('the card says where the event goes', () => {
  it('asks when the Outlook mailbox needs reconnecting, instead of naming a calendar it cannot write', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1, status: 'reconnect' });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await seedSource('outlook', WORK_CAL, 'Work');

    const p = await stageEvent(`gmail:${work}:AAMkAGI2THREAD`);
    const [card] = await attachSourceHrefs(db, userId, await listProposalsForGroup(db, groupId, { status: 'pending' }));
    expect(card!.id).toBe(p);
    expect(card!.calendarChoice?.kind).toBe('ask');

    const refused = await confirmProposal(db, { id: p, resolvedByUserId: userId });
    expect(refused).toEqual({ ok: false, reason: 'calendar_required' });
    expect(await createdEvents()).toHaveLength(0);
  });

  it('names the mailbox calendar, or lists the choices when it must ask', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await seedSource('outlook', WORK_CAL, 'Work');
    const yahoo = await seedAccount('imap', 'john@yahoo.example');

    const fromWork = await stageEvent(`gmail:${work}:AAMkAGI2THREAD`);
    const fromYahoo = await stageEvent(`gmail:${yahoo}:4711`);
    const cards = await attachSourceHrefs(db, userId, await listProposalsForGroup(db, groupId, { status: 'pending' }));
    const byId = new Map(cards.map((c) => [c.id, c]));

    expect(byId.get(fromWork)!.calendarChoice).toMatchObject({ kind: 'auto', calendarId: WORK_CAL });
    const ask = byId.get(fromYahoo)!.calendarChoice;
    expect(ask?.kind).toBe('ask');
    const ids = ask?.kind === 'ask' ? ask.options.map((o) => o.calendarId) : [];
    expect(ids).toEqual(expect.arrayContaining(['primary', FAMILY, WORK_CAL]));
  });
});

describe('listing many email cards', () => {
  class QueryCounter implements KyselyPlugin {
    count = 0;
    transformQuery(args: PluginTransformQueryArgs) {
      this.count += 1;
      return args.node;
    }
    async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return args.result;
    }
  }

  async function queriesFor(n: number, mailbox: string, prefix: string): Promise<number> {
    await db.deleteFrom('proposals').execute();
    for (let i = 0; i < n; i++) await stageEvent(`gmail:${mailbox}:${prefix}${i}`);
    const pending = await listProposalsForGroup(db, groupId, { status: 'pending' });
    const counter = new QueryCounter();
    const cards = await attachCalendarChoices(db.withPlugin(counter), userId, pending);
    expect(cards.every((c) => c.calendarChoice)).toBe(true);
    return counter.count;
  }

  it('does not run a handful of queries per card', async () => {
    // The Action Items list holds many suggestions from the same mailbox;
    // each card used to re-read its thread, mailbox, user, scopes and label.
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    const WORK_CAL = outlookCalendarKey(work, 'WORKCAL');
    await db.updateTable('email_accounts').set({ calendar_default_id: WORK_CAL }).where('id', '=', work).execute();
    await seedSource('outlook', WORK_CAL, 'Work');
    const yahoo = await seedAccount('imap', 'john@yahoo.example');

    const one = await queriesFor(1, work, 'T');
    const many = await queriesFor(12, work, 'T');
    expect(many).toBe(one);

    const askOne = await queriesFor(1, yahoo, 'Y');
    const askMany = await queriesFor(12, yahoo, 'Y');
    expect(askMany).toBe(askOne);
  });
});

describe('an invitation is answered by the mailbox it came to', () => {
  it('answers a Yahoo invite from the Yahoo address and never touches Google', async () => {
    const yahoo = await seedAccount('imap', 'john@yahoo.example');
    const result = await respondToInvite(db, userId, {
      icalUid: 'evite-2026-1105@example.org',
      response: 'accepted',
      organizerEmail: 'host@example.org',
      title: 'Book club',
      provenance: `gmail:${yahoo}:4711`,
    });

    expect(result).toEqual({ ok: true, via: 'email' });
    expect(calls.filter((c) => c.url.includes('googleapis.com'))).toEqual([]);
    const sent = __imapMockSentRaw(yahoo);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('From: John <john@yahoo.example>');
    expect(sent[0]).toContain('mailto:john@yahoo.example');
    expect(sent[0]).not.toContain('john@gmail.example');
  });

  it('answers an Outlook invite from Outlook when its calendar is not connected', async () => {
    setEnv({ OUTLOOK_PROVIDER: 'mock' });
    const work = await seedAccount('outlook', 'john@work.example');
    const result = await respondToInvite(db, userId, {
      icalUid: 'AAMkAGI2-invite',
      response: 'declined',
      organizerEmail: 'boss@work.example',
      title: 'Quarterly planning',
      provenance: `gmail:${work}:AAMkAGI2THREAD`,
    });

    expect(result).toEqual({ ok: true, via: 'email' });
    expect(calls.filter((c) => c.url.includes('googleapis.com'))).toEqual([]);
    const sent = __outlookMockSentMime(work);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('john@work.example');
    expect(sent[0]).toContain('PARTSTAT=DECLINED');
  });

  it('confirming an IMAP invite card answers from IMAP and records it without asking for a calendar', async () => {
    const yahoo = await seedAccount('imap', 'john@yahoo.example');
    const p = await stageEvent(`gmail:${yahoo}:4712`, {
      alreadyInGoogle: true,
      externalUid: 'evite-2026-1106@example.org',
      organizerEmail: 'host@example.org',
    });

    const result = await confirmProposal(db, { id: p, resolvedByUserId: userId });
    expect(result.ok).toBe(true);
    expect(__imapMockSentRaw(yahoo)).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes('googleapis.com/calendar'))).toEqual([]);
    const [event] = await createdEvents();
    expect(event!.google_calendar_id).toBeNull();
  });

  it('does not look on an Outlook calendar for an invite that came to the primary Gmail', async () => {
    const work = await seedAccount('outlook', 'john@work.example', { calendar_enabled: 1 });
    await db
      .updateTable('email_accounts')
      .set({ calendar_default_id: outlookCalendarKey(work, 'WORKCAL') })
      .where('id', '=', work)
      .execute();

    await respondToInvite(db, userId, {
      icalUid: 'gmail-invite',
      response: 'accepted',
      organizerEmail: 'friend@example.org',
      provenance: 'gmail:18f2a9c0d1e2b3a4',
    });
    expect(calls.filter((c) => c.url.includes('graph.microsoft.com'))).toEqual([]);
  });
});

/**
 * Prod 2026-11-18: accepting Neelabh's "call" invitation, which came to an
 * Outlook mailbox, failed three times with `no_organizer` - the Graph probe
 * never read the organizer, so the card had nobody to answer. Cards staged
 * that way are answered to the email's sender, when that is a person.
 */
describe('an invitation with no organizer is answered to its sender', () => {
  async function seedInviteThread(accountId: string, messages: { from: string; at: string; labels?: string[] }[]) {
    const gid = `${accountId}:AAQkNeelabhCall`;
    const threadId = newId('emt');
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: threadId,
        user_id: userId,
        account_id: accountId,
        gmail_thread_id: gid,
        subject: 'Call',
        snippet: 'Neelabh has invited you',
        last_message_at: messages[messages.length - 1]!.at,
        created_at: now,
        updated_at: now,
      })
      .execute();
    for (const [i, m] of messages.entries()) {
      await db
        .insertInto('email_messages')
        .values({
          id: newId('emm'),
          user_id: userId,
          account_id: accountId,
          thread_id: threadId,
          gmail_message_id: `${accountId}:m${i}`,
          gmail_thread_id: gid,
          from_name: null,
          from_email: m.from,
          to_emails: JSON.stringify(['john@work.example']),
          cc_emails: JSON.stringify([]),
          subject: 'Call',
          snippet: 'Neelabh has invited you',
          body_text: null,
          body_html: null,
          internal_date: m.at,
          is_unread: 1,
          gmail_label_ids: JSON.stringify(m.labels ?? ['INBOX']),
          rfc822_message_id: null,
          headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
          created_at: now,
        })
        .execute();
    }
    return `gmail:${gid}`;
  }

  it('accepts an Outlook invite card that has no organizer by replying to the sender', async () => {
    setEnv({ OUTLOOK_PROVIDER: 'mock' });
    const work = await seedAccount('outlook', 'john@work.example');
    const provenance = await seedInviteThread(work, [
      { from: 'Neelabh@Partner.example', at: '2026-11-18T19:02:00.000Z' },
      // The user's own reply on the thread is never the organizer.
      { from: 'john@work.example', at: '2026-11-18T19:10:00.000Z', labels: ['SENT'] },
    ]);

    const result = await respondToInvite(db, userId, {
      icalUid: '040000008200E00074C5B7101A82E008-call',
      response: 'accepted',
      organizerEmail: null,
      title: 'Call',
      provenance,
    });

    expect(result).toEqual({ ok: true, via: 'email' });
    const sent = __outlookMockSentMime(work);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('neelabh@partner.example');
    expect(sent[0]).toContain('PARTSTAT=ACCEPTED');
  });

  it('still refuses when the sender is a calendar robot, not a person', async () => {
    setEnv({ OUTLOOK_PROVIDER: 'mock' });
    const work = await seedAccount('outlook', 'john@work.example');
    const provenance = await seedInviteThread(work, [
      { from: 'calendar-notification@google.com', at: '2026-11-18T19:02:00.000Z' },
    ]);

    const result = await respondToInvite(db, userId, {
      icalUid: 'relayed-invite',
      response: 'accepted',
      title: 'Call',
      provenance,
    });

    expect(result).toMatchObject({ ok: false, reason: 'no_organizer' });
    expect(__outlookMockSentMime(work)).toHaveLength(0);
  });
});
