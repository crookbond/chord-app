/**
 * ADR 0278 — calendar colors. A calendar shows the user's pick, else its
 * provider's color, else Chord's palette; events carry their calendar's color
 * and name so the app can color them and say which calendar they are on. The
 * chat tool and Settings share one writer, `setCalendarColor`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHORD_CALENDAR_PALETTE } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import {
  listCalendarSources,
  setCalendarColor,
  upsertCalendarSource,
} from '@/services/calendar-sources.service.js';
import { listEventsForUser } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const PRIMARY_ID = 'ownertest@gmail.com';
const FAMILY_ID = 'family07746485221481824228@group.calendar.google.com';
const HOLIDAYS_ID = 'en.usa#holiday@group.v.calendar.google.com';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function source(id: string, summary: string, color: string | null, extra: { primary?: boolean; reader?: boolean } = {}) {
  await upsertCalendarSource(db, userId, {
    googleCalendarId: id,
    summary,
    accessRole: extra.reader ? 'reader' : 'owner',
    isPrimary: !!extra.primary,
    selectedInGoogle: true,
    isChordTarget: false,
    color,
  });
}

async function displayOf(summary: string): Promise<string> {
  const rows = await listCalendarSources(db, userId);
  return rows.find((r) => r.summary === summary)!.displayColor;
}

function say(args: { calendar?: string; color?: string }) {
  return applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: null,
    call: { name: 'set_calendar_color', args },
  });
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john', 'John Doe');
  groupId = (await createGroup(db, { name: 'John', kind: 'personal', createdBy: userId })).id;
  await source(PRIMARY_ID, 'John Doe', '#039be5', { primary: true });
  await source(FAMILY_ID, 'Family', '#039be5');
  await source(HOLIDAYS_ID, 'Holidays in United States', null, { reader: true });
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('calendar display colors (ADR 0278)', () => {
  it('defaults to the provider color, keeps two same-colored calendars apart, and fills gaps from the Chord palette', async () => {
    expect(await displayOf('John Doe')).toBe('#039BE5');
    const family = await displayOf('Family');
    expect(family).not.toBe('#039BE5');
    expect(await displayOf('Holidays in United States')).toBe(CHORD_CALENDAR_PALETTE[0]);
  });

  it('a pick survives the next provider sync rewriting the provider color', async () => {
    const r = await setCalendarColor(db, userId, { name: 'Family' }, 'green');
    expect(r.ok).toBe(true);
    await source(FAMILY_ID, 'Family', '#7986cb');
    expect(await displayOf('Family')).toBe('#1F9E78');
  });

  it('lets the user give two calendars the same color', async () => {
    await setCalendarColor(db, userId, { name: 'Family' }, 'blue');
    await setCalendarColor(db, userId, { name: 'Holidays' }, '#3a8ae0');
    expect(await displayOf('Family')).toBe('#3A8AE0');
    expect(await displayOf('Holidays in United States')).toBe('#3A8AE0');
  });

  it('an empty color clears the pick', async () => {
    await setCalendarColor(db, userId, { name: 'Holidays' }, 'pink');
    await setCalendarColor(db, userId, { name: 'Holidays' }, '');
    expect(await displayOf('Holidays in United States')).toBe(CHORD_CALENDAR_PALETTE[0]);
  });

  it('refuses a color it does not know and a name it cannot find', async () => {
    expect(await setCalendarColor(db, userId, { name: 'Family' }, 'chartreuse-ish')).toEqual({
      ok: false,
      reason: 'bad_color',
    });
    expect(await setCalendarColor(db, userId, { name: 'Work' }, 'blue')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('events carry their calendar color and name', async () => {
    await setCalendarColor(db, userId, { name: 'Family' }, 'purple');
    const start = new Date(Date.now() + 24 * 3600_000).toISOString();
    const base = {
      group_id: groupId,
      starts_at: start,
      created_by: userId,
      created_at: start,
      owner_user_id: userId,
      organizer_user_id: userId,
      role: 'organizer' as const,
      group_ids: JSON.stringify([groupId]),
      status: 'confirmed' as const,
      all_day: 0,
      sequence: 0,
      transparency: 'opaque' as const,
      local_dirty: 0,
      updated_at: start,
    };
    await db
      .insertInto('events')
      .values([
        { ...base, id: 'e-family', title: 'Soccer', ical_uid: 'u1', google_calendar_id: FAMILY_ID },
        { ...base, id: 'e-chord', title: 'Chord only', ical_uid: 'u2' },
      ])
      .execute();
    const events = await listEventsForUser(db, userId);
    const soccer = events.find((e) => e.id === 'e-family')!;
    expect(soccer.color).toBe('#7F76DE');
    expect(soccer.calendarName).toBe('Family');
    const chord = events.find((e) => e.id === 'e-chord')!;
    expect(chord.color).toBeNull();
    expect(chord.calendarName).toBeNull();
  });
});

describe('set_calendar_color tool (ADR 0278)', () => {
  it('is personal-chat only', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('set_calendar_color')).toBe(true);
  });

  it('"make the Family calendar green" saves it', async () => {
    const r = await say({ calendar: 'Family', color: 'green' });
    expect(r.data).toMatchObject({ ok: true, calendar: 'Family', color: '#1F9E78', colorName: 'green' });
    expect(await displayOf('Family')).toBe('#1F9E78');
  });

  it('reads every calendar when no calendar is named', async () => {
    const r = await say({});
    const data = r.data as { ok: boolean; calendars: { calendar: string }[] };
    expect(data.ok).toBe(true);
    expect(data.calendars.map((c) => c.calendar).sort()).toEqual(['Family', 'Holidays in United States', 'John Doe']);
  });

  it('asks when a name fits several calendars', async () => {
    await source('family-trips@group.calendar.google.com', 'Family Trips', null);
    const r = await say({ calendar: 'fam', color: 'red' });
    expect(r.data).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});
