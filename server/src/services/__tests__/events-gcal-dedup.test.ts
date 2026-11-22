/**
 * Bug: a Chord-created event pushed to Google and pulled back by the calendar
 * sync was duplicated, because the original row was tagged only with
 * `gcal_event_id` while the sync deduped on `external_uid`. The keys never
 * matched. findEventByGcalId is the second dedup key that closes the gap.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { findEventByGcalId } from '@/services/events.service.js';
import { createGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('findEventByGcalId', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedEvent(
    groupId: string,
    userId: string,
    over: Partial<Record<string, unknown>> = {},
  ): Promise<string> {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        title: 'Take train on 86th Street',
        starts_at: '2026-05-22T17:00:00-04:00',
        created_by: userId,
        created_at: new Date().toISOString(),
        gcal_event_id: 'gcal-abc',
        ...over,
      })
      .execute();
    return id;
  }

  it('matches a Chord-created row by gcal_event_id even when external_uid is null', async () => {
    const uid = await createUser(db);
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    const id = await seedEvent(g.id, uid);

    const found = await findEventByGcalId(db, g.id, 'gcal-abc');
    expect(found?.id).toBe(id);
  });

  it('is scoped to the group', async () => {
    const uid = await createUser(db);
    const g1 = await createGroup(db, { name: 'G1', kind: 'group', createdBy: uid });
    const g2 = await createGroup(db, { name: 'G2', kind: 'group', createdBy: uid });
    await seedEvent(g1.id, uid);

    expect(await findEventByGcalId(db, g2.id, 'gcal-abc')).toBeNull();
  });

  it('returns null when no row carries that gcal id', async () => {
    const uid = await createUser(db);
    const g = await createGroup(db, { name: 'G', kind: 'group', createdBy: uid });
    await seedEvent(g.id, uid);

    expect(await findEventByGcalId(db, g.id, 'gcal-other')).toBeNull();
  });
});
