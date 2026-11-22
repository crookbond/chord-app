/**
 * The morning briefing is told about everything on the user's calendar today.
 *
 * Failure being fixed: `loadScanContext` kept an event only when
 * `Date.parse(startsAt) >= now`. That dropped every event already under way
 * at briefing time - a meeting that started an hour ago, a multi-day event
 * that began yesterday - and, because an all-day event is stored as floating
 * local midnight (ADR 0040) and `Date.parse` reads a floating time in the
 * SERVER's zone, every all-day event of the day as well: at 7am the user's
 * midnight is already behind "now". The briefing never mentioned today's
 * all-day events at all.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { loadScanContext } from '@/services/proactive.service.js';
import { dayOf } from '@/utils/tz.js';

const TZ = 'America/New_York';
const HOUR = 60 * 60_000;

function shiftDay(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function section(prompt: string, name: string): string[] {
  const lines = prompt.split('\n');
  const at = lines.indexOf(`${name}:`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  - ')) break;
    out.push(l);
  }
  return out;
}

describe('loadScanContext - today', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;
  let today: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'ada');
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', uid).execute();
    gid = (await createGroup(db, { name: 'Personal', kind: 'personal', createdBy: uid })).id;
    today = dayOf(new Date().toISOString(), TZ);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it("lists today's all-day event under TODAY", async () => {
    await createEvent(db, {
      groupId: gid,
      title: 'School holiday',
      startsAt: `${today}T00:00:00`,
      endsAt: `${shiftDay(today, 1)}T00:00:00`,
      createdBy: uid,
    });
    const ctx = await loadScanContext(db, uid);
    expect(section(ctx, 'TODAY').join('\n')).toContain('School holiday');
  });

  it('lists an event that is already under way', async () => {
    const now = Date.now();
    await createEvent(db, {
      groupId: gid,
      title: 'Board meeting',
      startsAt: new Date(now - HOUR).toISOString(),
      endsAt: new Date(now + HOUR).toISOString(),
      createdBy: uid,
    });
    const ctx = await loadScanContext(db, uid);
    expect(section(ctx, 'TODAY').join('\n')).toContain('Board meeting');
  });

  it('lists a multi-day event that began yesterday under TODAY, saying it is under way', async () => {
    await createEvent(db, {
      groupId: gid,
      title: 'Grandma visiting',
      startsAt: `${shiftDay(today, -1)}T00:00:00`,
      endsAt: `${shiftDay(today, 2)}T00:00:00`,
      createdBy: uid,
    });
    const ctx = await loadScanContext(db, uid);
    const line = section(ctx, 'TODAY').find((l) => l.includes('Grandma visiting'));
    expect(line).toBeDefined();
    expect(line).toContain('under way');
  });

  it('leaves out an all-day event that ended yesterday', async () => {
    // Exclusive end at today's midnight: the event's last day was yesterday.
    await createEvent(db, {
      groupId: gid,
      title: 'Conference',
      startsAt: `${shiftDay(today, -2)}T00:00:00`,
      endsAt: `${today}T00:00:00`,
      createdBy: uid,
    });
    const ctx = await loadScanContext(db, uid);
    expect(ctx).not.toContain('Conference');
  });

  it('still files a later event under its own day', async () => {
    await createEvent(db, {
      groupId: gid,
      title: 'Piano recital',
      startsAt: `${shiftDay(today, 1)}T18:00:00`,
      endsAt: `${shiftDay(today, 1)}T19:00:00`,
      createdBy: uid,
    });
    const ctx = await loadScanContext(db, uid);
    expect(section(ctx, 'TOMORROW').join('\n')).toContain('Piano recital');
    expect(section(ctx, 'TODAY').join('\n')).not.toContain('Piano recital');
  });
});
