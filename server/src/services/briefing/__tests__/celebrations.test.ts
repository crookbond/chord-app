/**
 * ADR 0272 — birthdays and anniversaries from People, the calendar, to-dos and
 * email lead the briefing. The failure being fixed: a birthday that existed
 * only as a calendar event, a to-do or an email never reached the top of the
 * morning message (only saved People did, and only through the model).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import {
  celebrationKind,
  celebrationWho,
  collectCelebrations,
  mergeCelebrations,
  renderCelebrationsSection,
  type Celebration,
} from '@/services/briefing/celebrations.js';
import { buildBriefingFacts } from '@/services/briefing/facts.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { dayOf } from '@/utils/tz.js';
import { newId } from '@/utils/ids.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '' } };
});

const TZ = 'America/New_York';

describe('celebrationKind', () => {
  it.each([
    ["Ben's birthday", 'birthday'],
    ['Happy Bday John!', 'birthday'],
    ["Mom's b-day dinner", 'birthday'],
    ['Wedding anniversary', 'anniversary'],
    ['Ella’s 7th Birthday Party!', 'birthday'],
    ['Dentist', null],
    ['Anniversary sale — 40% off', 'anniversary'],
  ])('%s → %s', (text, kind) => {
    expect(celebrationKind(text)).toBe(kind);
  });
});

describe('celebrationWho', () => {
  it.each([
    ["Ben's birthday", 'ben'],
    ['Buy gift for Ben’s birthday', 'ben'],
    ["Ella's 7th birthday party!", 'ella'],
    ['Happy birthday', null],
  ])('%s → %s', (text, who) => {
    expect(celebrationWho(text)).toBe(who);
  });
});

function c(p: Partial<Celebration>): Celebration {
  return { kind: 'birthday', on: null, label: '', who: null, source: 'calendar', notes: [], ...p };
}

describe('mergeCelebrations', () => {
  it('folds the People row and the calendar event for the same day into one line', () => {
    const out = mergeCelebrations([
      c({ source: 'people', on: '2026-10-22', who: 'ben', label: "Ben's birthday" }),
      c({ source: 'calendar', on: '2026-10-22', who: 'ben', label: "Ben's Birthday" }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('attaches a to-do to its day instead of listing it twice', () => {
    const out = mergeCelebrations([
      c({ source: 'calendar', on: '2026-10-22', who: 'ben', label: "Ben's birthday" }),
      c({ source: 'reminder', on: null, who: 'ben', label: "Buy Ben's birthday gift" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].notes).toEqual(["to-do: Buy Ben's birthday gift"]);
  });

  it('keeps two people on the same day apart', () => {
    const out = mergeCelebrations([
      c({ source: 'calendar', on: '2026-10-22', who: 'ben', label: "Ben's birthday" }),
      c({ source: 'calendar', on: '2026-10-22', who: 'ella', label: "Ella's birthday" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('orders by date with undated items last', () => {
    const out = mergeCelebrations([
      c({ source: 'email', who: 'ella', label: '"party"' }),
      c({ source: 'calendar', on: '2026-10-30', who: 'b', label: 'B' }),
      c({ source: 'calendar', on: '2026-10-20', who: 'a', label: 'A' }),
    ]);
    expect(out.map((x) => x.label)).toEqual(['A', 'B', '"party"']);
  });
});

describe('renderCelebrationsSection', () => {
  it('is null when there is nothing', () => {
    expect(renderCelebrationsSection([], '2026-10-19')).toBeNull();
  });

  it('says today / tomorrow / weekday and how far out', () => {
    const s = renderCelebrationsSection(
      [
        c({ on: '2026-10-19', label: "Ben's birthday" }),
        c({ on: '2026-10-20', kind: 'anniversary', label: 'Wedding anniversary' }),
        c({ on: '2026-10-31', label: "Ella's birthday" }),
        c({ source: 'email', label: '"Ella\'s party!" from Evite' }),
      ],
      '2026-10-19',
    )!;
    expect(s.split('\n')).toEqual([
      '🎂 Birthdays & anniversaries:',
      "• Today — Ben's birthday",
      '• Tomorrow — Wedding anniversary',
      "• Sat Oct 31 (in 12 days) — Ella's birthday",
      '• In your email — "Ella\'s party!" from Evite',
    ]);
  });
});

describe('collectCelebrations (calendar, to-dos, email, People)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;
  const now = new Date();
  const day = (n: number) => dayOf(new Date(now.getTime() + n * 86_400_000).toISOString(), TZ);

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sam');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  async function addEvent(title: string, onDay: string) {
    await createEvent(db, { groupId, title, startsAt: `${onDay}T00:00:00`, createdBy: userId, allDay: true });
  }
  async function addTask(title: string, dueAt: string | null) {
    await db
      .insertInto('tasks')
      .values({ id: newId('t'), group_id: groupId, title, status: 'open', due_at: dueAt, created_by: userId, created_at: now.toISOString() })
      .execute();
  }
  async function addThread(subject: string, opts: { bulk?: number; archived?: number } = {}) {
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: newId('g'),
        subject,
        from_name: 'Evite',
        from_email: 'info@evite.com',
        snippet: '',
        last_message_at: now.toISOString(),
        is_unread: 1,
        is_archived: opts.archived ?? 0,
        bulk: opts.bulk ?? 0,
        category_id: null,
        classified_at: null,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .execute();
  }

  it('finds a birthday that exists only on the calendar', async () => {
    await addEvent("Ben's birthday", day(3));
    await addEvent('Dentist', day(2));
    const out = await collectCelebrations(db, userId, TZ, { now });
    expect(out.map((x) => [x.label, x.on])).toEqual([["Ben's birthday", day(3)]]);
  });

  it('skips one that has already passed or is more than two weeks out', async () => {
    await addEvent("Ben's birthday", day(-2));
    await addEvent('Wedding anniversary', day(20));
    expect(await collectCelebrations(db, userId, TZ, { now })).toEqual([]);
  });

  it('attaches the gift to-do to the calendar birthday and lists a standalone one', async () => {
    await addEvent("Ben's birthday", day(3));
    await addTask("Buy Ben's birthday gift", null);
    await addTask("Order cake for Mom's birthday", new Date(now.getTime() + 5 * 86_400_000).toISOString());
    const out = await collectCelebrations(db, userId, TZ, { now });
    expect(out).toHaveLength(2);
    expect(out[0].notes).toEqual(["to-do: Buy Ben's birthday gift"]);
    expect(out[1]).toMatchObject({ source: 'reminder', on: day(5) });
  });

  it('surfaces a birthday email but not a bulk promo or archived mail', async () => {
    await addThread("Ella's 7th birthday party!");
    await addThread('Happy birthday! A treat on us', { bulk: 1 });
    await addThread('Re: anniversary dinner', { archived: 1 });
    const out = await collectCelebrations(db, userId, TZ, { now });
    expect(out.map((x) => x.label)).toEqual(['"Ella\'s 7th birthday party!" from Evite']);
  });

  it('merges a saved People birthday with the same calendar event', async () => {
    const [, mm, dd] = day(4).split('-');
    await db.insertInto('people').values({ id: 'p1', owner_user_id: userId, display_name: 'Ben', notes: null, created_at: now.toISOString(), updated_at: now.toISOString() }).execute();
    await db.insertInto('important_dates').values({ id: 'd1', person_id: 'p1', kind: 'birthday', date: `0000-${mm}-${dd}`, recurs: 1 }).execute();
    await addEvent("Ben's birthday", day(4));
    const out = await collectCelebrations(db, userId, TZ, { now });
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('people');
  });

  it('leads the WhatsApp heads-up line with a calendar-only birthday', async () => {
    await addEvent("Ben's birthday", day(1));
    const f = await buildBriefingFacts(db, userId);
    expect(f.headsUp).toBe("Ben's birthday tomorrow");
  });
});
