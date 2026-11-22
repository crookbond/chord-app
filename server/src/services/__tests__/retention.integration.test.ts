/**
 * ADR 0226 — what the daily prune removes, and what it must leave alone.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { syncDeviceCalendar } from '@/services/device-calendar.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  __resetRetentionForTests,
  maybePruneOldRows,
  pruneOldRows,
} from '@/services/retention.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-04T12:00:00.000Z');
const daysAgo = (n: number): string => new Date(NOW.getTime() - n * DAY_MS).toISOString();

describe('retention prune (ADR 0226)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    __resetRetentionForTests();
    db = await openTestDb();
    userId = await createUser(db, 'keeper');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function proactive(firedDaysAgo: number | null, scheduledDaysAgo = 40): Promise<string> {
    const id = newId('pm');
    await db
      .insertInto('proactive_messages')
      .values({
        id,
        group_id: groupId,
        persona_id: userId,
        kind: 'task_remind',
        payload: '{}',
        scheduled_for: daysAgo(scheduledDaysAgo),
        fired_at: firedDaysAgo === null ? null : daysAgo(firedDaysAgo),
        created_at: daysAgo(scheduledDaysAgo),
      })
      .execute();
    return id;
  }

  async function proposal(
    status: 'pending' | 'confirmed' | 'rejected' | 'expired',
    resolvedDaysAgo: number | null,
    createdDaysAgo = 60,
  ): Promise<string> {
    const id = newId('prop');
    await db
      .insertInto('proposals')
      .values({
        id,
        group_id: groupId,
        proposed_by_user_id: userId,
        proposed_by_message_id: null,
        tool_name: 'create_task',
        args_json: '{"title":"x"}',
        provenance: null,
        target_group_id: null,
        status,
        resolved_by_user_id: null,
        resolved_by_message_id: null,
        resolved_at: resolvedDaysAgo === null ? null : daysAgo(resolvedDaysAgo),
        bundle_id: null,
        expires_at: daysAgo(createdDaysAgo - 3),
        created_at: daysAgo(createdDaysAgo),
      })
      .execute();
    return id;
  }

  async function usage(createdDaysAgo: number): Promise<string> {
    const id = newId('tok');
    await db
      .insertInto('token_usage')
      .values({
        id,
        user_id: userId,
        source: 'bot_turn',
        ref: id,
        model: 'm',
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        created_at: daysAgo(createdDaysAgo),
      })
      .execute();
    return id;
  }

  const ids = async (table: 'proactive_messages' | 'proposals' | 'token_usage'): Promise<string[]> =>
    (await db.selectFrom(table).select('id').execute()).map((r) => r.id).sort();

  it('removes a fired message after 30 days, and never one still waiting to fire', async () => {
    const old = await proactive(31);
    const recent = await proactive(29);
    // Scheduled long ago and never fired: still owed, however old.
    const pending = await proactive(null, 90);

    const out = await pruneOldRows(db, NOW);

    expect(out.proactiveMessages).toBe(1);
    expect(await ids('proactive_messages')).toEqual([recent, pending].sort());
    expect(await ids('proactive_messages')).not.toContain(old);
  });

  it('removes a rejected proposal after 15 days and an expired one after 30', async () => {
    const rejectedOld = await proposal('rejected', 16);
    const rejectedRecent = await proposal('rejected', 14);
    const expiredOld = await proposal('expired', 31);
    const expiredRecent = await proposal('expired', 20);

    const out = await pruneOldRows(db, NOW);

    expect(out).toMatchObject({ rejectedProposals: 1, expiredProposals: 1 });
    const left = await ids('proposals');
    expect(left).toEqual([rejectedRecent, expiredRecent].sort());
    expect(left).not.toContain(rejectedOld);
    expect(left).not.toContain(expiredOld);
  });

  it('keeps what the user approved, and anything still pending, whatever its age', async () => {
    const confirmed = await proposal('confirmed', 400, 401);
    const pending = await proposal('pending', null, 400);

    await pruneOldRows(db, NOW);

    expect(await ids('proposals')).toEqual([confirmed, pending].sort());
  });

  it('dates a resolved proposal with no resolved time by when it was created', async () => {
    const old = await proposal('rejected', null, 40);
    const recent = await proposal('rejected', null, 5);

    await pruneOldRows(db, NOW);

    expect(await ids('proposals')).toEqual([recent]);
    expect(await ids('proposals')).not.toContain(old);
  });

  it('keeps a year of token usage, so the current billing period is never touched', async () => {
    const old = await usage(366);
    const lastMonth = await usage(40);
    const today = await usage(0);

    const out = await pruneOldRows(db, NOW);

    expect(out.tokenUsage).toBe(1);
    expect(await ids('token_usage')).toEqual([lastMonth, today].sort());
    expect(await ids('token_usage')).not.toContain(old);
  });

  async function event(externalUid: string | null, deletedDaysAgo: number | null, startsDaysAgo = 400): Promise<string> {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        group_ids: '[]',
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Hillcrest/Lakeside Gr 7 MSA Trivia Night',
        starts_at: daysAgo(startsDaysAgo),
        external_uid: externalUid,
        ical_uid: newId('u'),
        status: deletedDaysAgo === null ? 'confirmed' : 'cancelled',
        deleted_at: deletedDaysAgo === null ? null : daysAgo(deletedDaysAgo),
        created_by: userId,
        created_at: daysAgo(startsDaysAgo + 10),
        updated_at: daysAgo(startsDaysAgo + 10),
      })
      .execute();
    return id;
  }

  it('removes a deleted phone-calendar row 30 days after deletion, and keeps past events', async () => {
    const PHONE = 'device:64EF5A14-4F41-4CFF-952F-9D22439B4AE8:';
    const goneLongAgo = await event(`${PHONE}E524A43F`, 31);
    const goneRecently = await event(`${PHONE}F0A9F5C8`, 29);
    // Past but never deleted: the family's history stays.
    const pastLive = await event(`${PHONE}A1B2C3D4`, null, 400);
    // A deleted row from another source is outside this rule.
    const googleTombstone = await event('gcal:primary:abc', 90);
    const chordPast = await event(null, null, 900);

    const out = await pruneOldRows(db, NOW);

    expect(out.deletedDeviceEvents).toBe(1);
    const left = (await db.selectFrom('events').select('id').execute()).map((r) => r.id).sort();
    expect(left).toEqual([goneRecently, pastLive, googleTombstone, chordPast].sort());
    expect(left).not.toContain(goneLongAgo);
  });

  it('keeps a kind forever when its window is 0', async () => {
    const saved = env.RETENTION_TOKEN_USAGE_DAYS;
    (env as { RETENTION_TOKEN_USAGE_DAYS: number }).RETENTION_TOKEN_USAGE_DAYS = 0;
    try {
      const old = await usage(5000);

      await pruneOldRows(db, NOW);

      expect(await ids('token_usage')).toEqual([old]);
    } finally {
      (env as { RETENTION_TOKEN_USAGE_DAYS: number }).RETENTION_TOKEN_USAGE_DAYS = saved;
    }
  });

  it('runs once a day from the tick, not on every tick', async () => {
    await usage(366);

    expect((await maybePruneOldRows(db, NOW))?.tokenUsage).toBe(1);
    await usage(366);
    expect(await maybePruneOldRows(db, new Date(NOW.getTime() + 15_000))).toBeNull();
    expect((await maybePruneOldRows(db, new Date(NOW.getTime() + DAY_MS)))?.tokenUsage).toBe(1);
  });
});

/**
 * ADR 0057 addendum — prod, user u_chK1eNNjxBn4: the phone stopped sending
 * "Family" and "John Doe" on 2026-10-15 while it kept sending the others,
 * and both kept their Settings row and mirrored events. One mirrored row on
 * each had since been adopted by the Google pull (it carries
 * google_calendar_id), so it is the server's copy of that event now.
 */
