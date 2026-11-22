/**
 * Group-chat calendar scoping. In a non-personal group context the bot
 * may only see events from the user's Chord-target ("Family") Google
 * calendar — never primary or other personal calendars.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  createEvent,
  listEventsForUser,
  listEventsForUserFromChordCalendar,
} from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function setGoogleCal(
  db: Kysely<DB>,
  userId: string,
  calId: string | null,
  email: string | null = null,
): Promise<void> {
  await db
    .updateTable('users')
    .set({ google_calendar_id: calId, email })
    .where('id', '=', userId)
    .execute();
}

describe('listEventsForUserFromChordCalendar (group-chat scoping)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns [] when the user has no google_calendar_id yet', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Personal', kind: 'group', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'Whatever',
      startsAt: '2026-06-01T10:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:abc:evt1',
    });
    const scoped = await listEventsForUserFromChordCalendar(db, uid, { pastDays: 3650, futureDays: 3650 });
    expect(scoped).toEqual([]);
  });

  it('includes events from the Family secondary cal, excludes others', async () => {
    const uid = await createUser(db, 'alice');
    await setGoogleCal(db, uid, 'family@group.calendar.google.com');
    const group = await createGroup(db, { name: 'Personal', kind: 'group', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'Family dinner',
      startsAt: '2026-06-01T18:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:family@group.calendar.google.com:evt-fam',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Work standup',
      startsAt: '2026-06-01T09:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:work@group.calendar.google.com:evt-work',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Primary doc appt',
      startsAt: '2026-06-01T14:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:evt-primary',
    });
    const scoped = await listEventsForUserFromChordCalendar(db, uid, { pastDays: 3650, futureDays: 3650 });
    expect(scoped.map((e) => e.title)).toEqual(['Family dinner']);
  });

  it('includes bare-prefix events when Family IS the primary calendar', async () => {
    const uid = await createUser(db, 'alice');
    await setGoogleCal(db, uid, 'alice@example.com', 'alice@example.com');
    const group = await createGroup(db, { name: 'Personal', kind: 'group', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'On primary',
      startsAt: '2026-06-01T09:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:evt-1',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'On other secondary',
      startsAt: '2026-06-01T10:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:other@group.calendar.google.com:evt-2',
    });
    const scoped = await listEventsForUserFromChordCalendar(db, uid, { pastDays: 3650, futureDays: 3650 });
    expect(scoped.map((e) => e.title)).toEqual(['On primary']);
  });

  it('excludes Chord-native events (no external_uid) — default deny', async () => {
    const uid = await createUser(db, 'alice');
    await setGoogleCal(db, uid, 'family@group.calendar.google.com');
    const group = await createGroup(db, { name: 'Personal', kind: 'group', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'Chord-only event',
      startsAt: '2026-06-01T18:00:00Z',
      createdBy: uid,
    });
    const scoped = await listEventsForUserFromChordCalendar(db, uid, { pastDays: 3650, futureDays: 3650 });
    expect(scoped).toEqual([]);
  });

  it('listEventsForUser still returns everything (personal-chat path)', async () => {
    const uid = await createUser(db, 'alice');
    await setGoogleCal(db, uid, 'family@group.calendar.google.com');
    const group = await createGroup(db, { name: 'Personal', kind: 'group', createdBy: uid });
    await createEvent(db, {
      groupId: group.id,
      title: 'Family dinner',
      startsAt: '2026-06-01T18:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:family@group.calendar.google.com:evt-fam',
    });
    await createEvent(db, {
      groupId: group.id,
      title: 'Work standup',
      startsAt: '2026-06-01T09:00:00Z',
      createdBy: uid,
      externalUid: 'gcal:work@group.calendar.google.com:evt-work',
    });
    const full = await listEventsForUser(db, uid, { pastDays: 3650, futureDays: 3650 });
    expect(full.map((e) => e.title).sort()).toEqual(['Family dinner', 'Work standup']);
  });
});
