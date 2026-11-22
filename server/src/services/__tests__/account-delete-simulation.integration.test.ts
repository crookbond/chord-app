/**
 * Account-deletion stress simulation (ADR 0043). Spins up a 100-user world
 * that shares groups, seeds lists + tasks across all of them, makes `john` a
 * member of *every* group, waits, then deletes 50 random users and checks the
 * logs + referential integrity.
 *
 * Why john-in-every-group matters: a group is only hard-deleted when its
 * departing member is the *last* one. Since john is never deleted and sits in
 * every group, no group should ever be torn down — each delete takes the
 * "shared group: keep + anonymize, reassign ownership" path. So the invariants
 * after the churn are strong: all groups survive, every `created_by` points at
 * a surviving user, and no row dangles at a deleted account.
 *
 * NOTE: includes a real 30s pause by request, so the test timeout is generous.
 * Run it on its own: `npm test --workspace=server -- account-delete-simulation`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { logger } from '@/config/logging.js';
import { createGroup } from '@/services/groups.service.js';
import { deleteAccount } from '@/services/account.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const NUM_USERS = 100;
const NUM_GROUPS = 20;
const NUM_DELETE = 50;
const WAIT_MS = 30_000;

const now = () => new Date().toISOString();

/** Deterministic PRNG (mulberry32) so a failing run reproduces. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;
function sample<T>(rng: () => number, arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

describe('deleteAccount — 100-user simulation', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
    vi.restoreAllMocks();
  });

  it(
    'deletes 50 random users without orphaning shared data',
    async () => {
      const rng = makeRng(1337);

      // ── 100 users + john, who joins every group ───────────────────────
      const userIds: string[] = [];
      for (let i = 0; i < NUM_USERS; i++) {
        userIds.push(await createUser(db, `sim_u${i}`, `User ${i}`));
      }
      const john = await createUser(db, 'john', 'John');

      // ── groups: random creator + 3–7 random members, plus john ────────
      const groups: Array<{ id: string; members: string[] }> = [];
      for (let i = 0; i < NUM_GROUPS; i++) {
        const creator = pick(rng, userIds);
        const g = await createGroup(db, { name: `Group ${i}`, kind: 'group', createdBy: creator });
        const members = new Set<string>([creator]); // createGroup already added the creator
        const size = 3 + Math.floor(rng() * 5);
        while (members.size < size) members.add(pick(rng, userIds));
        for (const m of members) {
          if (m !== creator) await addMember(db, g.id, m, 'member');
        }
        await addMember(db, g.id, john, 'member'); // john in EVERY group
        members.add(john);
        groups.push({ id: g.id, members: [...members] });
      }

      // ── seed lists + tasks for all groups (creator = a random member) ──
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi]!;
        for (let j = 0; j < 3; j++) {
          await db
            .insertInto('lists')
            .values({ id: `l_${gi}_${j}`, group_id: g.id, name: `List ${j}`, created_by: pick(rng, g.members), created_at: now() })
            .execute();
          await db
            .insertInto('tasks')
            .values({ id: `t_${gi}_${j}`, group_id: g.id, title: `Task ${j}`, status: 'open', created_by: pick(rng, g.members), created_at: now() })
            .execute();
        }
      }

      // ── wait 30s (by request) ──────────────────────────────────────────
      await new Promise((resolve) => setTimeout(resolve, WAIT_MS));

      // ── delete 50 random users (never john), watching the logs ────────
      const warnSpy = vi.spyOn(logger, 'warn');
      const toDelete = sample(rng, userIds, NUM_DELETE);
      const deletedSet = new Set(toDelete);
      for (const u of toDelete) {
        await deleteAccount(db, u);
      }

      // "check logs": one `account deleted` line per deletion. winston's `warn`
      // is overloaded, so the mock infers a single-arg `[object]` tuple — widen
      // to (message, meta) to read both args.
      const calls = warnSpy.mock.calls as unknown as Array<[unknown, unknown]>;
      const deletionLogs = calls.filter((c) => c[0] === 'account deleted');
      expect(deletionLogs).toHaveLength(NUM_DELETE);
      // eslint-disable-next-line no-console
      console.log(
        `simulation: deleted ${deletionLogs.length}/${NUM_USERS} users; ` +
          `${NUM_GROUPS} groups seeded; sample log:`,
        deletionLogs[0]?.[1],
      );

      const survivors = new Set<string>([...userIds.filter((u) => !deletedSet.has(u)), john]);

      // Deleted users are gone; everyone else (incl. john) remains.
      const remaining = await db.selectFrom('users').select('id').execute();
      const remainingIds = new Set(remaining.map((r) => r.id));
      expect(remainingIds.size).toBe(NUM_USERS - NUM_DELETE + 1);
      expect(remainingIds.has(john)).toBe(true);
      for (const u of toDelete) expect(remainingIds.has(u)).toBe(false);

      // Every group survives (john kept each alive) and is owned by a survivor.
      const groupRows = await db.selectFrom('groups').select(['id', 'created_by']).execute();
      expect(groupRows).toHaveLength(NUM_GROUPS);
      for (const g of groupRows) {
        expect(survivors.has(g.created_by)).toBe(true);
      }

      // john is still a member of every group.
      const johnGroups = await db
        .selectFrom('group_members')
        .select('group_id')
        .where('user_id', '=', john)
        .execute();
      expect(johnGroups).toHaveLength(NUM_GROUPS);

      // No list/task/membership dangles at a deleted account: created_by is
      // either NULL (anonymized) or a survivor; memberships are survivors only.
      const lists = await db.selectFrom('lists').select('created_by').execute();
      for (const l of lists) expect(l.created_by === null || survivors.has(l.created_by)).toBe(true);
      const tasks = await db.selectFrom('tasks').select('created_by').execute();
      for (const t of tasks) expect(t.created_by === null || survivors.has(t.created_by)).toBe(true);
      const memberUserIds = await db.selectFrom('group_members').select('user_id').distinct().execute();
      for (const m of memberUserIds) expect(survivors.has(m.user_id)).toBe(true);
    },
    WAIT_MS + 120_000,
  );
});
