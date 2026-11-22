/**
 * A calendar item that looks like the real version of an event Chord made
 * from an email is not allowed to cancel that event on its own (ADR 0344).
 *
 * Prod 2026-11-16: John agreed a call with Ken by email, confirmed Chord's
 * card, and "Call with Kenneth Lane" (Tue 12:00, Ken invited) went onto his
 * Google calendar. Hours later an unrelated meeting ("RE: Brightstream ...",
 * Tue 11:00, other people) synced in. The "invite wins" rule (ADR 0074)
 * matched it to the Ken call because the starts were exactly an hour apart,
 * took over the Ken row and deleted the Google event, so Google emailed Ken a
 * cancellation. Nobody was asked.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { confirmProposal } from '@/services/proposals.service.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const HOUR = 3_600_000;
const noon = new Date(Date.now() + 2 * 86_400_000);
noon.setUTCHours(17, 0, 0, 0);
const kenStart = noon.toISOString();
const kenEnd = new Date(noon.getTime() + HOUR).toISOString();
const THREAD = '1a1c372fba0e24d6';
const ME = 'ownertest@gmail.com';
const KEN = 'ken@media.example';

/** The unrelated meeting that arrived, as the calendar lists it. */
const brightstream = {
  id: 'BRIGHT1',
  status: 'confirmed',
  summary: 'RE: Brightstream AI respondent data ready: brightstream_ai_respondents_2026_11',
  iCalUID: 'bright1@example.test',
  start: { dateTime: new Date(noon.getTime() - HOUR).toISOString() },
  end: { dateTime: new Date(noon.getTime() - HOUR / 2).toISOString() },
  updated: new Date().toISOString(),
  sequence: 0,
  organizer: { email: 'ashton@neuralads.ai' },
  attendees: [
    'jason.sellers@big-village.com',
    'ashton@neuralads.ai',
    'andy.dawson@big-village.com',
    'jp.sands@brightmountainmedia.com',
    'gary.yates@big-village.com',
    'mike.miller@big-village.com',
    'brad@neuralads.ai',
    'tom@neuralads.ai',
    'john@neuralads.ai',
    'ryota@neuralads.ai',
  ].map((email) => ({ email, responseStatus: 'needsAction' })),
};

/** Ken's own invite for the same call, under a different title. */
const kenInvite = (extra: Record<string, unknown> = {}) => ({
  id: 'KENINV',
  status: 'confirmed',
  summary: 'Sony model',
  iCalUID: 'ken.invites@media.example',
  start: { dateTime: new Date(noon.getTime() + 15 * 60_000).toISOString() },
  end: { dateTime: kenEnd },
  updated: new Date().toISOString(),
  sequence: 0,
  organizer: { email: KEN },
  attendees: [
    { email: KEN, organizer: true, responseStatus: 'accepted' },
    { email: ME, self: true, responseStatus: 'needsAction' },
  ],
  ...extra,
});

