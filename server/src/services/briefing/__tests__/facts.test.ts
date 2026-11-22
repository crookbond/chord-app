/**
 * ADR 0091 — the deterministic facts behind both abbreviated briefing
 * surfaces (the ADR 0079 gated teaser and the out-of-window WhatsApp
 * template).
 *
 * The invariant that matters everywhere: every field is one line or null.
 * A newline in any of them is a template Meta will reject, which shows up as
 * a briefing that silently never arrives.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { buildBriefingFacts } from '@/services/briefing/facts.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { dayOf } from '@/utils/tz.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '' } };
});

let db: Kysely<DB>;
let userId: string;
let groupId: string;

function shiftDay(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString();
}

async function addTask(title: string, dueAt: string | null): Promise<void> {
  await db
    .insertInto('tasks')
    .values({
      id: newId('t'),
      group_id: groupId,
      title,
      status: 'open',
      due_at: dueAt,
      created_by: userId,
      created_at: new Date().toISOString(),
    })
    .execute();
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'sam');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  await db
    .updateTable('users')
    .set({ last_tz: 'America/New_York' })
    .where('id', '=', userId)
    .execute();
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('buildBriefingFacts', () => {
  it('is all nulls for a brand-new account rather than throwing', async () => {
    const f = await buildBriefingFacts(db, userId);
    expect(f).toEqual({
      weather: null,
      today: null,
      thisWeek: null,
      headsUp: null,
      tasks: null,
      email: null,
    });
  });

  it('never emits a newline in any field', async () => {
    // Titles are user input, so they are the realistic source of a stray
    // newline reaching a Meta template slot.
    await addTask('Book\nthe   dentist', inDays(1));
    const f = await buildBriefingFacts(db, userId);
    for (const v of Object.values(f)) {
      if (v === null) continue;
      expect(v).not.toMatch(/[\r\n\t]/);
      expect(v).not.toMatch(/ {2}/);
    }
  });

  it("counts a multi-day event that began yesterday as one of today's, all day", async () => {
    const today = dayOf(new Date().toISOString(), 'America/New_York');
    await createEvent(db, {
      groupId,
      title: 'Grandma visiting',
      startsAt: `${shiftDay(today, -1)}T00:00:00`,
      endsAt: `${shiftDay(today, 2)}T00:00:00`,
      createdBy: userId,
    });
    const f = await buildBriefingFacts(db, userId);
    expect(f.today).toBe('1 event — first: Grandma visiting all day');
  });

  it("says an all-day event today is all day, not 12:00 AM", async () => {
    const today = dayOf(new Date().toISOString(), 'America/New_York');
    await createEvent(db, {
      groupId,
      title: 'School holiday',
      startsAt: `${today}T00:00:00`,
      endsAt: `${shiftDay(today, 1)}T00:00:00`,
      createdBy: userId,
    });
    const f = await buildBriefingFacts(db, userId);
    expect(f.today).toBe('1 event — first: School holiday all day');
  });

  it('counts open tasks and names the next one', async () => {
    await addTask('Book dentist', inDays(1));
    await addTask('Renew passport', inDays(5));
    const f = await buildBriefingFacts(db, userId);
    expect(f.tasks).toContain('2 open tasks');
    expect(f.tasks).toContain('Book dentist');
  });

  it('counts copies of one to-do once', async () => {
    // A to-do copied into a second group (ADR 0232) or restated by an email.
    await addTask('Book dentist', inDays(1));
    await addTask('book dentist!', inDays(2));
    await addTask('Renew passport', inDays(5));
    expect((await buildBriefingFacts(db, userId)).tasks).toContain('2 open tasks');
  });

  it('singularises one task', async () => {
    await addTask('Book dentist', inDays(1));
    expect((await buildBriefingFacts(db, userId)).tasks).toContain('1 open task —');
  });

  it('calls out overdue work', async () => {
    await addTask('Pay the bill', inDays(-1));
    expect((await buildBriefingFacts(db, userId)).tasks).toContain('1 overdue');
  });

  it('reports unread mail as a count', async () => {
    await db
      .insertInto('email_threads')
      .values({
        id: newId('et'),
        user_id: userId,
        gmail_thread_id: 'g1',
        subject: 'Hello',
        from_name: 'A',
        from_email: 'a@example.com',
        snippet: '',
        last_message_at: new Date().toISOString(),
        is_unread: 1,
        is_archived: 0,
        category_id: null,
        classified_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();
    expect((await buildBriefingFacts(db, userId)).email).toContain('1 unread');
  });

  it('leaves weather null when no provider is configured', async () => {
    expect((await buildBriefingFacts(db, userId)).weather).toBeNull();
  });
});
