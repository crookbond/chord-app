/**
 * A meeting you were INVITED to is not ours to put on a calendar.
 *
 * Prod, 2026-08-24. Sharon sent an invite; Chord parsed the `.ics`, staged a
 * proposal keyed on the invite UID (ADR 0074), and the user confirmed it. Chord
 * then PUSHED that event to Google, minting a second event on the family
 * calendar, and the push response overwrote `ical_uid` with Google's UID for
 * OUR copy — so when the real invite arrived on the primary calendar minutes
 * later, nothing matched it and it landed as a twin.
 *
 * Crucially the create-side dedup was not at fault: Google had not yet put the
 * invite on the calendar (it holds one from an unfamiliar sender until the user
 * answers), so at confirm time there was genuinely nothing to match. The window
 * cannot be closed by better matching — the push is what must not happen.
 *
 * Two rules here: an invite-derived event neither pushes nor claims a calendar,
 * and the pull finds it by the invite UID wherever that UID is stored.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const INVITE_UID = '760peqpjqopqhsl0mm34au3kf6@google.com';
const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
const end = new Date(Date.now() + 2 * 86_400_000 + 45 * 60_000).toISOString();

describe('an invite-derived event is never pushed to Google', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  let calls: string[];

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'invite-push-user');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
        return gjson({ items: [], nextSyncToken: 'tok' });
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const inviteEvent = () =>
    createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'John / Shail Coffee',
      startsAt: start,
      endsAt: end,
      externalUid: INVITE_UID,
      alreadyInGoogle: true,
      sourceRawContext: 'gmail:t_invite',
      googleCalendarId: 'family@group.calendar.google.com',
    });

  const row = async (id: string) =>
    db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  it('is not queued for push and claims no calendar', async () => {
    const ev = await inviteEvent();
    const r = await row(ev.id);

    expect(r.local_dirty).toBe(0);
    // A calendar we picked would be a guess: Google decides where an accepted
    // invite lands, and a claimed calendar also blocks the pull from matching.
    expect(r.google_calendar_id).toBeNull();
    // Nothing to recognize on the Google side, because we put nothing there.
    expect(r.chord_uid).toBeNull();
    // The invite's own UID survives as the reconcile key.
    expect(r.ical_uid).toBe(INVITE_UID);
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('the accepted invite adopts that row instead of arriving as a twin', async () => {
    const ev = await inviteEvent();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events')
          ? gjson({
              items: [
                {
                  id: '760peqpjqopqhsl0mm34au3kf6',
                  status: 'confirmed',
                  summary: 'John / Shail Coffee',
                  iCalUID: INVITE_UID,
                  start: { dateTime: start },
                  end: { dateTime: end },
                  updated: new Date().toISOString(),
                  sequence: 0,
                },
              ],
              nextSyncToken: 'tok1',
            })
          : gjson({}),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'ownertest@gmail.com', 'fake-token');

    expect(result.inserted).toBe(0);
    expect(result.applied).toBe(1);
    const rows = await db
      .selectFrom('events')
      .select(['id', 'gcal_event_id', 'google_calendar_id'])
      .where('owner_user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(ev.id);
    // It adopts the calendar the invite actually landed on, not the one the
    // group happened to default to.
    expect(rows[0]!.google_calendar_id).toBe('ownertest@gmail.com');
    expect(rows[0]!.gcal_event_id).toBe('760peqpjqopqhsl0mm34au3kf6');
  });

  it('finds the row even when a push moved the invite UID into external_uid', async () => {
    // The shape every already-affected row is in: pushed before this fix, so
    // ical_uid carries Google's UID for our copy and only external_uid still
    // holds the invite's.
    const ev = await inviteEvent();
    await db
      .updateTable('events')
      .set({ ical_uid: 'ourcopy@google.com', external_uid: INVITE_UID })
      .where('id', '=', ev.id)
      .execute();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events')
          ? gjson({
              items: [
                {
                  id: '760peqpjqopqhsl0mm34au3kf6',
                  status: 'confirmed',
                  summary: 'John / Shail Coffee',
                  iCalUID: INVITE_UID,
                  start: { dateTime: start },
                  end: { dateTime: end },
                  updated: new Date().toISOString(),
                  sequence: 0,
                },
              ],
              nextSyncToken: 'tok1',
            })
          : gjson({}),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'ownertest@gmail.com', 'fake-token');

    expect(result.inserted).toBe(0);
    expect(result.applied).toBe(1);
  });

  it('an ordinary event still pushes — the flag is what stops it, not the uid', async () => {
    const ev = await createEvent(db, {
      groupId,
      createdBy: userId,
      title: 'School concert',
      startsAt: start,
      // An imported .ics carries a bare RFC-5545 UID too, and that calendar
      // really is only in Chord — it must still reach Google.
      externalUid: 'imported-uid@school.example',
      googleCalendarId: 'family@group.calendar.google.com',
    });
    const r = await row(ev.id);

    expect(r.local_dirty).toBe(1);
    expect(r.google_calendar_id).toBe('family@group.calendar.google.com');
  });
});
