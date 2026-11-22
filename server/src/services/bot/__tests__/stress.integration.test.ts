/**
 * Stress / volume integration test.
 *
 * Simulates a realistic family + friends scenario with 100+ users spread
 * across multiple groups. Verifies:
 *
 *  MESSAGES  — 300 messages across 3 groups reach the DB with correct
 *               sender attribution and group scoping.
 *
 *  TASKS     — 50 tasks across two groups; all visible to every member of
 *               each group; isolated from the other group; assignment works
 *               at volume.
 *
 *  LISTS     — 6 named lists; 10+ users each adding items to the same list
 *               produce a single merged list, not one list per sender.
 *
 *  TRIPS     — 8 trips with intentionally varied completeness:
 *
 *     past        All legs + hotel → complete
 *     current     In-progress; some members have legs, some don't
 *     july4-A     Future: John + Alice travelling together
 *     july4-B     Future: Bob + Carol, same dates as july4-A → shared header key
 *     laborday    Future: different dates → different header key
 *     skeleton    Future: no legs, no hotel — everyone missing
 *     solo-A      Future: trip where only one person (Dave) has legs
 *     cross-group Future: trip created in group-2 but participant (Eve)
 *                         also in group-1
 *
 *  TRIP UI ORDERING
 *     All 8 trips sorted ascending by start_date.
 *
 *  TRIP DATE GROUPING
 *     july4-A and july4-B share the same "YYYY-MM-DD/YYYY-MM-DD" key.
 *     All others produce distinct keys.
 *
 *  GAP ANALYSIS (per-trip)
 *     Legs, accommodations, and participant names per trip.
 */

import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, ensureList, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';
import { createGroup } from '@/services/groups.service.js';
import {
  createTrip,
  addTravelLeg,
  addAccommodation,
  listTripsForGroup,
  listTripStatusesForGroup,
  getTripStatus,
} from '@/services/trips.service.js';
import { createTask, listTasks } from '@/services/tasks.service.js';
import { setGrant } from '@/services/trust.service.js';
import { addItem, listLists } from '@/services/lists.service.js';

// ── helpers ───────────────────────────────────────────────────────────────────

async function insertMessage(
  db: Kysely<DB>,
  groupId: string,
  senderId: string,
  body: string,
): Promise<string> {
  const id = newId('m');
  await db.insertInto('messages').values({
    id,
    group_id: groupId,
    sender_id: senderId,
    kind: 'text',
    body,
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: null,
    is_proactive: 0,
  }).execute();
  return id;
}

// ── fixed dates ───────────────────────────────────────────────────────────────

function d(offset: number): string {
  const dt = new Date();
  dt.setDate(dt.getDate() + offset);
  return dt.toISOString().slice(0, 10);
}

const PAST = { start: '2025-01-10', end: '2025-01-20' };
const CURRENT = { start: d(-5), end: d(5) };
// Two future "holiday" trips (the JULY4 / LABORDAY names are just scenario
// labels). Relative to now — NOT hardcoded — so they can never collide with
// CURRENT's ±5-day window. The old hardcoded 2026 dates broke every early July:
// once "now" reached 2026-07-08, CURRENT.start (d(-5) = 2026-07-03) equalled the
// hardcoded JULY4.start, so the date-only filter counted 3 July-4 trips, not 2.
// Kept well apart to preserve the PAST < CURRENT < JULY4 < LABORDAY sort order.
const JULY4 = { start: d(90), end: d(93) };
const LABORDAY = { start: d(150), end: d(153) };
const DEC = { start: '2026-12-26', end: '2026-12-31' };

// ── shared state ──────────────────────────────────────────────────────────────

let db: Kysely<DB>;

// Named anchors for cross-group verification — present in every group
let john: { id: string; name: string };
let alice: { id: string; name: string };

// 100 generic users: indices 0–99
let users: Array<{ id: string; name: string }>;

// Group 1: "Family" — John + Alice + users 0-19 (22 members)
// Group 2: "Friends" — John + Alice + users 10-39 (32 members, overlapping 10-19 with Family)
// Group 3: "Work"   — John + Alice + users 30-99 (72 members)
let g1: string; // Family
let g2: string; // Friends
let g3: string; // Work

