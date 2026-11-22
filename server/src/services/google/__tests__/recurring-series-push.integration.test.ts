/**
 * ADR 0217 — a Chord series reaches Google as ONE recurring master, and
 * Google's expanded instances come back onto the occurrence rows Chord already
 * wrote (adopted by master id + original start), not as a second copy.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { upsertCalendarSource } from '@/services/calendar-sources.service.js';
import { createEvent, updateEvent } from '@/services/events.service.js';
import { buildRrule } from '@/services/events/recurrence.js';
import { pullCalendarChanges, pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { settleBackgroundWork } from '@/utils/background.js';

const TZ = 'America/New_York';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * New York's UTC offset on a calendar day: -04:00 until the first Sunday of
 * November, -05:00 after. A fixed "-04:00" made this file pass until the
 * Wednesdays it builds crossed the clock change, then fail until spring.
 */
function nyOffset(day: string): string {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`))
    .find((p) => p.type === 'timeZoneName')!.value; // "GMT-4" | "GMT-5"
  const hours = Number(zone.replace('GMT', ''));
  return `${hours < 0 ? '-' : '+'}${String(Math.abs(hours)).padStart(2, '0')}:00`;
}
const at = (day: string, hhmm: string): string => `${day}T${hhmm}:00${nyOffset(day)}`;

function nextWednesday(): string {
  const d = new Date(Date.now() + 3 * 86_400_000);
  while (d.getUTCDay() !== 3) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

describe('a Chord series and Google', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'series-pusher');
    await db
      .updateTable('users')
      .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
      .where('id', '=', userId)
      .execute();
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await upsertCalendarSource(db, userId, {
      googleCalendarId: 'primary',
      summary: 'me',
      accessRole: 'owner',
      isPrimary: true,
      selectedInGoogle: true,
      isChordTarget: true,
    });
    // createEvent fires its own push in the background; never let it reach
    // the network. Each test installs the Google it needs after that.
    vi.stubGlobal('fetch', vi.fn(async () => res({ error: 'unavailable' }, 503)));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  async function makeSeries() {
    const wed = nextWednesday();
    const startsAt = at(wed, '15:30');
    await createEvent(db, {
      groupId,
      createdBy: userId,
      assigneeId: userId,
      title: 'Nolan Sci Oly',
      startsAt,
      endsAt: at(wed, '17:30'),
      googleCalendarId: 'primary',
      repeat: { rrule: buildRrule({ frequency: 'weekly' }, `${wed}T15:30:00`), tz: TZ },
    });
    return wed;
  }

  it('pushes one master with the rule and a named zone, not one event per occurrence', async () => {
    await makeSeries();
    // createEvent fired its own push; let it finish so this one is clean.
    await settleBackgroundWork();
    await db.updateTable('event_series').set({ local_dirty: 1, gcal_event_id: null }).execute();
    const calls: Array<{ method: string; body: Record<string, unknown> | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        return res({ id: 'master01', etag: '"e1"', iCalUID: 'master01@google.com' });
      }),
    );

    await pushDirtyEvents(db, userId);

    const inserts = calls.filter((c) => c.method === 'POST');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.body).toMatchObject({
      summary: 'Nolan Sci Oly',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
      start: { timeZone: TZ },
    });
    const occ = await db.selectFrom('events').select(['recurring_event_id', 'gcal_event_id']).execute();
    expect(occ.length).toBeGreaterThan(50);
    expect(occ.every((r) => r.recurring_event_id === 'master01' && r.gcal_event_id === null)).toBe(true);
  });

  it("adopts Google's instances onto the rows Chord wrote, keeping each occurrence's own uid", async () => {
    const wed = await makeSeries();
    await settleBackgroundWork();
    await db.updateTable('event_series').set({ gcal_event_id: 'master01', local_dirty: 0 }).execute();
    await db.updateTable('events').set({ recurring_event_id: 'master01', google_calendar_id: 'primary' }).execute();
    const before = await db.selectFrom('events').select(['id', 'ical_uid', 'starts_at']).execute();

    const days = [0, 7, 14].map((n) =>
      new Date(Date.parse(`${wed}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10),
    );
    const items = days.map((d) => ({
      id: `master01_${d.replace(/-/g, '')}T193000Z`,
      status: 'confirmed',
      summary: 'Nolan Sci Oly',
      iCalUID: 'master01@google.com',
      recurringEventId: 'master01',
      originalStartTime: { dateTime: at(d, '15:30'), timeZone: TZ },
      start: { dateTime: at(d, '15:30'), timeZone: TZ },
      end: { dateTime: at(d, '17:30'), timeZone: TZ },
      extendedProperties: { private: { chordUid: 'ce_master' } },
      updated: new Date().toISOString(),
      sequence: 0,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? res({ items, nextSyncToken: 'tok' }) : res({}),
      ),
    );

    const result = await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    expect(result.inserted).toBe(0);
    expect(result.failed).toBe(0);

    const after = await db.selectFrom('events').select(['id', 'ical_uid', 'gcal_event_id', 'starts_at']).execute();
    expect(after).toHaveLength(before.length);
    const adopted = after.filter((r) => r.gcal_event_id?.startsWith('master01_'));
    expect(adopted).toHaveLength(3);
    // Adoption did not collapse the occurrences' own uids onto the series'.
    expect(new Set(after.map((r) => r.ical_uid)).size).toBe(after.length);
  });

  it('an occurrence edited before adoption keeps the edit and then pushes to its instance', async () => {
    const wed = await makeSeries();
    await settleBackgroundWork();
    await db.updateTable('event_series').set({ gcal_event_id: 'master01', local_dirty: 0 }).execute();
    await db.updateTable('events').set({ recurring_event_id: 'master01', google_calendar_id: 'primary' }).execute();
    const first = await db
      .selectFrom('events')
      .select('id')
      .where('starts_at', '=', at(wed, '15:30'))
      .executeTakeFirstOrThrow();

    // Held: nothing to address yet, and an insert would add a stray one-off.
    vi.stubGlobal('fetch', vi.fn(async () => res({ id: 'should-not-happen' })));
    await updateEvent(db, first.id, { title: 'Sci Oly (moved room)' });
    await settleBackgroundWork();
    await pushDirtyEvents(db, userId);
    const held = await db.selectFrom('events').select(['local_dirty', 'gcal_event_id']).where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(held).toMatchObject({ local_dirty: 1, gcal_event_id: null });

    const instance = {
      id: `master01_${wed.replace(/-/g, '')}T193000Z`,
      status: 'confirmed',
      summary: 'Nolan Sci Oly',
      iCalUID: 'master01@google.com',
      recurringEventId: 'master01',
      originalStartTime: { dateTime: at(wed, '15:30'), timeZone: TZ },
      start: { dateTime: at(wed, '15:30'), timeZone: TZ },
      end: { dateTime: at(wed, '17:30'), timeZone: TZ },
      updated: '2020-01-01T00:00:00.000Z',
      sequence: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).includes('/events') ? res({ items: [instance], nextSyncToken: 'tok' }) : res({}),
      ),
    );
    await pullCalendarChanges(db, userId, 'primary', 'fake-token');
    const adopted = await db.selectFrom('events').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(adopted.title).toBe('Sci Oly (moved room)');
    expect(adopted.gcal_event_id).toBe(instance.id);

    const patches: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (init?.method === 'PATCH') patches.push(String(url));
        return res({ id: instance.id, etag: '"e2"', iCalUID: 'master01@google.com' });
      }),
    );
    await pushDirtyEvents(db, userId);
    expect(patches.some((u) => u.includes(encodeURIComponent(instance.id)))).toBe(true);
    const pushed = await db.selectFrom('events').select(['ical_uid', 'local_dirty']).where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(pushed.local_dirty).toBe(0);
    expect(pushed.ical_uid).not.toBe('master01@google.com');
  });
});
