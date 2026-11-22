/**
 * Simulation delete (script 2 of 2 — pairs with `sim-seed.ts`).
 *
 * Deletes 50 random users from the `sim_u*` cohort via the real account-
 * deletion path (`deleteAccount`, ADR 0043), against the configured database
 * (DATABASE_URL). Because `john` sits in every Sim Group, none are torn down —
 * each delete takes the keep-and-anonymize + reassign-ownership path, so after
 * this runs `john` still sees all 20 groups.
 *
 * Run AFTER `npm run sim:seed`, while signed in as john to watch the groups
 * survive: npm run sim:delete   (from repo root, or --workspace=server)
 */
import { pathToFileURL } from 'node:url';

import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { deleteAccount } from '../services/account.service.js';

const NUM_DELETE = 50;
const SIM_USER_PREFIX = 'sim_u';

type Db = ReturnType<typeof openDb>;

/** Fisher–Yates over a copy; genuinely random selection each run. */
function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

async function run(db: Db): Promise<void> {
  // `_` is a LIKE wildcard, so `sim_u%` also matches the literal underscore.
  const cohort = await db
    .selectFrom('users')
    .select(['id', 'username'])
    .where('username', 'like', `${SIM_USER_PREFIX}%`)
    .execute();
  console.log(`[sim:delete] cohort found: ${cohort.length} ${SIM_USER_PREFIX}* users`);
  if (cohort.length === 0) {
    console.log('[sim:delete] nothing to delete — run `npm run sim:seed` first');
    return;
  }

  const toDelete = sample(cohort, Math.min(NUM_DELETE, cohort.length));
  console.log(`[sim:delete] deleting ${toDelete.length} of ${cohort.length} sim users…`);

  let reassigned = 0;
  for (const u of toDelete) {
    const res = await deleteAccount(db, u.id);
    reassigned += res.groupsReassigned;
    logger.warn(`deleted ${u.username}`, res);
  }

  const remaining = await db
    .selectFrom('users')
    .select('id')
    .where('username', 'like', `${SIM_USER_PREFIX}%`)
    .execute();
  const groups = await db
    .selectFrom('groups')
    .select('id')
    .where('name', 'like', 'Sim Group %')
    .execute();
  console.log(
    `[sim:delete] done: ${toDelete.length} deleted (${reassigned} group ownerships reassigned), ` +
      `${remaining.length} sim users remain, ${groups.length} Sim Groups still present.`,
  );
}

async function main(): Promise<void> {
  const db = openDb();
  try {
    await run(db);
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