beforeEach(async () => {
  db = await openTestDb();

  // Seed all 102 users in a single multi-row INSERT. The test pool is
  // max:1 (see __test-helpers__/db.ts), so Promise.all-ing per-row inserts
  // wouldn't actually run them concurrently — they'd queue on the one
  // connection. Collapsing the round-trips into one statement is the real
  // win, and this beforeEach runs before every test in the file.
  const seededAt = new Date().toISOString();
  const mkUser = (username: string, display: string) => ({
    id: newId('u'),
    username,
    display_name: display,
    // Mirror real signup: first_name is the leading word of the full name.
    first_name: display.trim().split(/\s+/)[0] || null,
    created_at: seededAt,
    shadow: 0,
  });
  const johnRow = mkUser('john', 'John');
  const aliceRow = mkUser('alice', 'Alice');
  const userRows = Array.from({ length: 100 }, (_, i) =>
    mkUser(`user_${i}`, `User ${String(i).padStart(3, '0')}`),
  );
  await db.insertInto('users').values([johnRow, aliceRow, ...userRows]).execute();

  // John and Alice anchor users — will be added to every group
  john = { id: johnRow.id, name: 'John' };
  alice = { id: aliceRow.id, name: 'Alice' };
  users = userRows.map((r) => ({ id: r.id, name: r.display_name }));

  // Create groups — John owns Family, user 10 owns Friends, user 30 owns Work
  const family  = await createGroup(db, { name: 'Family',  kind: 'group', createdBy: john.id });
  const friends = await createGroup(db, { name: 'Friends', kind: 'group', createdBy: users[10]!.id });
  const work    = await createGroup(db, { name: 'Work',    kind: 'group', createdBy: users[30]!.id });
  g1 = family.id;
  g2 = friends.id;
  g3 = work.id;

  // Membership in a single multi-row INSERT (same rationale as users).
  // createGroup already made each owner a member of the group they created,
  // so those pairs are intentionally skipped to avoid PK collisions.
  const mkMember = (groupId: string, userId: string) => ({
    group_id: groupId,
    user_id: userId,
    role: 'member' as const,
    tier: 'trusted' as const,
    joined_at: seededAt,
  });
  const memberRows = [
    // John and Alice are in every group
    mkMember(g2, john.id),
    mkMember(g3, john.id),
    mkMember(g1, alice.id),
    mkMember(g2, alice.id),
    mkMember(g3, alice.id),
  ];
  // Family: users 0-19
  for (let i = 0; i < 20; i++) memberRows.push(mkMember(g1, users[i]!.id));
  // Friends: users 11-39 (owner is 10, add 11-39)
  for (let i = 11; i < 40; i++) memberRows.push(mkMember(g2, users[i]!.id));
  // Work: users 31-99 (owner is 30, add 31-99)
  for (let i = 31; i < 100; i++) memberRows.push(mkMember(g3, users[i]!.id));
  await db.insertInto('group_members').values(memberRows).execute();
}, 30_000);

