/**
 * Prod, 2026-11-11: "add to Neural Calendar - Call with Gautam @ A91 at 830a.
 * Teams meeting." The model called create_event with title, start and
 * location but no `calendar`, so the event went to the default calendar.
 * The calendar the user named in their own message is now used, and a name
 * said with the word "calendar" ("Neural Calendar") finds the calendar
 * called "Neural".
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

const NEURAL_ID = 'neural0123456789@group.calendar.google.com';
const PROD_MESSAGE = 'add to Neural Calendar - Call with Gautam @ A91 at 830a. Teams meeting.';

describe('create_event uses the calendar the user named', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  const soon = (): string => {
    const d = new Date(Date.now() + 5 * 86400000);
    return `${d.toISOString().slice(0, 10)}T08:30:00-05:00`;
  };

  const say = async (body: string): Promise<string> => {
    const id = newId('m');
    await db
      .insertInto('messages')
      .values({
        id,
        group_id: groupId,
        sender_id: userId,
        kind: 'text',
        body,
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        is_proactive: 0,
      })
      .execute();
    return id;
  };

  const create = (args: Record<string, unknown>, triggeringMessageId?: string) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      turnId: 'turn-1',
      tzOffset: '-05:00',
      triggeringMessageId,
      call: { name: 'create_event', args },
    });

  const calendarOf = async (title: string): Promise<string | null> =>
    (
      await db
        .selectFrom('events')
        .select('google_calendar_id')
        .where('title', '=', title)
        .where('owner_user_id', '=', userId)
        .executeTakeFirstOrThrow()
    ).google_calendar_id;

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
        refresh_token_scopes: 'openid https://www.googleapis.com/auth/calendar',
        google_connected_at: now,
      })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: groupId,
        name: 'Ro',
        kind: 'personal',
        invite_code: 'XNEUR1',
        ingest_email: 'ro-neural@chord.app',
        created_by: userId,
        adults_only: 0,
        mirror_inbound: 0,
        created_at: now,
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
        google_calendar_id: NEURAL_ID,
        summary: 'Neural',
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

  it('the prod message: the model left out `calendar`, the event still goes to Neural', async () => {
    const trigger = await say(PROD_MESSAGE);
    // Exactly the args the model sent in prod.
    const res = await create(
      { title: 'Call with Gautam @ A91', startsAt: soon(), location: 'Teams meeting' },
      trigger,
    );

    expect(res.summary).toMatch(/added to your Neural calendar/i);
    expect(await calendarOf('Call with Gautam @ A91')).toBe(NEURAL_ID);
  });

  it('"Neural Calendar" passed by the model finds the calendar called "Neural"', async () => {
    const res = await create({ title: 'Call with Gautam', startsAt: soon(), calendar: 'Neural Calendar' });

    expect(res.summary).toMatch(/added to your Neural calendar/i);
    expect(res.summary).not.toMatch(/could not find/i);
    expect(await calendarOf('Call with Gautam')).toBe(NEURAL_ID);
  });

  it('a calendar the message names that does not exist changes nothing and adds no note', async () => {
    const trigger = await say('put it on the soccer calendar - practice at 5pm');
    const res = await create({ title: 'Practice', startsAt: soon() }, trigger);

    expect(res.summary).toMatch(/added to your primary calendar/i);
    expect(res.summary).not.toMatch(/could not find/i);
  });

  it('no calendar named in the message keeps the default', async () => {
    const trigger = await say('lunch with Sam tomorrow at noon');
    const res = await create({ title: 'Lunch with Sam', startsAt: soon() }, trigger);

    expect(res.summary).toMatch(/added to your primary calendar/i);
  });

  it('a calendar the model did pass wins over one read from the message', async () => {
    const trigger = await say('add to Neural Calendar - dentist at 3');
    const res = await create({ title: 'Dentist', startsAt: soon(), calendar: 'personal' }, trigger);

    expect(res.summary).toMatch(/added to your primary calendar/i);
  });
  it('a Teams meeting asked for on a Google calendar is refused, never swapped for a Meet', async () => {
    const trigger = await say('add to Neural Calendar - Call with Gautam at 830a. Teams meeting.');
    const res = await create({ title: 'Call with Gautam', startsAt: soon(), location: 'Teams meeting' }, trigger);

    expect(res.summary).toMatch(/NO video call link was added: the user asked for a Teams meeting/);
    expect(res.summary).not.toMatch(/added a Google Meet/);
  });
});
