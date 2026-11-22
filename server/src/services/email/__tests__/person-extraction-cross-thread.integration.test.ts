/**
 * ADR 0244 addendum — two emails naming the same new person, read at the same
 * moment, create them once.
 *
 * Person extraction asked "is this person already known?" and then wrote, with
 * no lock. On a user's first pass (ADR 0076's bootstrap, which writes people
 * directly) two passes reading the same message at once each found nobody and
 * each created the person: two People rows for one person, which nothing
 * merges afterwards. (Pending cards have a consolidation sweep; rows do not.)
 * The thread lock never helped: the two emails are two threads.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { runPersonExtraction, type PersonExtractor } from '@/services/email/person-extraction.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb, urlForDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

let db: Kysely<DB>;
let other: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  // A second connection: the test pool has one, which would serialize the two
  // passes and hide the race.
  const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
  const pool = new Pool({ connectionString: urlForDb(name), max: 2 });
  pool.on('error', () => {});
  other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  userId = await createUser(db, 'person-race');
  await ensurePersonalGroup(db, userId);
});
afterEach(async () => {
  await other.destroy();
  await closeTestDb(db);
});

/** Whether a session on this database is waiting for an advisory lock. */
async function waitingOnLock(conn: Kysely<DB>): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND NOT granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`.execute(conn);
  return r.rows[0]!.n > 0;
}

async function seedThread(gid: string, minutesAgo: number): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      gmail_thread_id: gid,
      subject: 'Dinner Saturday?',
      snippet: 'Hi! It was lovely meeting you at the school picnic.',
      from_name: 'Priya Raman',
      from_email: 'priya.raman@example.com',
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      thread_id: threadId,
      gmail_message_id: `m_${gid}`,
      gmail_thread_id: gid,
      from_name: 'Priya Raman',
      from_email: 'priya.raman@example.com',
      subject: 'Dinner Saturday?',
      snippet: 'Hi! It was lovely meeting you at the school picnic.',
      to_emails: JSON.stringify(['me@example.com']),
      cc_emails: JSON.stringify([]),
      body_text: 'Hi! It was lovely meeting you at the school picnic. Dinner Saturday? - Priya',
      internal_date: at,
      created_at: at,
    })
    .execute();
}

describe('two passes, one person (ADR 0244 addendum)', () => {
  it('a friend named in two emails, read by two passes at once, is created once', async () => {
    // Two emails from Priya: each pass takes one (they hold different thread
    // locks), and both run on the first-pass bootstrap that writes the
    // person directly.
    await seedThread('t_older', 10);
    await seedThread('t_newer', 1);
    const extractor: PersonExtractor = {
      async extract() {
        return [{ name: 'Priya Raman', relationship: 'friend', email: 'priya.raman@example.com', confidence: 0.95 }];
      },
    };
    const mark = (gid: string) =>
      other
        .insertInto('email_extraction_marks')
        .values({ user_id: userId, gmail_thread_id: gid, kind: 'person', created_at: new Date().toISOString() })
        .execute();
    // The first pass takes the older email: hide the newer one while it picks.
    await mark('t_newer');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let wrote = false;
    const first = db.transaction().execute(async (trx) => {
      await runPersonExtraction(trx, userId, { extractor, limit: 1 });
      wrote = true;
      await held;
    });
    await waitFor(() => wrote);
    await other.deleteFrom('email_extraction_marks').where('gmail_thread_id', '=', 't_newer').execute();
    let secondDone = false;
    const second = runPersonExtraction(other, userId, { extractor, limit: 1 }).finally(
      () => (secondDone = true),
    );
    await waitFor(async () => secondDone || (await waitingOnLock(other)));
    release();
    await Promise.all([first, second]);

    const people = await db
      .selectFrom('people')
      .select('id')
      .where('owner_user_id', '=', userId)
      .where('display_name', '=', 'Priya Raman')
      .execute();
    expect(people).toHaveLength(1);
  });
});
