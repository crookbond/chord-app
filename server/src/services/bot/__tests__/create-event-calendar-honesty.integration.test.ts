/**
 * ADR 0182 — the bot must report the calendar an event actually landed on,
 * not echo the user's own request. Prod: "add to personal" was answered
 * "added to your personal calendar" while the event actually landed on the
 * group's cached "Family" default, because create_event's tool result never
 * said which calendar was used at all — the model had nothing to go on but
 * the user's own words.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const GOOGLE_ID = 'family07746485221481824228@group.calendar.google.com';

describe('create_event states the real calendar (ADR 0182)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  const soon = (): string => {
    const d = new Date(Date.now() + 5 * 86400000);
    return `${d.toISOString().slice(0, 10)}T09:00:00-04:00`;
  };

  const create = (args: Record<string, unknown>) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      tzOffset: '-04:00',
      call: { name: 'create_event', args },
    });

  beforeEach(async () => {
    db = await openTestDb();
    userId = newId('u');
    groupId = newId('g');
    const now = new Date().toISOString();
    await db
      .insertInto('users')
      .values({
        id: userId,
        username: 'ro',
        display_name: 'Ro',
        created_at: now,
        shadow: 0,
        // A live Google connection: the calendar named in the reply is only
        // true when the event can reach it.
        refresh_token_scopes: 'openid https://www.googleapis.com/auth/calendar',
        google_connected_at: now,
      })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Fam',
        kind: 'group',
        invite_code: 'XCAL1',
        ingest_email: 'fam-cal@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
        default_calendar_id: GOOGLE_ID,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({ group_id: groupId, user_id: userId, role: 'owner', tier: 'verified', joined_at: now })
      .execute();
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: userId,
        provider: 'google',
        google_calendar_id: GOOGLE_ID,
        summary: 'Family',
        access_role: 'owner',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 1,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('says which calendar was actually used when the requested name matches nothing', async () => {
    const res = await create({
      title: 'Appointment at Lenox Hill Radiology',
      startsAt: soon(),
      calendar: 'soccer carpool',
    });

    expect(res.summary).toMatch(/could not find a calendar named "soccer carpool"/i);
    expect(res.summary).toMatch(/used your primary calendar instead/i);

    const row = await db
      .selectFrom('events')
      .select('google_calendar_id')
      .where('group_id', '=', groupId)
      .where('title', '=', 'Appointment at Lenox Hill Radiology')
      .where('owner_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.google_calendar_id).not.toBe(GOOGLE_ID);
  });

  // "personal calendar" was this ADR's original unmatched name. It is a way of
  // saying "mine", so it now IS the primary calendar rather than a miss.
  it('"personal calendar" is the primary calendar, with no could-not-find note', async () => {
    const res = await create({ title: 'Radiology follow-up', startsAt: soon(), calendar: 'personal calendar' });

    expect(res.summary).toMatch(/added to your primary calendar/i);
    expect(res.summary).not.toMatch(/could not find a calendar/i);
  });

  it('names the real destination even on a clean match, so the model cannot substitute the user’s wording', async () => {
    const res = await create({ title: 'Team sync', startsAt: soon(), calendar: 'family' });

    expect(res.summary).toMatch(/added to your Family calendar/i);
  });

  it('with no calendar named, a default stored on the group by the old behaviour is ignored (ADR 0232)', async () => {
    // beforeEach leaves GOOGLE_ID on the group, exactly as the old
    // "remember what was named once" behaviour did.
    const res = await create({ title: 'Dinner', startsAt: soon() });

    expect(res.summary).toMatch(/added to your primary calendar/i);
    const row = await db
      .selectFrom('events')
      .select('google_calendar_id')
      .where('group_id', '=', groupId)
      .where('title', '=', 'Dinner')
      .where('owner_user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.google_calendar_id).toBe('primary');
  });

  it('with no calendar named, the user\'s OWN default is what is used and stated', async () => {
    await db.updateTable('users').set({ default_calendar_id: GOOGLE_ID }).where('id', '=', userId).execute();
    const res = await create({ title: 'Dinner', startsAt: soon() });

    expect(res.summary).toMatch(/added to your Family calendar/i);
  });

  it('naming a calendar applies to THAT event only — the group remembers nothing', async () => {
    await db.updateTable('groups').set({ default_calendar_id: null }).where('id', '=', groupId).execute();

    const named = await create({ title: 'Team sync', startsAt: soon(), calendar: 'family' });
    expect(named.summary).toMatch(/added to your Family calendar/i);

    const next = await create({ title: 'Flight to Lisbon', startsAt: soon() });
    expect(next.summary).toMatch(/added to your primary calendar/i);

    const g = await db.selectFrom('groups').select('default_calendar_id').where('id', '=', groupId).executeTakeFirstOrThrow();
    expect(g.default_calendar_id).toBeNull();
  });

  describe('when the event cannot reach Google', () => {
    // Prod, 2026-10-04: a user's Google grant was refused at 01:12 UTC (seven
    // days after she connected). At 16:46 she asked for "Josh Brooks's Bar
    // Mitzvah"; the row was saved with local_dirty = 1 and never pushed, and
    // she looked for it in Google and on her phone.
    const disconnect = async (): Promise<void> => {
      // What `invalid_grant` leaves behind: no token, no scopes, the old
      // connection date.
      await db
        .updateTable('users')
        .set({ refresh_token_scopes: null })
        .where('id', '=', userId)
        .execute();
    };

    it('says it is in Chord only when the Google connection has expired', async () => {
      await disconnect();

      const res = await create({ title: "Josh Brooks's Bar Mitzvah", startsAt: soon() });

      expect(res.summary).not.toMatch(/added to your/i);
      expect(res.summary).toMatch(/saved in Chord ONLY/);
      expect(res.summary).toMatch(/connection has expired/i);
      expect(res.summary).toMatch(/reconnect Google/i);
    });

    it('still saves the event and leaves it queued to push after a reconnect', async () => {
      await disconnect();

      await create({ title: "Josh Brooks's Bar Mitzvah", startsAt: soon() });

      const row = await db
        .selectFrom('events')
        .select(['local_dirty', 'gcal_event_id'])
        .where('owner_user_id', '=', userId)
        .where('title', '=', "Josh Brooks's Bar Mitzvah")
        .executeTakeFirstOrThrow();
      expect(row.local_dirty).toBe(1);
      expect(row.gcal_event_id).toBeNull();
    });

    it('does not claim a calendar for someone who never connected Google', async () => {
      await db
        .updateTable('users')
        .set({ refresh_token_scopes: null, google_connected_at: null })
        .where('id', '=', userId)
        .execute();

      const res = await create({ title: 'Dinner', startsAt: soon() });

      expect(res.summary).not.toMatch(/added to your/i);
      expect(res.summary).toMatch(/no Google Calendar is connected/i);
      // Nothing to reconnect, so nothing to urge.
      expect(res.summary).not.toMatch(/reconnect/i);
    });
  });
});
