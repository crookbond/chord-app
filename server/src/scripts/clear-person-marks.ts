/**
 * One-off recovery for docs/notes/0191: before provisional people existed,
 * facts about a person the user had not yet confirmed were dropped, and the
 * thread was then stamped mined so it was never read again. Clearing the
 * `person` extraction mark lets the next sync re-read the thread with the
 * fixed pass.
 *
 * Default scope is the threads that staged an `add_person` proposal (any
 * status except rejected) — those are exactly the ones that met an unseen
 * person and could have lost facts. A rejected proposal is left marked, or
 * the person the user said no to would be proposed again. `--all` clears
 * every `person` mark for the user instead, which re-mines the whole mailbox.
 *
 * Dry run by default; `--apply` deletes the marks. Subjects and sender
 * addresses are masked in the output unless `--show-content` is passed.
 *
 * Usage:
 *   npm run clear:person-marks --workspace=server -- --user you@example.com
 *   npm run clear:person-marks --workspace=server -- --user you@example.com --apply
 *   npm run clear:person-marks --workspace=server -- --user <userId> --all --apply
 */
import { ensureDataDirs } from '../db/paths.js';
import { openDb } from '../db/index.js';
import { maskSender, maskSubject } from '../utils/prompt-log.js';

interface Args {
  user: string;
  apply: boolean;
  all: boolean;
  showContent: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { user: '', apply: false, all: false, showContent: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--user') a.user = argv[++i] ?? '';
    else if (v === '--apply') a.apply = true;
    else if (v === '--all') a.all = true;
    else if (v === '--show-content') a.showContent = true;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.user) {
    console.error(
      'usage: npm run clear:person-marks --workspace=server -- --user <email|userId> [--all] [--apply]',
    );
    process.exit(2);
  }

  ensureDataDirs();
  const db = openDb();
  try {
    const user =
      (await db.selectFrom('users').select(['id', 'email']).where('id', '=', args.user).executeTakeFirst()) ??
      (await db.selectFrom('users').select(['id', 'email']).where('email', 'ilike', args.user).executeTakeFirst());
    if (!user) {
      console.error(`no user matches "${args.user}"`);
      process.exit(1);
    }

    const marks = await db
      .selectFrom('email_extraction_marks')
      .select('gmail_thread_id')
      .where('user_id', '=', user.id)
      .where('kind', '=', 'person')
      .execute();
    let targets = marks.map((m) => m.gmail_thread_id);

    if (!args.all) {
      const staged = await db
        .selectFrom('proposals')
        .select('provenance')
        .where('proposed_by_user_id', '=', user.id)
        .where('tool_name', '=', 'add_person')
        .where('status', '!=', 'rejected')
        .where('provenance', 'like', 'gmail:%')
        .execute();
      const wanted = new Set(staged.map((p) => (p.provenance ?? '').slice('gmail:'.length)));
      targets = targets.filter((id) => wanted.has(id));
    }

    const threads = targets.length
      ? await db
          .selectFrom('email_threads')
          .select(['gmail_thread_id', 'subject', 'from_email'])
          .where('user_id', '=', user.id)
          .where('gmail_thread_id', 'in', targets)
          .execute()
      : [];
    const byId = new Map(threads.map((t) => [t.gmail_thread_id, t]));

    console.log('');
    console.log(`Clear person extraction marks — ${user.email ?? '?'} [${user.id}]`);
    console.log(`  scope: ${args.all ? 'ALL person marks' : 'threads that staged a non-rejected add_person proposal'}`);
    console.log(`  person marks on file: ${marks.length}   selected: ${targets.length}`);
    for (const id of targets) {
      const t = byId.get(id);
      console.log(
        `    - ${
          t
            ? `${maskSender(t.from_email, args.showContent)}  "${maskSubject(t.subject, args.showContent)}"`
            : `${id}  (thread no longer mirrored)`
        }`,
      );
    }
    console.log('');

    if (!args.apply) {
      console.log('Dry run — nothing deleted. Re-run with --apply to clear these marks.');
      return;
    }
    if (targets.length === 0) {
      console.log('Nothing to clear.');
      return;
    }

    const res = await db
      .deleteFrom('email_extraction_marks')
      .where('user_id', '=', user.id)
      .where('kind', '=', 'person')
      .where('gmail_thread_id', 'in', targets)
      .executeTakeFirst();
    console.log(`Cleared ${String(res.numDeletedRows)} mark(s). The next mail sync re-reads these threads.`);
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