describe('forgetting a phone calendar the phone stopped sending (ADR 0057 addendum)', () => {
  const FAMILY = 'D1EA7BE6-7DAF-4132-9376-CE71D74C4475';
  const JOHN = '2D11E532-5C4C-4527-9087-E2814239EBD2';
  const WORK = '9C4F1D2A-1B7E-4E61-A0C3-5E2B8F6D7A10';
  const RECENT = '6B0E3C77-28A4-4F0E-9D5B-0A1C2E3F4B56';
  const LAST_SEEN_STALE = '2026-10-15T23:13:58.000Z';
  const LAST_SEEN_FRESH = '2026-11-02T09:00:00.000Z';
  // 33 days after the stale calendars were last sent.
  const PRUNE_AT = new Date('2026-11-17T12:00:00.000Z');
  const seenDaysBefore = (n: number): string =>
    new Date(PRUNE_AT.getTime() - n * DAY_MS).toISOString();

  let db: Kysely<DB>;
  let userId: string;
  let otherId: string;

  beforeEach(async () => {
    __resetRetentionForTests();
    db = await openTestDb();
    userId = await createUser(db, 'john');
    otherId = await createUser(db, 'someone-else');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  const cal = (deviceCalendarId: string, title: string) => ({
    deviceCalendarId,
    title,
    allowsModifications: true,
  });
  const ev = (deviceCalendarId: string, deviceEventId: string, title: string, startsAt: string) => ({
    deviceCalendarId,
    deviceEventId,
    title,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 60 * 60 * 1000).toISOString(),
  });

  async function setLastSeen(user: string, calId: string, at: string): Promise<void> {
    await db
      .updateTable('calendar_sources')
      .set({ last_seen_at: at })
      .where('user_id', '=', user)
      .where('google_calendar_id', '=', calId)
      .execute();
  }

  const deviceUids = async (user: string): Promise<string[]> =>
    (
      await db
        .selectFrom('events')
        .select('external_uid')
        .where('owner_user_id', '=', user)
        .execute()
    )
      .map((r) => r.external_uid ?? '')
      .sort();

  const sources = async (user: string): Promise<string[]> =>
    (
      await db
        .selectFrom('calendar_sources')
        .select('google_calendar_id')
        .where('user_id', '=', user)
        .execute()
    )
      .map((r) => r.google_calendar_id)
      .sort();

  async function seed(): Promise<void> {
    await syncDeviceCalendar(db, userId, {
      calendars: [cal(FAMILY, 'Family'), cal(JOHN, 'John Doe'), cal(WORK, 'Work'), cal(RECENT, 'Kids')],
      events: [
        ev(FAMILY, 'F1', 'Dr Liz', '2026-10-20T14:00:00.000Z'),
        ev(FAMILY, 'F2', 'Piano', '2026-10-21T22:00:00.000Z'),
        ev(FAMILY, 'F3', 'Soccer', '2026-10-22T22:00:00.000Z'),
        ev(FAMILY, 'F4', 'Dinner', '2026-10-23T23:00:00.000Z'),
        ev(JOHN, 'R1', 'Flight to New York (AC 8498)', '2026-10-24T12:00:00.000Z'),
        ev(JOHN, 'R2', 'Haircut', '2026-10-25T16:00:00.000Z'),
        ev(WORK, 'W1', 'Standup', '2026-11-03T14:00:00.000Z'),
        ev(RECENT, 'K1', 'Recital', '2026-11-04T23:00:00.000Z'),
      ],
      windowStart: '2026-09-15T00:00:00.000Z',
      windowEnd: '2026-12-31T00:00:00.000Z',
    });
    // The Google pull adopted these two mirrored rows (ADR 0040 findLocalCopy).
    await db
      .updateTable('events')
      .set({ google_calendar_id: 'ownertest@gmail.com', gcal_event_id: 'g-ac8498' })
      .where('external_uid', '=', `device:${JOHN}:R1`)
      .execute();
    await db
      .updateTable('events')
      .set({ google_calendar_id: 'family-cal@group.calendar.google.com' })
      .where('external_uid', '=', `device:${FAMILY}:F1`)
      .execute();
    await setLastSeen(userId, FAMILY, LAST_SEEN_STALE);
    await setLastSeen(userId, JOHN, LAST_SEEN_STALE);
    await setLastSeen(userId, WORK, LAST_SEEN_FRESH);
    await setLastSeen(userId, RECENT, seenDaysBefore(29));

    // Another user mirrors a calendar with the SAME device id, still sent.
    await syncDeviceCalendar(db, otherId, {
      calendars: [cal(FAMILY, 'Family')],
      events: [ev(FAMILY, 'O1', 'Their thing', '2026-10-26T14:00:00.000Z')],
      windowStart: '2026-09-15T00:00:00.000Z',
      windowEnd: '2026-12-31T00:00:00.000Z',
    });
    await setLastSeen(otherId, FAMILY, LAST_SEEN_FRESH);
  }

  it('forgets a calendar not sent for 30 days and its mirrored events, keeping adopted rows', async () => {
    await seed();

    const out = await pruneOldRows(db, PRUNE_AT);

    expect(await sources(userId)).toEqual([RECENT, WORK].sort());
    expect(await deviceUids(userId)).toEqual(
      [
        `device:${FAMILY}:F1`,
        `device:${JOHN}:R1`,
        `device:${WORK}:W1`,
        `device:${RECENT}:K1`,
      ].sort(),
    );
    // Removed outright: nothing is tombstoned, so nothing is pushed anywhere.
    const tombstones = await db
      .selectFrom('events')
      .select('id')
      .where('deleted_at', 'is not', null)
      .execute();
    expect(tombstones).toEqual([]);
    expect(await sources(otherId)).toEqual([FAMILY]);
    expect(await deviceUids(otherId)).toEqual([`device:${FAMILY}:O1`]);
    expect(out.staleDeviceCalendars).toBe(2);
    expect(out.staleDeviceCalendarEvents).toBe(4);
  });

  it('keeps every phone calendar when the window is 0', async () => {
    await seed();
    const saved = env.RETENTION_DEVICE_CALENDAR_DAYS;
    (env as { RETENTION_DEVICE_CALENDAR_DAYS: number }).RETENTION_DEVICE_CALENDAR_DAYS = 0;
    try {
      await pruneOldRows(db, PRUNE_AT);
      expect(await sources(userId)).toEqual([FAMILY, JOHN, RECENT, WORK].sort());
    } finally {
      (env as { RETENTION_DEVICE_CALENDAR_DAYS: number }).RETENTION_DEVICE_CALENDAR_DAYS = saved;
    }
  });

  it('never forgets a Google calendar, however long since it was seen', async () => {
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: userId,
        provider: 'google',
        google_calendar_id: 'en.usa#holiday@group.v.calendar.google.com',
        summary: 'Holidays in United States',
        access_role: 'reader',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 0,
        counts_for_busy_override: null,
        first_seen_at: '2025-01-01T00:00:00.000Z',
        last_seen_at: '2025-01-01T00:00:00.000Z',
      })
      .execute();

    await pruneOldRows(db, PRUNE_AT);

    expect(await sources(userId)).toEqual(['en.usa#holiday@group.v.calendar.google.com']);
  });
});
