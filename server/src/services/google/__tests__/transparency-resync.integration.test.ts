/**
 * Proof that syncPrimaryCalendar heals the busyness flag on already-synced
 * rows. The sync is insert-only for everything else, so rows that predate
 * per-event transparency (migration 042 backfilled them to 'opaque') would
 * otherwise stay opaque forever. A re-sync must patch them to match Google's
 * current "show me as free" setting. Google is mocked at the fetch boundary.
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

describe('syncPrimaryCalendar transparency heal', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db);
    const group = await ensurePersonalGroup(db, userId);
    groupId = group.id;

    // Google returns the same event Chord already has, now marked "Free".
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
                id: 'FREE',
                status: 'confirmed',
                summary: 'School closed',
                transparency: 'transparent',
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

  async function transparencyOf(id: string): Promise<string> {
    const row = await db
      .selectFrom('events')
      .select(['transparency'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return row.transparency as string;
  }

  it('patches an existing opaque row to transparent and counts it', async () => {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        title: 'School closed',
        starts_at: inWindow,
        created_by: userId,
        created_at: new Date().toISOString(),
        external_uid: 'gcal:FREE',
        transparency: 'opaque', // pre-feature backfill value
      })
      .execute();

    const result = await syncPrimaryCalendar(db, userId);

    expect(result.inserted).toBe(0);
    expect(result.skippedExisting).toBe(1);
    expect(result.updatedTransparency).toBe(1);
    expect(await transparencyOf(id)).toBe('transparent');
  });

  it('is a no-op when transparency already matches', async () => {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        title: 'School closed',
        starts_at: inWindow,
        created_by: userId,
        created_at: new Date().toISOString(),
        external_uid: 'gcal:FREE',
        transparency: 'transparent',
      })
      .execute();

    const result = await syncPrimaryCalendar(db, userId);

    expect(result.updatedTransparency).toBe(0);
    expect(await transparencyOf(id)).toBe('transparent');
  });
});
