/**
 * ADR 0231 — run ONCE, just before BILLING_ENABLED goes true: everyone who
 * has an account before the cutoff keeps the individual allowance free,
 * permanently.
 *
 * Dry run by default (prints the counts); `--apply` writes. Safe to re-run —
 * it never moves an existing flag.
 *
 * Usage:
 *   npm run grandfather:users --workspace=server -- --before 2026-11-01
 *   npm run grandfather:users --workspace=server -- --before 2026-11-01 --apply
 *   npm run grandfather:users --workspace=server -- --user <userId> [--off]   (one person)
 */
import { openDb } from '../db/index.js';
import { ensureDataDirs } from '../db/paths.js';
import {
  grandfatherUsersCreatedBefore,
  previewGrandfather,
  setGrandfathered,
} from '../services/grandfather.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  ensureDataDirs();
  const db = openDb();
  try {
    const userId = arg('--user');
    if (userId) {
      const on = !process.argv.includes('--off');
      const ok = await setGrandfathered(db, userId, on);
      console.log(ok ? `${userId}: grandfathered = ${on}` : `${userId}: no such user`);
      return;
    }
    const before = arg('--before');
    if (!before || Number.isNaN(Date.parse(before))) {
      console.error('usage: --before <ISO date, e.g. 2026-11-01> [--apply]   |   --user <userId> [--off]');
      process.exitCode = 1;
      return;
    }
    const beforeIso = new Date(before).toISOString();
    const preview = await previewGrandfather(db, beforeIso);
    console.log(`created before ${beforeIso}: ${preview.eligible} to flag, ${preview.already} already flagged`);
    if (!process.argv.includes('--apply')) {
      console.log('dry run - pass --apply to write');
      return;
    }
    console.log(`flagged ${await grandfatherUsersCreatedBefore(db, beforeIso)} account(s)`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
