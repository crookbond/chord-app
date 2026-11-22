/**
 * A device calendar is never a Google push target (ADR 0136).
 *
 * The prod shape this reproduces: a phone that mirrors a Google calendar
 * produces TWO `calendar_sources` rows with the same summary — one `google`,
 * one `device` whose `google_calendar_id` is an EventKit identifier. Matching
 * on name alone returned the device id, Google 404'd `events.insert`, and four
 * events reached no calendar at all while looking fine in Chord.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  matchCalendarByName,
  matchCalendarsByName,
  resolveTargetCalendarId,
} from '@/services/calendar-sources.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

/** The real one, from ownertest@gmail.com's prod row. */
const DEVICE_ID = 'BEE3A1B0-7D3E-4E0B-B6CC-5A95D6148DDF';
const GOOGLE_ID = 'family07746485221481824228@group.calendar.google.com';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function addSource(opts: {
  provider: 'google' | 'device';
  id: string;
  summary: string;
  role?: string;
  primary?: boolean;
}): Promise<void> {
  await db
    .insertInto('calendar_sources')
    .values({
      id: newId('cs'),
      user_id: userId,
      provider: opts.provider,
      google_calendar_id: opts.id,
      summary: opts.summary,
      access_role: opts.role ?? 'owner',
      is_primary: opts.primary ? 1 : 0,
      selected_in_google: 1,
      counts_for_busy_auto: 1,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .execute();
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'cal-user');
  groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'My Chord',
      kind: 'personal',
      invite_code: 'CALDEV',
      ingest_email: 'caldev@chord.app',
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 0,
      created_at: now,
    })
    .execute();
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('matching a calendar by name', () => {
  it('picks the Google row when a device row shares the name', async () => {
    // Both are writable and both are called "Family". Only one of them is a
    // calendar Google can be asked to insert into.
    await addSource({ provider: 'device', id: DEVICE_ID, summary: 'Family', role: 'writer' });
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });

    expect(await matchCalendarByName(db, userId, 'family')).toBe(GOOGLE_ID);
  });

  it('returns nothing when the ONLY match is a device calendar', async () => {
    // Better no calendar than an id that 404s: the caller falls back to
    // primary, which is a calendar that exists.
    await addSource({ provider: 'device', id: DEVICE_ID, summary: 'Family', role: 'writer' });

    expect(await matchCalendarByName(db, userId, 'family')).toBeNull();
  });

  it('ignores a device row when resolving the primary alias', async () => {
    await addSource({
      provider: 'device',
      id: DEVICE_ID,
      summary: 'John Doe',
      role: 'writer',
      primary: true,
    });

    expect(await matchCalendarByName(db, userId, 'personal')).toBe('primary');
  });

  it('still matches an ordinary Google calendar', async () => {
    await addSource({ provider: 'google', id: 'work@example.com', summary: 'Work' });

    expect(await matchCalendarByName(db, userId, 'work')).toBe('work@example.com');
  });
});

describe('a remembered user default', () => {
  const setUserDefault = (id: string) =>
    db.updateTable('users').set({ default_calendar_id: id }).where('id', '=', userId).execute();

  it('is ignored once it points at a device calendar', async () => {
    // The prod failure: the bad id was cached as a default, so every later
    // event inherited it. Re-checking is what stops one bad resolution
    // becoming permanent.
    await addSource({ provider: 'device', id: DEVICE_ID, summary: 'Family', role: 'writer' });
    await setUserDefault(DEVICE_ID);

    expect(await resolveTargetCalendarId(db, { userId })).toEqual({
      calendarId: 'primary',
      source: 'primary',
    });
  });

  it('is honoured when it points at a Google calendar', async () => {
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });
    await setUserDefault(GOOGLE_ID);

    expect(await resolveTargetCalendarId(db, { userId })).toEqual({
      calendarId: GOOGLE_ID,
      source: 'user',
    });
  });

  it('is honoured for an id the sources list has not caught up with', async () => {
    // Unknown is not invalid — a calendar added in Google a minute ago is
    // still Google's. Only a known device id is refused.
    await setUserDefault('brand-new@group.calendar.google.com');

    expect((await resolveTargetCalendarId(db, { userId })).source).toBe('user');
  });

  it('with nothing set, personal is the default: primary', async () => {
    expect(await resolveTargetCalendarId(db, { userId })).toEqual({
      calendarId: 'primary',
      source: 'primary',
    });
  });
});

describe('a group no longer has a default calendar (ADR 0232)', () => {
  it('a default stored on the group before this change is ignored entirely', async () => {
    // Prod: a calendar named once was remembered for the whole group, so every
    // later event in it — flights included — went there. Rows written by that
    // behaviour are still in the table; they must stop mattering.
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });
    await db
      .updateTable('groups')
      .set({ default_calendar_id: GOOGLE_ID })
      .where('id', '=', groupId)
      .execute();

    expect(await resolveTargetCalendarId(db, { userId })).toEqual({
      calendarId: 'primary',
      source: 'primary',
    });
  });
});

