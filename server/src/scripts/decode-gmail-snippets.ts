/**
 * One-off: decode the HTML-escaped Gmail previews stored before sync decoded
 * them (`haven&#39;t` in the thread list). See
 * `services/email/gmail-snippet-heal.ts` for why this is not a migration.
 *
 * Dry run by default; `--apply` writes. Run it once.
 *
 * Usage:
 *   npm run decode:gmail-snippets --workspace=server
 *   npm run decode:gmail-snippets --workspace=server -- --apply
 *   npm run decode:gmail-snippets --workspace=server -- --user you@example.com --apply
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import { decodeStoredGmailSnippets } from '../services/email/gmail-snippet-heal.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const userArg = argv.includes('--user') ? (argv[argv.indexOf('--user') + 1] ?? '') : '';

  ensureDataDirs();
  const db = openDb();
  try {
    let q = db.selectFrom('users').select(['id']);
    if (userArg) q = q.where((eb) => eb.or([eb('id', '=', userArg), eb('email', 'ilike', userArg)]));
    const users = await q.execute();
    if (users.length === 0) {
      console.error(userArg ? `no user matches "${userArg}"` : 'no users');
      process.exit(1);
    }

    let scanned = 0;
    let changed = 0;
    let threads = 0;
    for (const u of users) {
      const r = await decodeStoredGmailSnippets(db, u.id, { apply });
      scanned += r.scanned;
      changed += r.changed;
      threads += r.threads;
      if (r.changed > 0) console.log(`  ${u.id}: ${r.changed} of ${r.scanned} previews, ${r.threads} threads`);
    }
    console.log('');
    console.log(`${users.length} user(s), ${scanned} Gmail messages scanned, ${changed} previews to decode in ${threads} threads.`);
    console.log(apply ? 'Applied.' : 'Dry run - nothing written. Re-run with --apply.');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
