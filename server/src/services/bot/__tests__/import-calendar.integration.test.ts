/**
 * import_calendar tool (ADR 0050): resolves a URL/district, fetches the feed
 * (stubbed here), and runs it through the shared importIcs pipeline so events
 * are created for the triggering user with externalUid dedup. The fetch itself
 * is covered in fetch-ics.test.ts; here we mock it to a fixed ICS fixture and
 * assert the executor wiring + dedup + honest failure on an unresolved name.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'BEGIN:VEVENT',
  'UID:evt-1@test',
  'SUMMARY:School Picture Day',
  'DTSTART:20260915T090000Z',
  'DTEND:20260915T100000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:evt-2@test',
  'SUMMARY:Winter Break',
  'DTSTART:20261221T000000Z',
  'DTEND:20261222T000000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\n');

vi.mock('@/services/ingest/ics/fetch-ics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ingest/ics/fetch-ics.js')>()),
  fetchIcsBuffer: vi.fn(async () => Buffer.from(ICS, 'utf8')),
}));

// Import after the mock is registered.
const { applyToolCall } = await import('@/services/bot/executor.js');

let db: Kysely<DB>;
beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('import_calendar tool', () => {
  it('imports events from a URL and dedups on re-run', async () => {
    const uid = await createUser(db, 'payal');
    const group = await createGroup(db, { name: 'School', kind: 'group', createdBy: uid });

    const first = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: { name: 'import_calendar', args: { url: 'https://schools.example/feed.ics' } },
    });
    const d1 = first.data as { ok: boolean; eventsCreated: number; eventsDeduped: number };
    expect(d1.ok, 'hint: import_calendar should succeed on a valid feed').toBe(true);
    expect(d1.eventsCreated, 'hint: both VEVENTs should be created').toBe(2);

    const second = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: { name: 'import_calendar', args: { url: 'https://schools.example/feed.ics' } },
    });
    const d2 = second.data as { ok: boolean; eventsCreated: number; eventsDeduped: number };
    expect(d2.ok).toBe(true);
    expect(d2.eventsDeduped, 'hint: re-importing the same UIDs should dedup').toBe(2);
    expect(d2.eventsCreated).toBe(0);
  });

  it('returns an honest failure (need_url) for an unknown district and creates nothing', async () => {
    const uid = await createUser(db, 'payal2');
    const group = await createGroup(db, { name: 'School2', kind: 'group', createdBy: uid });

    const res = await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: { name: 'import_calendar', args: { district: 'Springfield Elementary' } },
    });
    const d = res.data as { ok: boolean; reason?: string; eventsCreated?: number };
    expect(d.ok, 'hint: an unresolved district must not claim success').toBe(false);
    expect(d.reason).toBe('need_url');
    expect(d.eventsCreated).toBeUndefined();

    const count = await db
      .selectFrom('events')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('group_id', '=', group.id)
      .executeTakeFirst();
    expect(Number(count?.n ?? 0), 'hint: no events should be created on need_url').toBe(0);
  });
});
