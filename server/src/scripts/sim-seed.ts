/**
 * Simulation seed (script 1 of 2 — pairs with `sim-delete.ts`).
 *
 * Populates the *real* configured database (DATABASE_URL) with a 100-user
 * cohort that shares 20 groups, seeds lists + tasks across them, and makes
 * `john` a member of every group — so after `sim-delete` removes 50 of the
 * cohort, `john` still sees all 20 groups (each kept alive + reassigned).
 *
 * Identifiable + idempotent: cohort usernames are `sim_u0..sim_u99`, groups are
 * named `Sim Group N`. Re-running is a no-op once `Sim Group 0` exists.
 *
 * Run: npm run sim:seed   (from repo root, or --workspace=server)
 */
import { pathToFileURL } from 'node:url';

import { nanoid } from 'nanoid';

import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createGroup, ensurePersonalGroup } from '../services/groups.service.js';

const NUM_USERS = 100;
const NUM_GROUPS = 20;
const LISTS_PER_GROUP = 3;
const TASKS_PER_GROUP = 3;
const SIM_USER_PREFIX = 'sim_u';
const SIM_GROUP_PREFIX = 'Sim Group ';

type Db = ReturnType<typeof openDb>;
const now = () => new Date().toISOString();
const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

async function upsertUser(db: Db, username: string, displayName: string): Promise<string> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst();
  if (existing) {
    await ensurePersonalGroup(db, existing.id);
    return existing.id;
  }
  const id = `u_${nanoid(12)}`;
  await db
    .insertInto('users')
    .values({
      id,
      username,
      display_name: displayName,
      first_name: displayName.split(/\s+/)[0] ?? displayName,
      created_at: now(),
      shadow: 0,
    })
    .execute();
  await ensurePersonalGroup(db, id);
  return id;
}

async function addMember(db: Db, groupId: string, userId: string): Promise<void> {
  const existing = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (existing) return;
  await db
    .insertInto('group_members')
    .values({ group_id: groupId, user_id: userId, role: 'member', tier: 'trusted', joined_at: now() })
    .execute();
}

async function seedSim(db: Db): Promise<void> {
  const already = await db
    .selectFrom('groups')
    .select('id')
    .where('name', '=', `${SIM_GROUP_PREFIX}0`)
    .executeTakeFirst();
  if (already) {
    logger.warn('sim cohort already seeded — skipping (delete the Sim Group * groups to reseed)');
    return;
  }

  // john joins every group; upsert so the script works on a fresh DB too.
  const john = await upsertUser(db, 'john', 'John Doe');

  const userIds: string[] = [];
  for (let i = 0; i < NUM_USERS; i++) {
    userIds.push(await upsertUser(db, `${SIM_USER_PREFIX}${i}`, `Sim User ${i}`));
  }

  for (let i = 0; i < NUM_GROUPS; i++) {
    const creator = pick(userIds);
    const g = await createGroup(db, { name: `${SIM_GROUP_PREFIX}${i}`, kind: 'group', createdBy: creator });
    const members = new Set<string>([creator]); // createGroup already added the creator (owner)
    const size = 3 + Math.floor(Math.random() * 5); // 3–7 cohort members
    while (members.size < size) members.add(pick(userIds));
    for (const m of members) if (m !== creator) await addMember(db, g.id, m);
    await addMember(db, g.id, john); // john in EVERY group
    members.add(john);

    const mem = [...members];
    for (let j = 0; j < LISTS_PER_GROUP; j++) {
      const listId = `l_${nanoid(12)}`;
      await db
        .insertInto('lists')
        .values({ id: listId, group_id: g.id, name: `Sim List ${j}`, created_by: pick(mem), created_at: now() })
        .execute();
      await db
        .insertInto('list_items')
        .values({ id: `li_${nanoid(12)}`, list_id: listId, text: `Item ${j + 1}`, checked: 0, created_at: now() })
        .execute();
    }
    for (let j = 0; j < TASKS_PER_GROUP; j++) {
      await db
        .insertInto('tasks')
        .values({ id: `t_${nanoid(12)}`, group_id: g.id, title: `Sim Task ${j + 1}`, status: 'open', created_by: pick(mem), created_at: now() })
        .execute();
    }
  }

  logger.warn(
    `sim seed done: ${NUM_USERS} users (${SIM_USER_PREFIX}0..${SIM_USER_PREFIX}${NUM_USERS - 1}), ` +
      `${NUM_GROUPS} groups, ${LISTS_PER_GROUP} lists + ${TASKS_PER_GROUP} tasks each; john is in every group. ` +
      `Sign in (demo) as john or any sim_uN to verify.`,
  );
}

async function main(): Promise<void> {
  await runMigrations();
  const db = openDb();
  try {
    await seedSim(db);
  } finally {
    await db.destroy();
  }
}

// Cross-platform entry check: `file://${argv[1]}` mismatches on Windows
// (backslashes + drive letter), so use pathToFileURL.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
