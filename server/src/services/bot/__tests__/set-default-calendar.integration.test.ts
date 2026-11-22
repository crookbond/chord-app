/**
 * ADR 0256 — "my default calendar is Family". `users.default_calendar_id` was
 * read by every event create but nothing outside tests ever wrote it, so a
 * user saying it in chat changed nothing. The tool and Settings share one
 * writer, `setDefaultCalendar`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { resolveTargetCalendarId, setDefaultCalendar } from '@/services/calendar-sources.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const FAMILY_ID = 'family07746485221481824228@group.calendar.google.com';
const PRIMARY_ID = 'ownertest@gmail.com';
const DEVICE_ID = 'BEE3A1B0-7D3E-4E0B-B6CC-5A95D6148DDF';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function addSource(opts: {
  provider?: 'google' | 'device' | 'outlook';
  id: string;
  summary: string;
  role?: string;
  primary?: boolean;
}): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('calendar_sources')
    .values({
      id: newId('cs'),
      user_id: userId,
      provider: opts.provider ?? 'google',
      google_calendar_id: opts.id,
      summary: opts.summary,
      access_role: opts.role ?? 'owner',
      is_primary: opts.primary ? 1 : 0,
      selected_in_google: 1,
      counts_for_busy_auto: 1,
      first_seen_at: now,
      last_seen_at: now,
    })
    .execute();
}

async function storedDefault(): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select('default_calendar_id')
    .where('id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.default_calendar_id ?? null;
}

function say(calendar?: string) {
  return applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: null,
    call: { name: 'set_default_calendar', args: calendar === undefined ? {} : { calendar } },
  });
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john', 'John Doe');
  groupId = (await createGroup(db, { name: 'John', kind: 'personal', createdBy: userId })).id;
  await addSource({ id: PRIMARY_ID, summary: 'John Doe', primary: true });
  await addSource({ id: FAMILY_ID, summary: 'Family' });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('set_default_calendar tool', () => {
  it('stores the named calendar, and later events with no calendar named go there', async () => {
    const res = await say('Family');

    expect(res.data).toMatchObject({ ok: true, calendarId: FAMILY_ID, label: 'Family' });
    expect(await storedDefault()).toBe(FAMILY_ID);
    expect(await resolveTargetCalendarId(db, { userId })).toEqual({
      calendarId: FAMILY_ID,
      source: 'user',
    });
  });

  it('"primary" and an empty string both reset to the primary', async () => {
    await say('Family');
    expect((await say('primary')).data).toMatchObject({ ok: true, calendarId: null });
    expect(await storedDefault()).toBeNull();

    await say('Family');
    expect((await say('')).data).toMatchObject({ ok: true, calendarId: null });
    expect(await storedDefault()).toBeNull();
  });

  it('naming the primary calendar itself also clears rather than storing its id', async () => {
    await say('Family');
    await say('John Doe');
    expect(await storedDefault()).toBeNull();
  });

  it('asks instead of guessing when the name fits several calendars', async () => {
    await addSource({ id: 'trips@group.calendar.google.com', summary: 'Family Trips' });
    await say('Family');

    const res = await say('fam');

    expect(res.data).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect((res.data as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect(await storedDefault()).toBe(FAMILY_ID);
  });

  it('writes nothing for a name that matches no calendar', async () => {
    await say('Family');
    const res = await say('Soccer');

    expect(res.data).toEqual({ ok: false, reason: 'not_found' });
    expect(res.card).toBeUndefined();
    expect(await storedDefault()).toBe(FAMILY_ID);
  });

  it('with no calendar given, reads the current default without changing it', async () => {
    await say('Family');
    const res = await say();

    expect(res.data).toMatchObject({ ok: true, read: true, calendarId: FAMILY_ID, label: 'Family' });
    expect(await storedDefault()).toBe(FAMILY_ID);
  });

  it('is offered in the personal chat only', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('set_default_calendar')).toBe(true);
  });
});

describe('setDefaultCalendar by id (the Settings path)', () => {
  it('refuses a device calendar (ADR 0136)', async () => {
    await addSource({ provider: 'device', id: DEVICE_ID, summary: 'Family', role: 'writer' });

    expect(await setDefaultCalendar(db, userId, { calendarId: DEVICE_ID })).toEqual({
      ok: false,
      reason: 'not_writable',
    });
    expect(await storedDefault()).toBeNull();
  });

  it('refuses a calendar the user can only read', async () => {
    await addSource({ id: 'en.usa#holiday@group.v.calendar.google.com', summary: 'Holidays', role: 'reader' });

    const res = await setDefaultCalendar(db, userId, {
      calendarId: 'en.usa#holiday@group.v.calendar.google.com',
    });
    expect(res).toEqual({ ok: false, reason: 'not_writable' });
  });

  it("refuses another user's calendar id", async () => {
    const other = await createUser(db, 'other');
    const now = new Date().toISOString();
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: other,
        provider: 'google',
        google_calendar_id: 'theirs@group.calendar.google.com',
        summary: 'Theirs',
        access_role: 'owner',
        is_primary: 0,
        selected_in_google: 1,
        counts_for_busy_auto: 1,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();

    const res = await setDefaultCalendar(db, userId, { calendarId: 'theirs@group.calendar.google.com' });
    expect(res).toEqual({ ok: false, reason: 'not_writable' });
  });

  it('accepts a writable calendar id and null resets it', async () => {
    expect(await setDefaultCalendar(db, userId, { calendarId: FAMILY_ID })).toMatchObject({
      ok: true,
      calendarId: FAMILY_ID,
    });
    expect(await setDefaultCalendar(db, userId, { calendarId: null })).toMatchObject({
      ok: true,
      calendarId: null,
    });
    expect(await storedDefault()).toBeNull();
  });
});
