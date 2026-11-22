/**
 * End-to-end proof that syncPrimaryCalendar reconciles Google-side deletes:
 * an event Google no longer returns is removed from Chord, while one Google
 * still returns is kept. Google is mocked at the fetch + access-token boundary;
 * everything below (DB, dedup, deleteEvent) is real.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-access-token'),
}));

import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { syncPrimaryCalendar } from '@/services/google/calendar.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

function gjson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const inWindow = new Date(Date.now() + 2 * 86_400_000).toISOString();

describe('syncPrimaryCalendar reverse-delete', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db);
    const group = await ensurePersonalGroup(db, userId);
    groupId = group.id;

    // Google returns ONE live event ("LIVE"); "DELETED" is absent (deleted).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/users/me/calendarList')) {
          return gjson({
            items: [{ id: 'primary@cal', primary: true, accessRole: 'owner', selected: true }],
          });
        }
        if (u.includes('/events')) {
          return gjson({
            items: [
              {
                id: 'LIVE',
                status: 'confirmed',
                summary: 'Live event',
                start: { dateTime: inWindow },
              },
            ],
          });
        }
        return gjson({});
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  async function seedSynced(extId: string, gcalId: string): Promise<string> {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        title: extId,
        starts_at: inWindow,
        created_by: userId,
        created_at: new Date().toISOString(),
        // Google-origin: external_uid set, gcal_synced_at NULL (never pushed).
        external_uid: `gcal:${gcalId}`,
      })
      .execute();
    return id;
  }

  it('deletes a vanished Google event and keeps a present one', async () => {
    const deletedRow = await seedSynced('DELETED', 'DELETED');
    const liveRow = await seedSynced('LIVE', 'LIVE');

    const result = await syncPrimaryCalendar(db, userId);

    expect(result.deleted).toBe(1);
    const rows = await db
      .selectFrom('events')
      .select(['id'])
      .where('group_id', '=', groupId)
      .execute();
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(liveRow);
    expect(ids).not.toContain(deletedRow);
  });
});