describe('a calendar item never cancels an email-made event on its own', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let kenEventId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db.updateTable('users').set({ email: ME }).where('id', '=', userId).execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;

    // The "Connect" thread the call was agreed in.
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    await seedSyncedMail(db, userId, {
      gmailThreadId: THREAD,
      subject: 'Connect',
      fromEmail: 'karl@media.example',
      toEmails: [ME, KEN],
      at: at(100),
    });
    await seedSyncedMail(db, userId, {
      gmailThreadId: THREAD,
      subject: 'Re: Connect',
      fromEmail: KEN,
      toEmails: [ME],
      at: at(5),
      labels: ['INBOX'],
    });
    await seedSyncedMail(db, userId, {
      gmailThreadId: THREAD,
      subject: 'Re: Connect',
      fromEmail: ME,
      toEmails: [KEN],
      at: at(4),
      labels: ['SENT'],
    });

    // The confirmed card, as it looks once pushed with Ken invited.
    const ev = await createEvent(db, {
      groupId: personalId,
      createdBy: userId,
      title: 'Call with Kenneth Lane',
      startsAt: kenStart,
      endsAt: kenEnd,
      sourceRawContext: `gmail:${THREAD}`,
    });
    kenEventId = ev.id;
    await db
      .updateTable('events')
      .set({
        gcal_event_id: 'KENCALL',
        google_calendar_id: ME,
        chord_uid: 'ce_kencall',
        ical_uid: 'kencall@google.com',
        etag: '"e1"',
        gcal_sync_status: 'synced',
        local_dirty: 0,
      })
      .where('id', '=', ev.id)
      .execute();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  /** Chord's own pushed Ken call, as the calendar lists it (a full sync lists everything). */
  const kenCopy = {
    id: 'KENCALL',
    status: 'confirmed',
    summary: 'Call with Kenneth Lane',
    iCalUID: 'kencall@google.com',
    start: { dateTime: kenStart },
    end: { dateTime: kenEnd },
    updated: new Date(Date.now() - 60_000).toISOString(),
    sequence: 0,
    organizer: { email: ME, self: true },
    attendees: [
      { email: ME, organizer: true, self: true, responseStatus: 'accepted' },
      { email: KEN, responseStatus: 'needsAction' },
    ],
    extendedProperties: { private: { chordUid: 'ce_kencall' } },
  };

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/events')) return gjson({ items: [...items, kenCopy], nextSyncToken: 'tok1' });
        return gjson({});
      }),
    );

  const kenRow = () =>
    db
      .selectFrom('events')
      .select(['title', 'gcal_event_id', 'chord_uid', 'deleted_at', 'local_dirty'])
      .where('id', '=', kenEventId)
      .executeTakeFirst();

  const tombstones = () =>
    db
      .selectFrom('events')
      .select(['gcal_event_id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is not', null)
      .execute();

  const questions = () =>
    db
      .selectFrom('proposals')
      .select(['id', 'tool_name', 'args_json', 'proposed_by_message_id', 'group_id', 'status'])
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'delete_event')
      .execute();

  it('an unrelated meeting an hour earlier is just added: the Ken call stays and nobody is asked', async () => {
    stubPull([brightstream]);
    const result = await pullCalendarChanges(db, userId, ME, 'fake-token');

    expect(result.inserted).toBe(1);
    expect(await kenRow()).toMatchObject({
      title: 'Call with Kenneth Lane',
      gcal_event_id: 'KENCALL',
      chord_uid: 'ce_kencall',
      deleted_at: null,
    });
    expect(await tombstones()).toHaveLength(0);
    expect(await questions()).toHaveLength(0);
  });

  it('the real invite from Ken is added beside it and Chord asks in chat before removing anything', async () => {
    stubPull([kenInvite()]);
    const result = await pullCalendarChanges(db, userId, ME, 'fake-token');

    expect(result.inserted).toBe(1);
    expect(await kenRow()).toMatchObject({ gcal_event_id: 'KENCALL', deleted_at: null });
    expect(await tombstones()).toHaveLength(0);

    const qs = await questions();
    expect(qs).toHaveLength(1);
    expect(qs[0]).toMatchObject({ group_id: personalId, status: 'pending' });
    expect(JSON.parse(qs[0].args_json)).toMatchObject({ eventId: kenEventId });
    const msg = await db
      .selectFrom('messages')
      .select(['group_id', 'kind', 'body'])
      .where('id', '=', qs[0].proposed_by_message_id!)
      .executeTakeFirstOrThrow();
    expect(msg).toMatchObject({ group_id: personalId, kind: 'system' });
    expect(msg.body).toContain('Call with Kenneth Lane');
    expect(msg.body).toContain('Sony model');
    expect(msg.body).toMatch(/cancellation/i);

    // A second pull does not ask again.
    vi.unstubAllGlobals();
    stubPull([kenInvite({ updated: new Date(Date.now() + 1000).toISOString() })]);
    await pullCalendarChanges(db, userId, ME, 'fake-token');
    expect(await questions()).toHaveLength(1);

    // Only the tap removes it.
    const done = await confirmProposal(db, { id: qs[0].id, resolvedByUserId: userId });
    expect(done.ok).toBe(true);
    expect((await kenRow())?.deleted_at ?? 'gone').not.toBeNull();
  });

  it('declining the invite asks about the Ken call instead of cancelling it', async () => {
    stubPull([kenInvite({ attendees: [{ email: KEN, organizer: true }, { email: ME, self: true, responseStatus: 'declined' }] })]);
    await pullCalendarChanges(db, userId, ME, 'fake-token');

    expect(await kenRow()).toMatchObject({ gcal_event_id: 'KENCALL', deleted_at: null, local_dirty: 0 });
    expect(await tombstones()).toHaveLength(0);
    expect(await questions()).toHaveLength(1);
  });

  it('accepting the invite card adds it and asks about the Ken call instead of removing it', async () => {
    const res = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      mode: 'commit',
      provenance: `gmail:${THREAD}`,
      call: {
        name: 'create_event',
        args: {
          title: 'Sony model',
          startsAt: kenInvite().start.dateTime,
          endsAt: kenEnd,
          externalUid: 'ken.invites@media.example',
          alreadyInGoogle: true,
        },
      },
    });
    expect(res.summary).toContain('Sony model');
    const invite = await db
      .selectFrom('events')
      .select('id')
      .where('owner_user_id', '=', userId)
      .where('external_uid', '=', 'ken.invites@media.example')
      .where('deleted_at', 'is', null)
      .execute();
    expect(invite).toHaveLength(1);
    expect(invite[0].id).not.toBe(kenEventId);
    expect(await kenRow()).toMatchObject({ gcal_event_id: 'KENCALL', deleted_at: null });
    expect(await tombstones()).toHaveLength(0);
    expect(await questions()).toHaveLength(1);
  });
});
