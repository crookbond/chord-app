/**
 * PR-B.1 — `endsAt` round-trips through the events service and the bot
 * tool. Old rows without ends_at remain readable as `endsAt: undefined`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { toolSchemas } from '@/services/bot/tools.js';
import { createEvent, listEvents } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('events.endsAt (PR-B.1)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('persists endsAt when provided and round-trips through listEvents', async () => {
    const uid = await createUser(db, 'alice');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const created = await createEvent(db, {
      groupId: group.id,
      title: 'Potluck',
      startsAt: '2026-06-12T18:00:00-04:00',
      endsAt: '2026-06-12T21:00:00-04:00',
      createdBy: uid,
    });
    expect(created.endsAt).toBe('2026-06-12T21:00:00-04:00');
    const [row] = await listEvents(db, group.id, { pastDays: 3650, futureDays: 3650 });
    expect(row.endsAt).toBe('2026-06-12T21:00:00-04:00');
  });

  it('leaves endsAt undefined when not provided', async () => {
    const uid = await createUser(db, 'bob');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    const created = await createEvent(db, {
      groupId: group.id,
      title: 'Quick coffee',
      startsAt: '2026-06-12T18:00:00-04:00',
      createdBy: uid,
    });
    expect(created.endsAt).toBeUndefined();
    const [row] = await listEvents(db, group.id, { pastDays: 3650, futureDays: 3650 });
    expect(row.endsAt).toBeUndefined();
  });

  it('bot create_event tool plumbs endsAt to the row', async () => {
    const uid = await createUser(db, 'carol');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid });
    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: uid,
      provenance: null,
      call: {
        name: 'create_event',
        args: {
          title: 'Game night',
          startsAt: '2026-07-04T19:00:00-04:00',
          endsAt: '2026-07-04T22:30:00-04:00',
        },
      },
      suppressEventNudges: true,
    });
    const [row] = await listEvents(db, group.id, { pastDays: 3650, futureDays: 3650 });
    expect(row.endsAt).toBe('2026-07-04T22:30:00-04:00');
  });

  it('create_event zod accepts a valid endsAt', () => {
    const r = toolSchemas.create_event.safeParse({
      title: 't',
      startsAt: '2026-07-04T19:00:00-04:00',
      endsAt: '2026-07-04T22:00:00-04:00',
    });
    expect(r.success).toBe(true);
  });

  it('create_event zod rejects a malformed endsAt', () => {
    const r = toolSchemas.create_event.safeParse({
      title: 't',
      startsAt: '2026-07-04T19:00:00-04:00',
      endsAt: 'not-a-datetime',
    });
    expect(r.success).toBe(false);
  });

  it('create_event zod treats endsAt as truly optional', () => {
    const r = toolSchemas.create_event.safeParse({
      title: 't',
      startsAt: '2026-07-04T19:00:00-04:00',
    });
    expect(r.success).toBe(true);
  });
});
