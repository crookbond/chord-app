/**
 * ADR 0181 — a fanned-out group event (ADR 0040 §7) gives every member their
 * own row and their own provider event. Prod: "meeting with Ahf... invite
 * hannah, victor and scott" in a family group invited those guests once per
 * family member, each from that member's own account.
 *
 * Guests go only on the organizer's provider event (ADR 0295: added there
 * directly), and a member's copy never mails anyone.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import { pushDirtyEvents } from '@/services/google/two-way-sync.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { installFakeGoogleCalendar, type FakeGoogleCalendar } from '@/__test-helpers__/fake-google-calendar.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const future = (): string => {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T15:00:00-04:00`;
};

describe('external guests ride only the organizer copy', () => {
  let db: Kysely<DB>;
  let organizerId: string;
  let siblingId: string;
  let groupId: string;
  let google: FakeGoogleCalendar;

  const run = async (actor: string, name: string, args: Record<string, unknown>) => {
    const out = await applyToolCall(db, {
      groupId,
      actorUserId: actor,
      provenance: null,
      turnId: `turn-${Math.random()}`,
      tzOffset: '-04:00',
      call: { name, args } as never,
    });
    await settleBackgroundWork();
    return out;
  };

  const copyOf = (owner: string) =>
    db
      .selectFrom('events')
      .select(['id', 'gcal_event_id'])
      .where('owner_user_id', '=', owner)
      .where('title', '=', 'Meeting with Ahf')
      .executeTakeFirstOrThrow();

  beforeEach(async () => {
    db = await openTestDb();
    organizerId = await createUser(db, 'organizer');
    siblingId = await createUser(db, 'sibling');
    for (const uid of [organizerId, siblingId]) {
      await db
        .updateTable('users')
        .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
        .where('id', '=', uid)
        .execute();
    }
    groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: organizerId })).id;
    await addMember(db, groupId, siblingId);
    google = installFakeGoogleCalendar();
  });

  afterEach(async () => {
    await settleBackgroundWork();
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  it('only the organizer’s provider event carries the guests, and the sibling’s push mails nobody', async () => {
    await run(organizerId, 'create_event', {
      title: 'Meeting with Ahf',
      startsAt: future(),
      invitees: ['hannah@x.test', 'victor@x.test', 'scott@x.test'],
    });
    await pushDirtyEvents(db, siblingId);

    const organizer = await copyOf(organizerId);
    const sibling = await copyOf(siblingId);
    expect(google.guests(organizer.gcal_event_id!)).toEqual(['hannah@x.test', 'scott@x.test', 'victor@x.test']);
    expect(google.guests(sibling.gcal_event_id!)).toEqual([]);
    for (const r of google.requests.filter((q) => q.method === 'POST')) {
      expect(r.url).not.toContain('sendUpdates');
      expect(r.body).not.toHaveProperty('attendees');
    }
  });

  it('a member cannot invite people to an event someone else organizes', async () => {
    await run(organizerId, 'create_event', { title: 'Meeting with Ahf', startsAt: future() });
    await pushDirtyEvents(db, siblingId);
    const sibling = await copyOf(siblingId);

    const res = await run(siblingId, 'update_event', { eventId: sibling.id, invitees: ['guest@x.test'] });

    expect(res.data).toMatchObject({ invited: [], guestChange: 'not_organizer' });
    expect(google.patches()).toHaveLength(0);
  });
});