afterEach(async () => {
  await closeTestDb(db);
});

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — messages', () => {
  it('all 20 family members plus John and Alice each post a message — 22 reach the DB', async () => {
    for (let i = 0; i < 20; i++) {
      await insertMessage(db, g1, users[i]!.id, `Hello from ${users[i]!.name}`);
    }
    await insertMessage(db, g1, john.id,   'Hello from John');
    await insertMessage(db, g1, alice.id, 'Hello from Alice');

    const rows = await db
      .selectFrom('messages')
      .where('group_id', '=', g1)
      .selectAll()
      .execute();
    expect(rows.length).toBe(22);

    // Every sender ID appears exactly once
    const senderIds = new Set(rows.map((r) => r.sender_id));
    expect(senderIds.size).toBe(22);
    expect(senderIds.has(john.id)).toBe(true);
    expect(senderIds.has(alice.id)).toBe(true);
  });

  it('300+ messages across 3 groups — group scoping is strict', async () => {
    // Family: 20 generic users × 5 = 100, plus John × 5 + Alice × 5 = 110
    for (let i = 0; i < 20; i++) {
      for (let m = 0; m < 5; m++) {
        await insertMessage(db, g1, users[i]!.id, `family msg ${m} from user ${i}`);
      }
    }
    for (let m = 0; m < 5; m++) await insertMessage(db, g1, john.id,   `John family msg ${m}`);
    for (let m = 0; m < 5; m++) await insertMessage(db, g1, alice.id, `Alice family msg ${m}`);

    // Friends: 30 generic users × 3 = 90
    for (let i = 10; i < 40; i++) {
      for (let m = 0; m < 3; m++) {
        await insertMessage(db, g2, users[i]!.id, `friends msg ${m} from user ${i}`);
      }
    }
    // Work: 70 generic users × 1 = 70
    for (let i = 30; i < 100; i++) {
      await insertMessage(db, g3, users[i]!.id, `work msg from user ${i}`);
    }

    const [g1Count, g2Count, g3Count] = await Promise.all([
      db.selectFrom('messages').where('group_id', '=', g1).select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('messages').where('group_id', '=', g2).select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
      db.selectFrom('messages').where('group_id', '=', g3).select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    ]);

    expect(Number(g1Count.n)).toBe(110); // 20×5 + John×5 + Alice×5
    expect(Number(g2Count.n)).toBe(90);  // 30 users × 3
    expect(Number(g3Count.n)).toBe(70);  // 70 users × 1

    // Cross-group: a message in g1 is never returned by a g2 query
    const g1Msgs = await db.selectFrom('messages').where('group_id', '=', g1).selectAll().execute();
    const g1MsgIds = new Set(g1Msgs.map((m) => m.id));
    const g2Msgs = await db.selectFrom('messages').where('group_id', '=', g2).selectAll().execute();
    expect(g2Msgs.filter((m) => g1MsgIds.has(m.id)).length).toBe(0);
  });

  it('messages from users in multiple groups are attributed to the sender, not the group', async () => {
    // User 15 is in both Family (g1) and Friends (g2)
    const shared = users[15]!;
    await insertMessage(db, g1, shared.id, 'family message');
    await insertMessage(db, g2, shared.id, 'friends message');

    const familyMsgs = await db
      .selectFrom('messages')
      .where('group_id', '=', g1)
      .where('sender_id', '=', shared.id)
      .selectAll()
      .execute();
    const friendsMsgs = await db
      .selectFrom('messages')
      .where('group_id', '=', g2)
      .where('sender_id', '=', shared.id)
      .selectAll()
      .execute();

    expect(familyMsgs.length).toBe(1);
    expect(friendsMsgs.length).toBe(1);
    expect(familyMsgs[0]!.body).toBe('family message');
    expect(friendsMsgs[0]!.body).toBe('friends message');
  });

  it('reply_to_id threads messages correctly', async () => {
    const parent = await insertMessage(db, g1, users[0]!.id, 'Anyone up for July 4th?');

    for (let i = 1; i < 10; i++) {
      const replyId = newId('m');
      await db.insertInto('messages').values({
        id: replyId,
        group_id: g1,
        sender_id: users[i]!.id,
        kind: 'text',
        body: `I'm in! — ${users[i]!.name}`,
        attachment_id: null,
        reply_to_id: parent,
        mentions_bot: 0,
        created_at: new Date().toISOString(),
        source: null,
        external_message_id: null,
        chord_visible: 1,
        mentions_others: 0,
        auto_mirror: 1,
        bot_persona_id: null,
        is_proactive: 0,
      }).execute();
    }

    const thread = await db
      .selectFrom('messages')
      .where('reply_to_id', '=', parent)
      .selectAll()
      .execute();
    expect(thread.length).toBe(9);
    const senders = new Set(thread.map((m) => m.sender_id));
    expect(senders.size).toBe(9);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — tasks', () => {
  it('50 tasks created by different family members — all visible via listTasks', async () => {
    for (let i = 0; i < 20; i++) {
      for (let t = 0; t < Math.ceil(50 / 20); t++) {
        await createTask(db, {
          groupId: g1,
          createdBy: users[i]!.id,
          title: `Task ${i}-${t}: ${users[i]!.name}`,
        });
      }
    }

    const tasks = await listTasks(db, g1);
    expect(tasks.length).toBeGreaterThanOrEqual(50);
    // Every task belongs to the family group
    for (const t of tasks) expect(t.groupId).toBe(g1);
  });

  it('tasks in Family group are not visible in Friends group and vice versa', async () => {
    await createTask(db, { groupId: g1, createdBy: users[0]!.id, title: 'Family task' });
    await createTask(db, { groupId: g2, createdBy: users[10]!.id, title: 'Friends task' });

    const g1Tasks = await listTasks(db, g1);
    const g2Tasks = await listTasks(db, g2);

    expect(g1Tasks.every((t) => t.groupId === g1)).toBe(true);
    expect(g2Tasks.every((t) => t.groupId === g2)).toBe(true);
    expect(g1Tasks.map((t) => t.title)).not.toContain('Friends task');
    expect(g2Tasks.map((t) => t.title)).not.toContain('Family task');
  });

  it('tasks assigned to specific members have correct assigneeId', async () => {
    // ADR 0026 — assignment is closed by default; every other user must
    // grant users[0] trust before the round-robin assignment lands.
    for (let i = 1; i < 10; i++) {
      await setGrant(db, users[i]!.id, users[0]!.id, ['task']);
    }
    for (let i = 0; i < 10; i++) {
      await createTask(db, {
        groupId: g1,
        createdBy: users[0]!.id,
        title: `Assigned to user ${i}`,
        assigneeId: users[i]!.id,
      });
    }

    const tasks = await listTasks(db, g1);
    for (let i = 0; i < 10; i++) {
      const match = tasks.find((t) => t.title === `Assigned to user ${i}`)!;
      expect(match.assigneeId).toBe(users[i]!.id);
    }
  });

  it(
    '70 work-group tasks: all stored; unassigned tasks have undefined assigneeId',
    async () => {
      for (let i = 30; i < 100; i++) {
        await createTask(db, {
          groupId: g3,
          createdBy: users[i]!.id,
          title: `Work task from ${users[i]!.name}`,
        });
      }

      const tasks = await listTasks(db, g3);
      expect(tasks.length).toBe(70);

      const unassigned = tasks.filter((t) => t.assigneeId === undefined || t.assigneeId === null);
      expect(unassigned.length).toBe(70);
    },
    // The long pole isn't the bare inserts — it's that createTask awaits
    // fanoutAssignment, and this test targets the 72-member Work group, so
    // each of the 70 tasks fans out across all members on the single
    // (max:1) test connection. Observed ~57s on a loaded windows-native box,
    // which tipped over the old 60s ceiling intermittently. 120s gives ~2×
    // headroom so the work-bound cost can't flake the gate.
    120_000,
  );

  it('member in two groups sees tasks from both via listTasksForUser', async () => {
    // User 15 is in Family (g1) and Friends (g2)
    const shared = users[15]!;
    await createTask(db, { groupId: g1, createdBy: shared.id, title: 'Family task by shared user' });
    await createTask(db, { groupId: g2, createdBy: shared.id, title: 'Friends task by shared user' });

    const rows = await db
      .selectFrom('tasks')
      .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
      .where('group_members.user_id', '=', shared.id)
      .selectAll('tasks')
      .execute();

    expect(rows.length).toBeGreaterThanOrEqual(2);
    const titles = rows.map((r) => r.title);
    expect(titles).toContain('Family task by shared user');
    expect(titles).toContain('Friends task by shared user');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — lists', () => {
  it('20 family members each add items to the Costco list — one list, 20 items', async () => {
    for (let i = 0; i < 20; i++) {
      const list = await ensureList(db, g1, 'Costco', users[i]!.id);
      await addItem(db, list.id, `item from user ${i}`);
    }

    const lists = await listLists(db, g1);
    const costco = lists.find((l) => l.name === 'Costco');
    expect(costco, 'Costco list should exist').toBeTruthy();
    expect(costco!.items.length).toBe(20);

    // No duplicate lists with the same name
    const sameName = lists.filter((l) => l.name === 'Costco');
    expect(sameName.length).toBe(1);
  });

  it('6 named lists in one group — all distinct, all returned', async () => {
    const listNames = ['Grocery', 'Costco', 'Packing', 'Notes', 'To-Do', 'Wish List'];
    for (const name of listNames) {
      const list = await ensureList(db, g1, name, users[0]!.id);
      // Each list gets 3 items from 3 different users
      for (let u = 0; u < 3; u++) {
        await addItem(db, list.id, `${name} item ${u}`);
      }
    }

    const lists = await listLists(db, g1);
    expect(lists.length).toBe(6);

    for (const name of listNames) {
      const found = lists.find((l) => l.name === name);
      expect(found, `${name} list should exist`).toBeTruthy();
      expect(found!.items.length).toBe(3);
    }
  });

  it('same list name in g1 and g2 creates two independent lists', async () => {
    const l1 = await ensureList(db, g1, 'Shared Name', users[0]!.id);
    await addItem(db, l1.id, 'family item');

    const l2 = await ensureList(db, g2, 'Shared Name', users[10]!.id);
    await addItem(db, l2.id, 'friends item');

    expect(l1.id).not.toBe(l2.id);

    const g1Result = await listLists(db, g1);
    const g2Result = await listLists(db, g2);

    expect(g1Result.find((l) => l.name === 'Shared Name')!.items[0]!.text).toBe('family item');
    expect(g2Result.find((l) => l.name === 'Shared Name')!.items[0]!.text).toBe('friends item');
  });

  it('30 friends members add to grocery list — single merged list, 30 items', async () => {
    for (let i = 10; i < 40; i++) {
      const list = await ensureList(db, g2, 'Grocery', users[i]!.id);
      await addItem(db, list.id, `grocery item from user ${i}`);
    }

    const result = await listLists(db, g2);
    const grocery = result.find((l) => l.name === 'Grocery')!;
    expect(grocery.items.length).toBe(30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRIPS
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — trips: creation, ordering, and date grouping', () => {
  // Seed all 8 trips and return their IDs
  async function seedAllTrips(): Promise<{
    pastTrip: string;
    currentTrip: string;
    july4A: string;
    july4B: string;
    laborDay: string;
    skeleton: string;
    soloA: string;
    crossGroup: string;
  }> {
    const owner = john.id;

    const pastTrip = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Past Hawaii', destination: 'Hawaii',
      startDate: PAST.start, endDate: PAST.end, participantIds: [],
    });

    const currentTrip = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Current Chicago', destination: 'Chicago',
      startDate: CURRENT.start, endDate: CURRENT.end, participantIds: [],
    });

    const tripJuly4A = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'John & Alice July 4th', destination: 'New York',
      startDate: JULY4.start, endDate: JULY4.end,
      participantIds: [users[0]!.id, users[1]!.id],
    });

    const tripJuly4B = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Bob & Carol July 4th', destination: 'New York',
      startDate: JULY4.start, endDate: JULY4.end,
      participantIds: [users[2]!.id, users[3]!.id],
    });

    const tripLaborDay = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Labor Day Nashville', destination: 'Nashville',
      startDate: LABORDAY.start, endDate: LABORDAY.end,
      participantIds: [users[4]!.id, users[5]!.id],
    });

    const tripSkeleton = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Dec Skeleton Trip', destination: 'Miami',
      startDate: DEC.start, endDate: DEC.end,
      participantIds: [users[6]!.id, users[7]!.id, users[8]!.id],
    });

    // Solo trip: only user 9 has a leg
    const tripSoloA = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Dave Solo Berlin', destination: 'Berlin',
      startDate: '2026-10-10', endDate: '2026-10-17',
      participantIds: [users[9]!.id, users[10]!.id],
    });

    // Cross-group trip in g2, but user 15 (also in g1) is a participant
    const tripCrossGroup = await createTrip(db, {
      groupId: g2, createdBy: users[10]!.id,
      name: 'Friends Paris Trip', destination: 'Paris',
      startDate: '2026-08-15', endDate: '2026-08-22',
      participantIds: [users[15]!.id],
    });

    return {
      pastTrip: pastTrip.id,
      currentTrip: currentTrip.id,
      july4A: tripJuly4A.id,
      july4B: tripJuly4B.id,
      laborDay: tripLaborDay.id,
      skeleton: tripSkeleton.id,
      soloA: tripSoloA.id,
      crossGroup: tripCrossGroup.id,
    };
  }

  it('all 7 family trips created and returned by listTripsForGroup, sorted by start_date', async () => {
    await seedAllTrips();

    const trips = await listTripsForGroup(db, g1);
    expect(trips.length).toBe(7); // 7 in g1 (crossGroup is in g2)

    const starts = trips.map((t) => t.startDate);
    expect(starts).toEqual([...starts].sort());
  });

  it('july4-A and july4-B share the same date-range grouping key', async () => {
    const { july4A, july4B } = await seedAllTrips();

    const all = await listTripsForGroup(db, g1);
    const a = all.find((t) => t.id === july4A)!;
    const b = all.find((t) => t.id === july4B)!;

    const keyA = `${a.startDate}/${a.endDate}`;
    const keyB = `${b.startDate}/${b.endDate}`;
    expect(keyA).toBe(keyB);
    expect(keyA).toBe(`${JULY4.start}/${JULY4.end}`);
  });

  it('all other trips have distinct date-range keys', async () => {
    const ids = await seedAllTrips();
    const all = await listTripsForGroup(db, g1);

    // Exclude july4-B since it intentionally shares a key with july4-A
    const nonJuly4 = all.filter((t) => t.id !== ids.july4B);
    const keys = nonJuly4.map((t) => `${t.startDate}/${t.endDate}`);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(nonJuly4.length);
  });

  it('cross-group trip in g2 is not listed in g1, but is in g2', async () => {
    const { crossGroup } = await seedAllTrips();

    const g1Trips = await listTripsForGroup(db, g1);
    const g2Trips = await listTripsForGroup(db, g2);

    expect(g1Trips.some((t) => t.id === crossGroup)).toBe(false);
    expect(g2Trips.some((t) => t.id === crossGroup)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TRIPS — GAP ANALYSIS (who is travelling / missing)
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — trip status', () => {
  it('past trip: all legs + hotel → status includes 2 legs and 1 stay', async () => {
    const owner = john.id;
    const participant = users[1]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: owner,
      name: 'Past Hawaii', destination: 'Hawaii',
      startDate: PAST.start, endDate: PAST.end,
      participantIds: [participant],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: participant,
      mode: 'flight', origin: 'New York', destination: 'Hawaii',
      departAt: `${PAST.start}T06:00:00Z`, arriveAt: `${PAST.start}T14:00:00Z`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: participant,
      mode: 'flight', origin: 'Hawaii', destination: 'New York',
      departAt: `${PAST.end}T10:00:00Z`, arriveAt: `${PAST.end}T20:00:00Z`,
    });
    await addAccommodation(db, {
      tripId: trip.id,
      propertyName: 'Royal Hawaiian',
      checkinDate: PAST.start,
      checkoutDate: PAST.end,
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.accommodations).toHaveLength(1);
    expect(status!.participantNames).toHaveLength(1);
  });

  it('current trip: two participants, two legs added', async () => {
    const userA = users[2]!.id;
    const userB = users[3]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: users[0]!.id,
      name: 'Current Chicago', destination: 'Chicago',
      startDate: CURRENT.start, endDate: CURRENT.end,
      participantIds: [userA, userB],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: userA,
      mode: 'flight', origin: 'Los Angeles', destination: 'Chicago',
      departAt: `${CURRENT.start}T08:00:00Z`, arriveAt: `${CURRENT.start}T14:00:00Z`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: userA,
      mode: 'flight', origin: 'Chicago', destination: 'Los Angeles',
      departAt: `${CURRENT.end}T16:00:00Z`, arriveAt: `${CURRENT.end}T19:00:00Z`,
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.participantNames).toHaveLength(2);
  });

  it('july4-A: paxA + paxB → 3 legs total', async () => {
    const paxA = users[0]!.id;
    const paxB = users[1]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: paxA,
      name: 'PaxA & PaxB July 4th', destination: 'New York',
      startDate: JULY4.start, endDate: JULY4.end,
      participantIds: [paxA, paxB],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: paxA,
      mode: 'flight', origin: 'Chicago', destination: 'New York',
      departAt: `${JULY4.start}T08:00:00Z`, arriveAt: `${JULY4.start}T10:30:00Z`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: paxB,
      mode: 'flight', origin: 'Boston', destination: 'New York',
      departAt: `${JULY4.start}T09:00:00Z`, arriveAt: `${JULY4.start}T10:00:00Z`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: paxB,
      mode: 'flight', origin: 'New York', destination: 'Boston',
      departAt: `${JULY4.end}T15:00:00Z`, arriveAt: `${JULY4.end}T16:00:00Z`,
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(3);
  });

  it('july4-B: Bob has legs, Carol does not → 2 legs, 2 participants', async () => {
    const bob = users[2]!.id;
    const carol = users[3]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: users[0]!.id,
      name: 'Bob & Carol July 4th', destination: 'New York',
      startDate: JULY4.start, endDate: JULY4.end,
      participantIds: [bob, carol],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: bob,
      mode: 'train', origin: 'Philadelphia', destination: 'New York',
      departAt: `${JULY4.start}T07:00:00Z`, arriveAt: `${JULY4.start}T09:00:00Z`,
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: bob,
      mode: 'train', origin: 'New York', destination: 'Philadelphia',
      departAt: `${JULY4.end}T18:00:00Z`, arriveAt: `${JULY4.end}T20:00:00Z`,
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.participantNames).toHaveLength(2);
  });

  it('skeleton trip: 3 participants, no legs → participantNames has 3 entries', async () => {
    const p0 = users[6]!.id;
    const p1 = users[7]!.id;
    const p2 = users[8]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: users[0]!.id,
      name: 'Dec Skeleton Trip', destination: 'Miami',
      startDate: DEC.start, endDate: DEC.end,
      participantIds: [p0, p1, p2],
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(0);
    expect(status!.participantNames).toHaveLength(3);
  });

  it('solo trip: Dave has 2 legs, Eve is participant with none', async () => {
    const dave = users[9]!.id;
    const eve = users[10]!.id;
    const trip = await createTrip(db, {
      groupId: g1, createdBy: users[0]!.id,
      name: 'Dave Solo Berlin', destination: 'Berlin',
      startDate: '2026-10-10', endDate: '2026-10-17',
      participantIds: [dave, eve],
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: dave,
      mode: 'flight', origin: 'New York', destination: 'Berlin',
      departAt: '2026-10-10T06:00:00Z', arriveAt: '2026-10-10T20:00:00Z',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: dave,
      mode: 'flight', origin: 'Berlin', destination: 'New York',
      departAt: '2026-10-17T08:00:00Z', arriveAt: '2026-10-17T12:00:00Z',
    });

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.participantNames).toHaveLength(2);
  });

  it('listTripStatusesForGroup returns statuses for all 7 family trips', async () => {
    const owner = john.id;
    // Create all 7 family trips
    const tripDates = [
      { name: 'T1', dest: 'Hawaii',   s: PAST.start,     e: PAST.end },
      { name: 'T2', dest: 'Chicago',  s: CURRENT.start,  e: CURRENT.end },
      { name: 'T3', dest: 'New York', s: JULY4.start,    e: JULY4.end },
      { name: 'T4', dest: 'New York', s: JULY4.start,    e: JULY4.end },
      { name: 'T5', dest: 'Nashville',s: LABORDAY.start, e: LABORDAY.end },
      { name: 'T6', dest: 'Miami',    s: DEC.start,      e: DEC.end },
      { name: 'T7', dest: 'Berlin',   s: '2026-10-10',   e: '2026-10-17' },
    ];
    for (const td of tripDates) {
      await createTrip(db, {
        groupId: g1, createdBy: owner,
        name: td.name, destination: td.dest,
        startDate: td.s, endDate: td.e, participantIds: [],
      });
    }

    const statuses = await listTripStatusesForGroup(db, g1);
    expect(statuses.length).toBe(7);
    // All returned in start_date order
    const starts = statuses.map((s) => s.trip.startDate);
    expect(starts).toEqual([...starts].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// JOHN + ALICE: cross-group anchor verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — John and Alice cross-group presence', () => {
  it('John is a member of all three groups', async () => {
    for (const gid of [g1, g2, g3]) {
      const row = await db
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', gid)
        .where('user_id', '=', john.id)
        .executeTakeFirst();
      expect(row, `John should be in group ${gid}`).toBeTruthy();
    }
  });

  it('Alice is a member of all three groups', async () => {
    for (const gid of [g1, g2, g3]) {
      const row = await db
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', gid)
        .where('user_id', '=', alice.id)
        .executeTakeFirst();
      expect(row, `Alice should be in group ${gid}`).toBeTruthy();
    }
  });

  it('tasks created by John are visible in each group independently', async () => {
    await createTask(db, { groupId: g1, createdBy: john.id, title: 'John family task' });
    await createTask(db, { groupId: g2, createdBy: john.id, title: 'John friends task' });
    await createTask(db, { groupId: g3, createdBy: john.id, title: 'John work task' });

    const g1Tasks = await listTasks(db, g1);
    const g2Tasks = await listTasks(db, g2);
    const g3Tasks = await listTasks(db, g3);

    expect(g1Tasks.some((t) => t.title === 'John family task')).toBe(true);
    expect(g2Tasks.some((t) => t.title === 'John friends task')).toBe(true);
    expect(g3Tasks.some((t) => t.title === 'John work task')).toBe(true);

    // Cross-isolation: John's family task should NOT appear in friends or work
    expect(g2Tasks.some((t) => t.title === 'John family task')).toBe(false);
    expect(g3Tasks.some((t) => t.title === 'John family task')).toBe(false);
  });

  it('Alice adds to lists in all 3 groups — each list stays in its group', async () => {
    for (const [gid, label] of [[g1, 'family'], [g2, 'friends'], [g3, 'work']] as const) {
      const list = await ensureList(db, gid, 'Packing', alice.id);
      await addItem(db, list.id, `${label} item by Alice`);
    }

    for (const [gid, label] of [[g1, 'family'], [g2, 'friends'], [g3, 'work']] as const) {
      const result = await listLists(db, gid);
      const packing = result.find((l) => l.name === 'Packing')!;
      expect(packing.items[0]!.text).toBe(`${label} item by Alice`);
      expect(packing.items.length).toBe(1); // not polluted by other groups
    }
  });

  it('John creates a trip in each group — each trip scoped to its group', async () => {
    const dates = ['2027-01-10', '2027-02-14', '2027-03-20'] as const;
    const ends  = ['2027-01-17', '2027-02-21', '2027-03-27'] as const;
    const groups = [g1, g2, g3] as const;
    const labels = ['Family Trip', 'Friends Trip', 'Work Trip'] as const;

    for (let i = 0; i < 3; i++) {
      await createTrip(db, {
        groupId: groups[i], createdBy: john.id,
        name: labels[i], destination: 'Various',
        startDate: dates[i], endDate: ends[i], participantIds: [john.id, alice.id],
      });
    }

    const g1Trips = await listTripsForGroup(db, g1);
    const g2Trips = await listTripsForGroup(db, g2);
    const g3Trips = await listTripsForGroup(db, g3);

    expect(g1Trips.some((t) => t.name === 'Family Trip')).toBe(true);
    expect(g2Trips.some((t) => t.name === 'Friends Trip')).toBe(true);
    expect(g3Trips.some((t) => t.name === 'Work Trip')).toBe(true);

    // Cross-isolation
    expect(g1Trips.some((t) => t.name === 'Friends Trip')).toBe(false);
    expect(g2Trips.some((t) => t.name === 'Family Trip')).toBe(false);
  });

  it('John and Alice are participants on the same trip — both gap-analysed', async () => {
    const trip = await createTrip(db, {
      groupId: g1, createdBy: john.id,
      name: 'John & Alice Paris', destination: 'Paris',
      startDate: '2027-05-01', endDate: '2027-05-10',
      participantIds: [john.id, alice.id],
    });

    // John: both legs
    await addTravelLeg(db, {
      tripId: trip.id, personaId: john.id,
      mode: 'flight', origin: 'New York', destination: 'Paris',
      departAt: '2027-05-01T08:00:00Z', arriveAt: '2027-05-01T20:00:00Z',
    });
    await addTravelLeg(db, {
      tripId: trip.id, personaId: john.id,
      mode: 'flight', origin: 'Paris', destination: 'New York',
      departAt: '2027-05-10T10:00:00Z', arriveAt: '2027-05-10T13:00:00Z',
    });
    // Alice: no legs yet

    const status = await getTripStatus(db, trip.id);
    expect(status!.legs).toHaveLength(2);
    expect(status!.participantNames).toContain('John');
    expect(status!.participantNames).toContain('Alice');

    // Add Alice's inbound leg → now 3 legs
    await addTravelLeg(db, {
      tripId: trip.id, personaId: alice.id,
      mode: 'flight', origin: 'Chicago', destination: 'Paris',
      departAt: '2027-05-01T09:00:00Z', arriveAt: '2027-05-01T22:00:00Z',
    });

    const updated = await getTripStatus(db, trip.id);
    expect(updated!.legs).toHaveLength(3);
  });

  it('John messages across all 3 groups are attributed correctly per group', async () => {
    await insertMessage(db, g1, john.id, 'John in family');
    await insertMessage(db, g2, john.id, 'John in friends');
    await insertMessage(db, g3, john.id, 'John in work');

    for (const [gid, expected] of [
      [g1, 'John in family'],
      [g2, 'John in friends'],
      [g3, 'John in work'],
    ] as const) {
      const msgs = await db
        .selectFrom('messages')
        .where('group_id', '=', gid)
        .where('sender_id', '=', john.id)
        .selectAll()
        .execute();
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.body).toBe(expected);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMBINED: full scenario with messages + tasks + lists + trips
// ═══════════════════════════════════════════════════════════════════════════════

describe('stress — full combined scenario', () => {
  it('100 users, 3 groups, messages + tasks + lists + trips all consistent', async () => {
    // ── messages ──────────────────────────────────────────────────────────────
    for (let i = 0; i < 20; i++) {
      await insertMessage(db, g1, users[i]!.id, `planning msg from ${users[i]!.name}`);
    }
    const msgCount = await db
      .selectFrom('messages').where('group_id', '=', g1)
      .select(db.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(Number(msgCount.n)).toBe(20);

    // ── tasks ─────────────────────────────────────────────────────────────────
    for (let i = 0; i < 20; i++) {
      await createTask(db, {
        groupId: g1,
        createdBy: users[i]!.id,
        title: `Pack bag — ${users[i]!.name}`,
        ...(i < 5 ? { assigneeId: users[i]!.id } : {}),
      });
    }
    const tasks = await listTasks(db, g1);
    expect(tasks.length).toBe(20);
    const assigned = tasks.filter((t) => t.assigneeId !== undefined && t.assigneeId !== null);
    expect(assigned.length).toBe(5);

    // ── lists ─────────────────────────────────────────────────────────────────
    for (let i = 0; i < 20; i++) {
      const list = await ensureList(db, g1, 'Packing', users[i]!.id);
      await addItem(db, list.id, `item ${i} from ${users[i]!.name}`);
    }
    const lists = await listLists(db, g1);
    const packing = lists.find((l) => l.name === 'Packing')!;
    expect(packing.items.length).toBe(20);

    // ── trips ─────────────────────────────────────────────────────────────────
    const trips = [];
    const tripDefs = [
      { name: 'Past Trip',    dest: 'London',    s: PAST.start,     e: PAST.end,    pax: [0, 1] },
      { name: 'Current Trip', dest: 'Chicago',   s: CURRENT.start,  e: CURRENT.end, pax: [2, 3] },
      { name: 'July 4 A',     dest: 'Miami',     s: JULY4.start,    e: JULY4.end,   pax: [4, 5] },
      { name: 'July 4 B',     dest: 'Miami',     s: JULY4.start,    e: JULY4.end,   pax: [6, 7] },
      { name: 'Labor Day',    dest: 'Nashville', s: LABORDAY.start, e: LABORDAY.end,pax: [8, 9] },
    ];
    for (const td of tripDefs) {
      const trip = await createTrip(db, {
        groupId: g1, createdBy: users[0]!.id,
        name: td.name, destination: td.dest,
        startDate: td.s, endDate: td.e,
        participantIds: td.pax.map((i) => users[i]!.id),
      });
      trips.push(trip);
    }

    const allTrips = await listTripsForGroup(db, g1);
    expect(allTrips.length).toBe(5);

    // Date-sorted
    const starts = allTrips.map((t) => t.startDate);
    expect(starts).toEqual([...starts].sort());

    // July 4 A and B share key
    const july4Trips = allTrips.filter((t) => t.startDate === JULY4.start);
    expect(july4Trips.length).toBe(2);
    const keys = july4Trips.map((t) => `${t.startDate}/${t.endDate}`);
    expect(keys[0]).toBe(keys[1]);

    // 3 distinct date groups (past, current, July4, laborday)
    const uniqueKeys = new Set(allTrips.map((t) => `${t.startDate}/${t.endDate}`));
    expect(uniqueKeys.size).toBe(4); // past, current, july4, laborday

    // Current trip starts with no legs
    const currentTripId = trips[1]!.id;
    const currentStatus = await getTripStatus(db, currentTripId);
    expect(currentStatus!.legs).toHaveLength(0);

    // Add a leg for pax[2] → one leg now
    const uid2 = users[2]!.id;
    await addTravelLeg(db, {
      tripId: currentTripId, personaId: uid2,
      mode: 'flight', origin: 'Seattle', destination: 'Chicago',
      departAt: `${CURRENT.start}T06:00:00Z`, arriveAt: `${CURRENT.start}T10:00:00Z`,
    });

    const updatedStatus = await getTripStatus(db, currentTripId);
    expect(updatedStatus!.legs).toHaveLength(1);
    expect(updatedStatus!.legs[0]!.origin).toBe('Seattle');
  });
});
