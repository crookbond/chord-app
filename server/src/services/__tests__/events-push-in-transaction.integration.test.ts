/**
 * ADR 0313 addendum — createEvent's own calendar push used to start on
 * whatever handle it was given. Inside a transaction (a confirmed email
 * event card, a trip bundle, a flight leg's event) the push claimed the row
 * in the transaction and then wrote the Google id on a committed handle,
 * which throws: the event was committed claimed (local_dirty=0) with no
 * Google id, so nothing ever pushed it again.
 *
 * Google's insert answers only after the transaction has committed, the
 * shape that loses the id.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { transactionThen } from '@/db/after-commit.js';
import { createEvent } from '@/services/events.service.js';
import { buildRrule } from '@/services/events/recurrence.js';
import { convertEventToSeries } from '@/services/events/series.service.js';
import { createGroup } from '@/services/groups.service.js';
import { confirmProposal, createProposal } from '@/services/proposals.service.js';
import { addTravelLeg, createTrip } from '@/services/trips.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';
import { settleBackgroundWork } from '@/utils/background.js';

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let release: () => void;
let inserts: number;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'pusher');
  await db
    .updateTable('users')
    .set({ refresh_token_scopes: 'https://www.googleapis.com/auth/calendar' })
    .where('id', '=', userId)
    .execute();
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;

  inserts = 0;
  const gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST' && String(url).includes('/events')) {
        inserts += 1;
        // Google answers after the caller's transaction has committed.
        await gate;
        return res({ id: `g${inserts}`, etag: '"e1"', iCalUID: `uid${inserts}`, sequence: 0 });
      }
      return res({ items: [] });
    }),
  );
});

afterEach(async () => {
  release();
  await settleBackgroundWork();
  vi.unstubAllGlobals();
  await closeTestDb(db);
});

async function eventsInGroup() {
  return db.selectFrom('events').selectAll().where('group_id', '=', groupId).execute();
}

describe('an event written inside a transaction reaches Google', () => {
  it('a confirmed event card is pushed and its Google id recorded', async () => {
    const p = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Dentist', startsAt: inDays(3), endsAt: inDays(3.05) },
      provenance: null,
    });
    const out = await confirmProposal(db, { id: p.id, resolvedByUserId: userId });
    expect(out.ok).toBe(true);

    release();
    await settleBackgroundWork();

    const [ev] = await eventsInGroup();
    expect(ev?.title).toBe('Dentist');
    expect(ev?.gcal_event_id).toBe('g1');
    expect(ev?.local_dirty).toBe(0);
  });

  it("a flight leg's calendar event is pushed and its Google id recorded", async () => {
    const trip = await createTrip(db, {
      groupId,
      createdBy: userId,
      name: 'Toronto',
      destination: 'Toronto',
      participantIds: [],
      startDate: inDays(5).slice(0, 10),
      endDate: inDays(8).slice(0, 10),
    });
    await addTravelLeg(db, {
      tripId: trip.id,
      mode: 'flight',
      origin: 'EWR',
      destination: 'YYZ',
      departAt: inDays(5),
      arriveAt: inDays(5.08),
      carrier: 'AC',
      flightNo: '123',
    });

    release();
    await settleBackgroundWork();

    const [ev] = await eventsInGroup();
    expect(ev).toBeDefined();
    expect(ev?.gcal_event_id).toBe('g1');
    expect(ev?.local_dirty).toBe(0);
  });

  it('transactionThen starts the push after commit; a rollback starts nothing', async () => {
    await transactionThen(db, (trx) =>
      createEvent(trx, { groupId, title: 'Kept', startsAt: inDays(2), createdBy: userId }),
    );
    await expect(
      transactionThen(db, async (trx) => {
        await createEvent(trx, { groupId, title: 'Rolled back', startsAt: inDays(2), createdBy: userId });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    release();
    await settleBackgroundWork();

    const rows = await eventsInGroup();
    expect(rows.map((r) => r.title)).toEqual(['Kept']);
    expect(rows[0]?.gcal_event_id).toBe('g1');
    expect(inserts).toBe(1);
  });

  it('a one-off turned into a series inside a transaction gets its Google master id', async () => {
    const id = newId('e');
    const startsAt = inDays(4);
    const now = new Date().toISOString();
    await db
      .insertInto('events')
      .values({
        id,
        group_id: groupId,
        group_ids: JSON.stringify([groupId]),
        owner_user_id: userId,
        organizer_user_id: userId,
        role: 'organizer',
        title: 'Squash',
        starts_at: startsAt,
        created_at: now,
        updated_at: now,
        created_by: userId,
        status: 'confirmed',
        sequence: 0,
        local_dirty: 0,
      })
      .execute();
    const event = await db.selectFrom('events').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const local = startsAt.slice(0, 19);

    await transactionThen(db, (trx) =>
      convertEventToSeries(trx, event, { rrule: buildRrule({ frequency: 'weekly' }, local), tz: 'UTC' }),
    );

    release();
    await settleBackgroundWork();

    const series = await db.selectFrom('event_series').selectAll().execute();
    expect(series).toHaveLength(1);
    expect(series[0]?.gcal_event_id).toBe('g1');
    expect(series[0]?.local_dirty).toBe(0);
  });

  it('a bare transaction leaves the event dirty for the next sync, never claimed without an id', async () => {
    await db.transaction().execute((trx) =>
      createEvent(trx, { groupId, title: 'Unbound', startsAt: inDays(2), createdBy: userId }),
    );

    release();
    await settleBackgroundWork();

    const [ev] = await eventsInGroup();
    expect(ev?.gcal_event_id).toBeNull();
    expect(ev?.local_dirty).toBe(1);
  });
});
