/**
 * ADR 0295 — an event's guests live on the provider event, never in Chord.
 *
 * Chord used to keep its own guest list (`event_attendees`, keyed on the
 * event's `ical_uid`) and re-send it with every push. The first push replaced
 * `ical_uid` with Google's, so later pushes lost the list: a second guest was
 * sent alone and Google (which replaces `attendees` on a patch) un-invited the
 * first, and a time change told nobody. A guest removed in Google came back on
 * the next push. A guest added from Chord to an event made in Google was never
 * sent, while the bot said "invited". There was no way to remove a guest.
 *
 * Each case below is checked against what the fake Google holds.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const soon = (hour = 15): string => {
  const d = new Date(Date.now() + 5 * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hour}:00:00-04:00`;
};

describe('event guests go through the calendar (ADR 0295)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let google: FakeGoogleCalendar;

  const run = async (name: string, args: Record<string, unknown>) => {
    const out = await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      tzOffset: '-04:00',
      call: { name, args } as never,
    });
    await settleBackgroundWork();
    return out;
  };

  const row = (title: string) =>
    db
      .selectFrom('events')
      .select(['id', 'gcal_event_id'])
      .where('title', '=', title)
      .executeTakeFirstOrThrow();

  /** Every event pushed before this change: `markPushed` wrote Google's
   *  iCalUID over the placeholder the old guest list was keyed on. */
  const carryGoogleUid = async (title: string) => {
    const r = await row(title);
    await db
      .updateTable('events')
      .set({ ical_uid: `${r.gcal_event_id}@google.com` })
      .where('id', '=', r.id)
      .execute();
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John Doe');
    await db
      .updateTable('users')
      .set({
        refresh_token_scopes: 'openid https://www.googleapis.com/auth/calendar',
        google_connected_at: new Date().toISOString(),
      })
      .where('id', '=', userId)
      .execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;
    google = installFakeGoogleCalendar();
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  it('adding a second guest after the push keeps the first one invited', async () => {
    const created = await run('create_event', {
      title: 'Meeting with Kevin',
      startsAt: soon(),
      invitees: ['kevin@example.com'],
    });
    expect(created.data).toMatchObject({ invited: ['kevin@example.com'] });
    await carryGoogleUid('Meeting with Kevin');
    const { id, gcal_event_id } = await row('Meeting with Kevin');

    await run('update_event', { eventId: id, invitees: ['priya@example.com'] });

    expect(google.guests(gcal_event_id!)).toEqual(['kevin@example.com', 'priya@example.com']);
    expect(google.patches().at(-1)!.url).toContain('sendUpdates=all');
  });

  it('a later time change keeps the guests and tells them', async () => {
    await run('create_event', { title: 'Meeting with Kevin', startsAt: soon(), invitees: ['kevin@example.com'] });
    await carryGoogleUid('Meeting with Kevin');
    const { id, gcal_event_id } = await row('Meeting with Kevin');

    await run('update_event', { eventId: id, startsAt: soon(16) });
    await pushDirtyEvents(db, userId);

    const last = google.patches().at(-1)!;
    expect(last.url).toContain('sendUpdates=all');
    expect(last.body).not.toHaveProperty('attendees');
    expect(google.guests(gcal_event_id!)).toEqual(['kevin@example.com']);
  });

  it('a guest removed in Google stays removed when Chord later edits the event', async () => {
    await run('create_event', { title: 'Meeting with Kevin', startsAt: soon(), invitees: ['kevin@example.com'] });
    const { id, gcal_event_id } = await row('Meeting with Kevin');
    google.events.get(gcal_event_id!)!.attendees = [];

    await run('update_event', { eventId: id, startsAt: soon(16) });
    await pushDirtyEvents(db, userId);

    expect(google.guests(gcal_event_id!)).toEqual([]);
  });

  it('a guest can be removed from Chord', async () => {
    await run('create_event', {
      title: 'Meeting with Kevin',
      startsAt: soon(),
      invitees: ['kevin@example.com', 'priya@example.com'],
    });
    const { id, gcal_event_id } = await row('Meeting with Kevin');

    const res = await run('update_event', { eventId: id, removeInvitees: ['Kevin@example.com'] });

    expect(res.data).toMatchObject({ removedGuests: ['kevin@example.com'] });
    expect(google.guests(gcal_event_id!)).toEqual(['priya@example.com']);
    expect(google.patches().at(-1)!.url).toContain('sendUpdates=all');
  });

  describe('an event made in Google', () => {
    const insertPulled = async (organizerSelf: boolean) => {
      google.events.set('g_made_in_google', {
        id: 'g_made_in_google',
        etag: '"g-1"',
        iCalUID: 'made-in-google@google.com',
        summary: 'Planning call',
        organizer: organizerSelf ? { self: true } : { email: 'boss@work.test', self: false },
        attendees: organizerSelf ? [] : [{ email: 'john@example.com', self: true, responseStatus: 'accepted' }],
      });
      const now = new Date().toISOString();
      const id = newId('e');
      // As the pull stores it: not Chord-made, so role attendee and no organizer.
      await db
        .insertInto('events')
        .values({
          id,
          group_id: personalId,
          group_ids: '[]',
          owner_user_id: userId,
          organizer_user_id: null,
          role: 'attendee',
          title: 'Planning call',
          starts_at: soon(),
          created_at: now,
          updated_at: now,
          created_by: userId,
          status: 'confirmed',
          sequence: 0,
          local_dirty: 0,
          ical_uid: 'made-in-google@google.com',
          gcal_event_id: 'g_made_in_google',
          google_calendar_id: 'primary',
          etag: '"g-1"',
        })
        .execute();
      return id;
    };

    it('takes a guest added from Chord when the user organizes it', async () => {
      const id = await insertPulled(true);
      const res = await run('update_event', { eventId: id, invitees: ['priya@example.com'] });
      expect(res.data).toMatchObject({ invited: ['priya@example.com'] });
      expect(google.guests('g_made_in_google')).toEqual(['priya@example.com']);
    });

    it('says nobody was invited when someone else organizes it', async () => {
      const id = await insertPulled(false);
      const res = await run('update_event', { eventId: id, invitees: ['priya@example.com'] });
      expect(res.data).toMatchObject({ invited: [], guestChange: 'not_organizer' });
      expect(res.summary).toMatch(/NOBODY was invited/);
      expect(google.patches()).toHaveLength(0);
    });
  });

  it('says nobody was invited when no calendar is connected', async () => {
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: null, google_connected_at: null })
      .where('id', '=', userId)
      .execute();
    const res = await run('create_event', {
      title: 'Meeting with Kevin',
      startsAt: soon(),
      invitees: ['kevin@example.com'],
    });
    expect(res.data).toMatchObject({ invited: [], guestChange: 'not_on_calendar' });
    expect(res.summary).toMatch(/NOBODY was invited/);
    expect(res.summary).not.toMatch(/· invited kevin/);
  });
});
