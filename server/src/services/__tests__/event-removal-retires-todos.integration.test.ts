/**
 * A to-do dies with the event it was for (ADR 0192).
 *
 * Prod: a building notice produced BOTH a calendar event ("Building water shut
 * off 10 AM-2 PM") and a to-do ("Prepare for building water shut off — set
 * aside water, ensure faucets are off"), both carrying the email's
 * `gmail:<threadId>` provenance. The event was later deleted — the shutdown
 * moved to the following week — but the to-do stayed open and due, and the
 * morning briefing kept telling the user to prepare for it "today".
 *
 * The event side was already sound (deleted/cancelled/sibling copies never
 * reach the scan — see scan-find-events-stale). What was missing is that
 * removing an event retired nothing that hung off it, so most of these cases
 * pin what must NOT be touched.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/google/oauth.service.js', () => ({
  getAccessToken: vi.fn(async () => 'fake-token'),
}));

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent, deleteEvent } from '@/services/events.service.js';
import { pullCalendarChanges } from '@/services/google/two-way-sync.service.js';
import { createGroup } from '@/services/groups.service.js';
import { retiredTodosSince } from '@/services/briefing/retired-todos.js';
import { __testing, loadScanContext } from '@/services/proactive.service.js';
import { createTask, retireTasksByProvenance } from '@/services/tasks.service.js';
import { newId } from '@/utils/ids.js';

const THREAD = 'gmail:t_water_shutoff';
const PREP_TITLE =
  'Prepare for building water shut off — set aside water, ensure faucets are off';

function at(daysAhead: number, hourUtc: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

const START = at(1, 14);
const END = at(1, 18);

function res(body: unknown, status = 200): Response {
  return {
    ok: status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('removing an event retires the to-dos its email produced', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice', 'Alice');
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  const mkEvent = (over: Partial<Parameters<typeof createEvent>[1]> = {}) =>
    createEvent(db, {
      groupId: gid,
      title: 'Building water shut off 10 AM-2 PM',
      startsAt: START,
      endsAt: END,
      createdBy: uid,
      sourceRawContext: THREAD,
      ...over,
    });

  const mkTask = (over: Partial<Parameters<typeof createTask>[1]> = {}) =>
    createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: PREP_TITLE,
      dueAt: START,
      sourceRawContext: THREAD,
      ...over,
    });

  const statusOf = async (id: string) =>
    (await db.selectFrom('tasks').select('status').where('id', '=', id).executeTakeFirstOrThrow())
      .status;

  it('retires the prep to-do when the event is deleted, and the briefing stops mentioning it', async () => {
    const ev = await mkEvent();
    const task = await mkTask();
    // Setup proof: with the event live, the to-do is in what the scan model reads.
    expect(await loadScanContext(db, uid)).toContain('Prepare for building water shut off');

    await deleteEvent(db, ev.id);

    expect(await statusOf(task.id)).toBe('archived');
    const ctx = await loadScanContext(db, uid);
    expect(ctx).not.toContain('water shut off');
    // Retired because its event went away, not because it was a week overdue —
    // the briefing's "retired N to-dos more than a week past their date" line
    // would be false for it.
    expect(ctx).not.toContain('RETIRED_TODOS');
  });

  it('archives rather than completing it', async () => {
    const ev = await mkEvent();
    const task = await mkTask();

    await deleteEvent(db, ev.id);

    const row = await db
      .selectFrom('tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', task.id)
      .executeTakeFirstOrThrow();
    expect(row.status).not.toBe('done');
    expect(row.completed_at).toBeNull();
  });

  it('retires an undated to-do from the same email too', async () => {
    const ev = await mkEvent();
    const task = await mkTask({ dueAt: undefined });

    await deleteEvent(db, ev.id);

    expect(await statusOf(task.id)).toBe('archived');
  });

  it('leaves a follow-up due well after the event', async () => {
    const ev = await mkEvent();
    const followUp = await mkTask({
      title: 'Send the building a note about the water damage',
      dueAt: at(5, 14),
    });

    await deleteEvent(db, ev.id);

    expect(await statusOf(followUp.id)).toBe('open');
  });

  it('leaves to-dos that came from another email or from chat', async () => {
    const ev = await mkEvent();
    const otherEmail = await mkTask({ sourceRawContext: 'gmail:t_something_else' });
    const fromChat = await mkTask({ sourceRawContext: null });

    await deleteEvent(db, ev.id);

    expect(await statusOf(otherEmail.id)).toBe('open');
    expect(await statusOf(fromChat.id)).toBe('open');
  });

  it('leaves a to-do somebody already picked up or finished', async () => {
    const ev = await mkEvent();
    const active = await mkTask();
    const done = await mkTask({ title: 'Fill the bathtub' });
    await db.updateTable('tasks').set({ status: 'active' }).where('id', '=', active.id).execute();
    await db.updateTable('tasks').set({ status: 'done' }).where('id', '=', done.id).execute();

    await deleteEvent(db, ev.id);

    expect(await statusOf(active.id)).toBe('active');
    expect(await statusOf(done.id)).toBe('done');
  });

  it('does nothing when the event did not come from an email', async () => {
    const ev = await mkEvent({ sourceRawContext: 'chat:m_123' });
    const task = await mkTask({ sourceRawContext: 'chat:m_123' });

    await deleteEvent(db, ev.id);

    expect(await statusOf(task.id)).toBe('open');
  });

  it('does nothing when a live copy of the same event from that email remains', async () => {
    // Cleaning up a duplicate is not cancelling the meeting. The twin is
    // written directly: creating the same event twice now updates the first
    // (ADR 0223), but duplicates made before that are still on calendars.
    const twinA = await mkEvent();
    const original = await db
      .selectFrom('events')
      .selectAll()
      .where('id', '=', twinA.id)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('events')
      .values({
        ...original,
        id: 'e_twin_b',
        ical_uid: 'e_twin_b',
        chord_uid: 'e_twin_b',
        group_ids: JSON.stringify(original.group_ids),
        guest_emails: original.guest_emails ? JSON.stringify(original.guest_emails) : null,
      })
      .execute();
    const task = await mkTask();

    await deleteEvent(db, twinA.id);

    expect(await statusOf(task.id)).toBe('open');
  });

  it("does not touch another user's to-do from a colliding thread id", async () => {
    const bob = await createUser(db, 'bob', 'Bob');
    const ev = await mkEvent();
    const bobs = await createTask(db, {
      groupId: gid,
      createdBy: bob,
      title: PREP_TITLE,
      dueAt: START,
      sourceRawContext: THREAD,
    });

    await deleteEvent(db, ev.id);

    expect(await statusOf(bobs.id)).toBe('open');
  });

  it('retires when Google already removed the event (reverse-delete)', async () => {
    const ev = await mkEvent();
    const task = await mkTask();

    await deleteEvent(db, ev.id, { reverseDeleteFromGoogle: true });

    expect(await statusOf(task.id)).toBe('archived');
  });
});

describe('a removal Google reports on the pull retires them too', () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'syncer', 'Syncer');
    gid = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: uid })).id;
    const now = new Date().toISOString();
    await db
      .insertInto('calendar_sources')
      .values({
        id: newId('cs'),
        user_id: uid,
        google_calendar_id: 'cal-1',
        summary: 'Cal',
        access_role: 'owner',
        is_primary: 1,
        selected_in_google: 1,
        first_seen_at: now,
        last_seen_at: now,
      })
      .execute();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeTestDb(db);
  });

  async function seedGoogleEvent(gcalId: string): Promise<string> {
    const id = newId('e');
    await db
      .insertInto('events')
      .values({
        id,
        group_id: gid,
        group_ids: JSON.stringify([gid]),
        owner_user_id: uid,
        organizer_user_id: uid,
        role: 'organizer',
        title: 'Building water shut off 10 AM-2 PM',
        starts_at: START,
        ends_at: END,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        created_by: uid,
        status: 'confirmed',
        sequence: 0,
        local_dirty: 0,
        gcal_event_id: gcalId,
        ical_uid: `uid-${gcalId}`,
        google_calendar_id: 'cal-1',
        source_raw_context: THREAD,
      })
      .execute();
    return id;
  }

  const prepTask = () =>
    createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: PREP_TITLE,
      dueAt: START,
      sourceRawContext: THREAD,
    });

  const statusOf = async (id: string) =>
    (await db.selectFrom('tasks').select('status').where('id', '=', id).executeTakeFirstOrThrow())
      .status;

  it('retires on a cancelled tombstone (deleted in Google Calendar)', async () => {
    await seedGoogleEvent('g_water');
    const task = await prepTask();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [{ id: 'g_water', iCalUID: 'uid-g_water', status: 'cancelled' }],
          nextSyncToken: 'tok-1',
        }),
      ),
    );

    const result = await pullCalendarChanges(db, uid, 'cal-1');

    expect(result.deleted).toBe(1);
    expect(await statusOf(task.id)).toBe('archived');
  });

  it('retires when the event is simply absent from a full-sync snapshot', async () => {
    await seedGoogleEvent('g_water');
    const task = await prepTask();
    vi.stubGlobal('fetch', vi.fn(async () => res({ items: [], nextSyncToken: 'tok-2' })));

    const result = await pullCalendarChanges(db, uid, 'cal-1');

    expect(result.deleted).toBe(1);
    expect(await statusOf(task.id)).toBe('archived');
  });

  it('retires when the user declines the event', async () => {
    await seedGoogleEvent('g_water');
    const task = await prepTask();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [
            {
              id: 'g_water',
              iCalUID: 'uid-g_water',
              status: 'confirmed',
              summary: 'Building water shut off 10 AM-2 PM',
              start: { dateTime: START },
              end: { dateTime: END },
              attendees: [{ self: true, responseStatus: 'declined' }],
              sequence: 0,
            },
          ],
          nextSyncToken: 'tok-3',
        }),
      ),
    );

    await pullCalendarChanges(db, uid, 'cal-1');

    expect(await statusOf(task.id)).toBe('archived');
  });

  it('leaves the to-do alone when the event is still on the calendar', async () => {
    await seedGoogleEvent('g_water');
    const task = await prepTask();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res({
          items: [
            {
              id: 'g_water',
              iCalUID: 'uid-g_water',
              status: 'confirmed',
              summary: 'Building water shut off 10 AM-2 PM',
              start: { dateTime: START },
              end: { dateTime: END },
              sequence: 0,
            },
          ],
          nextSyncToken: 'tok-4',
        }),
      ),
    );

    await pullCalendarChanges(db, uid, 'cal-1');

    expect(await statusOf(task.id)).toBe('open');
  });
});

describe("the briefing's retired-to-dos line", () => {
  let db: Kysely<DB>;
  let uid: string;
  let gid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'alice', 'Alice');
    gid = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: uid })).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // ADR 0285 — both are named, each with its own reason; before, the to-do
  // that went with its event was either uncounted (full briefing) or called
  // "past-due" (short briefing), and neither said which to-do it was.
  it('names what the sweep retired and what went with its event, each with why', async () => {
    await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Renew library card',
      dueAt: at(-10, 14), // 10 days overdue when the sweep archives it
    });
    await __testing.archiveStaleTasks(db);
    await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: PREP_TITLE,
      dueAt: START, // not yet due when its event went away
      sourceRawContext: THREAD,
    });
    await retireTasksByProvenance(db, uid, [THREAD], { dueOnOrBefore: END });

    const items = await retiredTodosSince(db, uid, new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    expect(items).toEqual([
      { title: 'Renew library card', reason: 'overdue' },
      { title: PREP_TITLE, reason: 'event_gone' },
    ]);
  });

  it('an older row with no recorded reason counts only if it was a week overdue', async () => {
    const nowIso = new Date().toISOString();
    const sweepRetired = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: 'Renew library card',
      dueAt: at(-10, 14),
    });
    const sourceRetired = await createTask(db, {
      groupId: gid,
      createdBy: uid,
      title: PREP_TITLE,
      dueAt: START,
    });
    await db
      .updateTable('tasks')
      .set({ status: 'archived', archived_at: nowIso })
      .where('id', 'in', [sweepRetired.id, sourceRetired.id])
      .execute();

    const items = await retiredTodosSince(db, uid, new Date(Date.now() - 24 * 60 * 60_000).toISOString());
    expect(items).toEqual([{ title: 'Renew library card', reason: 'overdue' }]);
  });
});