describe('two calendars with the same name (ADR 0137)', () => {
  it('picks the owned calendar rather than a coin flip', async () => {
    await addSource({ provider: 'google', id: 'shared@x.example', summary: 'Family', role: 'writer' });
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family', role: 'owner' });

    expect(await matchCalendarByName(db, userId, 'family')).toBe(GOOGLE_ID);
  });

  it('asks when both are merely shared, rather than guessing', async () => {
    // Nothing distinguishes them, and the guess would be cached as the
    // group default - so the coin flip would become permanent.
    await addSource({ provider: 'google', id: 'a@x.example', summary: 'Family', role: 'writer' });
    await addSource({ provider: 'google', id: 'b@x.example', summary: 'Family', role: 'writer' });

    const m = await matchCalendarsByName(db, userId, 'family');

    expect(m.calendarId).toBeNull();
    expect(m.candidates?.map((c) => c.calendarId).sort()).toEqual(['a@x.example', 'b@x.example']);
  });

  it('asks rather than guessing on a loose match over several names', async () => {
    // "family" over "Family Trips" and "Family Photos" has no defensible winner.
    await addSource({ provider: 'google', id: 't@x.example', summary: 'Family Trips' });
    await addSource({ provider: 'google', id: 'p@x.example', summary: 'Family Photos' });

    expect((await matchCalendarsByName(db, userId, 'family')).candidates).toHaveLength(2);
  });

  it('an exact match still beats a loose one', async () => {
    await addSource({ provider: 'google', id: 't@x.example', summary: 'Family Trips' });
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });

    expect(await matchCalendarByName(db, userId, 'family')).toBe(GOOGLE_ID);
  });

  it('is stable: the same question gets the same answer', async () => {
    // The bug this replaces was row order out of Postgres deciding, which
    // changes as rows move.
    await addSource({ provider: 'google', id: 'zzz@x.example', summary: 'Work', role: 'writer' });
    await addSource({ provider: 'google', id: 'aaa@x.example', summary: 'Work', role: 'writer' });

    const first = await matchCalendarsByName(db, userId, 'work');
    const again = await matchCalendarsByName(db, userId, 'work');

    expect(first.candidates?.map((c) => c.calendarId)).toEqual(
      again.candidates?.map((c) => c.calendarId),
    );
  });

  it('an ambiguous request does not silently become the default', async () => {
    await addSource({ provider: 'google', id: 'a@x.example', summary: 'Family', role: 'writer' });
    await addSource({ provider: 'google', id: 'b@x.example', summary: 'Family', role: 'writer' });

    const pick = await resolveTargetCalendarId(db, {
      userId,
      requestedName: 'family',
    });

    expect(pick.candidates).toHaveLength(2);
    expect(pick.source).not.toBe('requested');
  });
});

describe('a requested name matching nothing (ADR 0182)', () => {
  it('does not silently fall back to the user default', async () => {
    // Prod: "add to personal" landed on Family. A cached default was Family;
    // a name that matched no calendar and no alias fell straight through to
    // that default.
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });
    await db.updateTable('users').set({ default_calendar_id: GOOGLE_ID }).where('id', '=', userId).execute();

    const pick = await resolveTargetCalendarId(db, {
      userId,
      requestedName: 'soccer carpool',
    });

    expect(pick.calendarId).toBe('primary');
    expect(pick.source).toBe('primary');
    expect(pick.requestedNotFound).toBe('soccer carpool');

    // The prod wording itself, "personal calendar", is a way of saying "mine":
    // it is the primary calendar as a REQUEST, not a miss, and never the
    // cached Family default.
    const mine = await resolveTargetCalendarId(db, { userId, requestedName: 'personal calendar' });
    expect(mine.calendarId).toBe('primary');
    expect(mine.source).toBe('requested');
    expect(mine.requestedNotFound).toBeUndefined();
  });

  it('the bare alias still resolves correctly (unaffected by the fix)', async () => {
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });
    await db.updateTable('users').set({ default_calendar_id: GOOGLE_ID }).where('id', '=', userId).execute();

    const pick = await resolveTargetCalendarId(db, { userId, requestedName: 'personal' });

    expect(pick.source).toBe('requested');
    expect(pick.requestedNotFound).toBeUndefined();
  });

  it('no requested name at all honors the user default', async () => {
    await addSource({ provider: 'google', id: GOOGLE_ID, summary: 'Family' });
    await db.updateTable('users').set({ default_calendar_id: GOOGLE_ID }).where('id', '=', userId).execute();

    const pick = await resolveTargetCalendarId(db, { userId, requestedName: null });

    expect(pick).toEqual({ calendarId: GOOGLE_ID, source: 'user' });
  });
});
