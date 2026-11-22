/**
 * An invite arriving for an email event Chord has ALREADY pushed
 * (ADR 0074 addendum 2026-10-23, narrowed by ADR 0344).
 *
 * A confirmed email event is pushed to Google within seconds, so by the time
 * the real invite arrives the email twin carries `gcal_event_id`. Taking it
 * over meant deleting Chord's pushed copy from Google, and Google then emails
 * every guest on it a cancellation (prod 2026-11-16: Ken's call was cancelled
 * by an unrelated meeting). Now the invite is added as its own event, Chord's
 * copy is left on the calendar, and the user is asked in chat whether to
 * remove it; only that tap deletes anything.
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

const base = Date.now() + 3 * 86_400_000;
const slotIso = new Date(base).toISOString();
const slotPlus15 = new Date(base + 15 * 60_000).toISOString();
const slotEnd = new Date(base + 45 * 60_000).toISOString();

const INVITE_UID = 'uid-real-invite@google.com';
const SAM = 'sam@example.com';

const invite = (extra: Record<string, unknown> = {}) => ({
  id: 'GG1',
  status: 'confirmed',
  summary: 'Coffee: John / Sam',
  iCalUID: INVITE_UID,
  start: { dateTime: slotPlus15 },
  end: { dateTime: slotEnd },
  updated: new Date().toISOString(),
  sequence: 0,
  organizer: { email: SAM },
  ...extra,
});

/** Chord's own pushed copy, as Google lists it (a full sync lists everything). */
const chordCopy = {
  id: 'CHORD1',
  status: 'confirmed',
  summary: 'Coffee with John',
  iCalUID: 'chord1@google.com',
  start: { dateTime: slotIso },
  end: { dateTime: slotEnd },
  updated: new Date(Date.now() - 60_000).toISOString(),
  sequence: 0,
  extendedProperties: { private: { chordUid: 'ce_chord1' } },
};

describe('an invite for an email event Chord already pushed', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'invite-pushed-twin-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    for (const gid of ['t_agree', 't_invite']) {
      await seedSyncedMail(db, userId, { gmailThreadId: gid, subject: 'Coffee?', fromEmail: SAM });
    }
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  /** The email-agreed event, as it looks seconds after the push landed. */
  const seedPushedEmailEvent = async () => {
    const ev = await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'Coffee with John',
      startsAt: slotIso,
      sourceRawContext: 'gmail:t_agree',
    });
    await db
      .updateTable('events')
      .set({
        gcal_event_id: 'CHORD1',
        google_calendar_id: 'primary',
        chord_uid: 'ce_chord1',
        ical_uid: 'chord1@google.com',
        etag: '"e1"',
        gcal_sync_status: 'synced',
        local_dirty: 0,
      })
      .where('id', '=', ev.id)
      .execute();
    return ev;
  };

  const liveRows = () =>
    db
      .selectFrom('events')
      .select(['id', 'title', 'gcal_event_id', 'google_calendar_id', 'chord_uid', 'ical_uid', 'external_uid', 'local_dirty'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();

  const tombstones = () =>
    db
      .selectFrom('events')
      .select(['gcal_event_id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is not', null)
      .execute();

  const questionsAbout = async (eventId: string) => {
    const rows = await db
      .selectFrom('proposals')
      .select('args_json')
      .where('proposed_by_user_id', '=', userId)
      .where('tool_name', '=', 'delete_event')
      .where('status', '=', 'pending')
      .execute();
    return rows.filter((r) => (JSON.parse(r.args_json) as { eventId?: string }).eventId === eventId);
  };

  const stubPull = (items: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('/events')) return gjson({ items, nextSyncToken: 'tok1' });
        return gjson({});
      }),
    );

  it('a Google-side accept adds the invite, leaves Chord’s copy on Google, and asks', async () => {
    const emailEvent = await seedPushedEmailEvent();
    stubPull([invite(), chordCopy]);

    const result = await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    expect(result.inserted).toBe(1);

    const rows = await liveRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === emailEvent.id)).toMatchObject({
      gcal_event_id: 'CHORD1',
      chord_uid: 'ce_chord1',
      title: 'Coffee with John',
    });
    expect(rows.find((r) => r.gcal_event_id === 'GG1')?.title).toBe('Coffee: John / Sam');
    expect(await tombstones()).toHaveLength(0);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);
  });

  it('a later pull does not add either event again or ask twice', async () => {
    const emailEvent = await seedPushedEmailEvent();
    stubPull([invite(), chordCopy]);
    await pullCalendarChanges(db, userId, 'primary', 'fake-token');

    vi.unstubAllGlobals();
    stubPull([invite({ updated: new Date(Date.now() + 1000).toISOString() }), { ...chordCopy, updated: new Date().toISOString() }]);
    const result = await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    expect(result.inserted).toBe(0);
    expect(await liveRows()).toHaveLength(2);
    expect(await tombstones()).toHaveLength(0);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);
  });

  it('confirming the invite email adds the invite and asks, leaving Chord’s copy alone', async () => {
    const emailEvent = await seedPushedEmailEvent();
    await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      mode: 'commit',
      provenance: 'gmail:t_invite',
      call: {
        name: 'create_event',
        args: {
          title: 'Coffee (invite)',
          startsAt: slotPlus15,
          endsAt: slotEnd,
          externalUid: INVITE_UID,
          alreadyInGoogle: true,
        },
      },
    });

    const rows = await liveRows();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === emailEvent.id)).toMatchObject({ gcal_event_id: 'CHORD1', chord_uid: 'ce_chord1' });
    // Google owns an accepted invite (ADR 0103): unbound, not dirty.
    expect(rows.find((r) => r.id !== emailEvent.id)).toMatchObject({
      external_uid: INVITE_UID,
      gcal_event_id: null,
      google_calendar_id: null,
      chord_uid: null,
      local_dirty: 0,
      title: 'Coffee (invite)',
    });
    expect(await tombstones()).toHaveLength(0);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);

    // The organizer's event then arrives and lands on the invite's row.
    stubPull([invite(), chordCopy]);
    const pull = await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    expect(pull.inserted).toBe(0);
    const after = await liveRows();
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.external_uid === INVITE_UID)?.gcal_event_id).toBe('GG1');
  });

  it('a Google-side decline leaves Chord’s copy on Google and asks about it', async () => {
    const emailEvent = await seedPushedEmailEvent();
    stubPull([
      invite({ attendees: [{ email: SAM, organizer: true }, { self: true, responseStatus: 'declined' }] }),
      chordCopy,
    ]);
    const result = await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    expect(result.inserted).toBe(0);
    const rows = await liveRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: emailEvent.id, gcal_event_id: 'CHORD1', local_dirty: 0 });
    expect(await tombstones()).toHaveLength(0);
    expect(await questionsAbout(emailEvent.id)).toHaveLength(1);
  });
});
