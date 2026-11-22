/**
 * Shared test fixtures. `openTestDb()` hands back a migrated, empty
 * Postgres database; `closeTestDb(db)` returns it.
 *
 * The underlying database is cloned from `chord_test_template` via
 * `CREATE DATABASE ... TEMPLATE`. The template has all migrations applied
 * once at global setup, so cloning copies the catalog directory rather than
 * re-running ~40 CREATE TABLE and ~30 CREATE INDEX statements.
 *
 * That clone is NOT cheap, though. On a windows-native cluster it measures
 * 2.4-7.4s (median ~3.3s) for the current 11 MB template — `CREATE DATABASE`
 * fsyncs every relation file, and `STRATEGY = FILE_COPY` is slower still.
 * At one clone per test the suite spent over an hour inside CREATE DATABASE
 * alone and routinely blew the hook timeout, which surfaced as a dozen
 * "Hook timed out in 30000ms" failures with zero failed assertions.
 *
 * So each worker provisions ONE clone and recycles it: every `openTestDb()`
 * returns that same database after emptying it in place (see `resetDb` — a
 * probe for non-empty tables, then DELETE, ~23ms). Isolation is equivalent —
 * no test file runs concurrently with another in the same worker, and nothing
 * in the suite uses `.concurrent`.
 *
 * Two escape hatches:
 *   - a *nested* `openTestDb()` (one handle already checked out) still gets
 *     its own real clone, so a test needing two live databases keeps working;
 *   - `CHORD_TEST_DB_MODE=clone` restores clone-per-test wholesale.
 *
 * The recycled handle lives on `globalThis`, not in module scope, because
 * vitest's default `isolate: true` resets the module registry between test
 * files — a module-level cache would silently degrade to one clone per file.
 *
 * The vitest globalSetup (a) rebuilds the template on every run so it tracks
 * the current migration set, and (b) sweeps any `chord_test_t_*` leftovers
 * from previous runs (process crash, ctrl-c, or a recycled worker database,
 * which is deliberately never dropped mid-run).
 *
 * Production code does NOT import from here. seed.ts has its own
 * `addMember` (upsert + tier) and stays separate.
 */
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import {
  attachContentCrypto,
  contentCrypto,
  detachContentCrypto,
  hasContentCrypto,
  setContentEncryption,
} from '../db/crypto/index.js';
import type { List, Message } from '@chord/kernel';
import { mentionsBot as kernelMentionsBot } from '@chord/kernel';

import '../db/pg-types.js';
import type { DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { resolveOrCreateListByName } from '../services/lists.service.js';

const { Pool } = pg;

export const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://chord@127.0.0.1:5432/chord_test';

/**
 * The template is named after the test database it was built from, so two
 * checkouts pointed at different `TEST_DATABASE_URL`s never contend for it.
 *
 * It used to be the constant `chord_test_template`, which meant a second
 * concurrent run lost `CREATE DATABASE ... TEMPLATE` and reported hundreds of
 * failures that looked like real ones — every stack ending in `closeTestDb`.
 * Deriving the name removes the contention rather than asking people to take
 * turns.
 */
export const TEMPLATE_DB_NAME = `${new URL(TEST_URL).pathname.slice(1) || 'chord_test'}_template`;

const DBNAME_KEY = Symbol.for('chord.testDbName');
interface DbNameTagged {
  [DBNAME_KEY]?: string;
}

export function adminUrl(testUrl: string = TEST_URL): string {
  const u = new URL(testUrl);
  u.pathname = '/postgres';
  return u.toString();
}

export function urlForDb(dbName: string, base: string = TEST_URL): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function randDbName(): string {
  // 10 chars of base36 entropy + a millisecond suffix. `chord_test_t_`
  // prefix keeps the globalSetup sweeper safe (it only drops that
  // prefix). PG identifier limit is 63 bytes; this stays well under.
  return `chord_test_t_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
}

/**
 * Best-effort drop of a database. CREATE DATABASE … TEMPLATE will fail
 * if any session still holds a connection to the source, and likewise
 * DROP DATABASE will fail if anyone is connected to the target. PG 13+
 * supports WITH (FORCE) to evict; we use it but fall back gracefully.
 */
export async function dropDatabase(admin: pg.Client, dbName: string): Promise<void> {
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    // Older PG without WITH(FORCE), or transient backend. Try the
    // gentle form; sweeper will pick up anything we leave behind.
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    } catch {
      // Give up — globalSetup sweep on next run handles it.
    }
  }
}

/**
 * One long-lived admin client per worker process. Opening + closing
 * a fresh pg.Client for every test (2× per test: CREATE then DROP)
 * was crashing vitest workers with ERR_IPC_CHANNEL_CLOSED under the
 * cumulative connection churn × CREATE DATABASE contention against
 * `pg_database`. Reusing one socket per worker cuts that to a single
 * connect at first use; the worker exits naturally when the suite
 * is done.
 */
let workerAdmin: pg.Client | null = null;
let workerAdminPending: Promise<pg.Client> | null = null;

async function getAdmin(): Promise<pg.Client> {
  if (workerAdmin) return workerAdmin;
  if (workerAdminPending) return workerAdminPending;
  workerAdminPending = (async () => {
    const client = new pg.Client({ connectionString: adminUrl() });
    // If the connection drops for any reason, drop the cache so the
    // next call reconnects rather than reusing a dead socket.
    client.on('error', () => {
      if (workerAdmin === client) workerAdmin = null;
    });
    await client.connect();
    workerAdmin = client;
    workerAdminPending = null;
    return client;
  })();
  return workerAdminPending;
}

/** Provision a brand-new database of its own. The expensive path. */
async function cloneTestDb(): Promise<Kysely<DB>> {
  const dbName = randDbName();

  // CREATE DATABASE forbids running inside a transaction context, so
  // we issue it through the worker's admin client (connected to the
  // cluster-level `postgres` database). The template must have zero
  // active connections at the moment of CREATE; the test pool we
  // open below points at the new clone, not the template.
  const admin = await getAdmin();
  await admin.query(
    `CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB_NAME}"`,
  );

  // max:1 — a single test executes queries serially, and per-test
  // pools across parallel workers can otherwise exhaust PG's default
  // `max_connections` (100) and crash vitest workers with
  // ERR_IPC_CHANNEL_CLOSED. Production uses max:10 from openDb().
  // `synchronous_commit=off` lets a COMMIT return before its WAL record is
  // flushed. Measured 2x on the suite's write path and ~2.5x on the reset.
  // It is set per-connection, so it never touches the dev cluster's own
  // durability; the only thing at risk is test data we throw away anyway.
  const pool = new Pool({
    connectionString: urlForDb(dbName),
    max: 1,
    options: '-c synchronous_commit=off',
  });
  // A fire-and-forget background query (e.g. createEvent's two-way push) can
  // still be in flight when closeTestDb runs `DROP DATABASE … WITH (FORCE)`,
  // which terminates the connection. node-pg re-emits that as a pool 'error';
  // without a listener it becomes an uncaught exception that fails the run. The
  // query promise itself is already caught at the call site — swallow the pool
  // socket error too. (node-pg's own docs recommend always handling pool errors.)
  pool.on('error', () => {});
  // The same wrapper production gets from openDb(), so every test exercises the
  // decrypt plugin: with encryption off it costs one string check per value.
  const keyPool = new Pool({ connectionString: urlForDb(dbName), max: 2, options: '-c synchronous_commit=off' });
  keyPool.on('error', () => {});
  const db = attachContentCrypto(new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), {
    keyDb: new Kysely<DB>({ dialect: new PostgresDialect({ pool: keyPool }) }),
  });
  (db as unknown as DbNameTagged)[DBNAME_KEY] = dbName;
  return db;
}

const RECYCLE = process.env.CHORD_TEST_DB_MODE !== 'clone';

/**
 * How to empty the recycled database between tests, computed once per worker.
 *
 * NOT a blanket TRUNCATE. On this cluster TRUNCATE costs ~1000ms no matter how
 * few tables it names — it recreates a relation file per table and index and
 * fsyncs each one, so truncating the 4 tables a test dirtied measured *slower*
 * than truncating all 56. DELETE is ordinary MVCC: no file churn, and it only
 * touches rows that exist. Probing for non-empty tables first (one round trip,
 * ~5ms) keeps the DELETE list to what the test actually wrote.
 *
 *   TRUNCATE all              mean 1015ms
 *   EXISTS probe + DELETE     mean   23ms
 */
interface ResetPlan {
  /** One round trip naming every table that currently holds a row. */
  probe: string;
  /** Child-before-parent order, so a DELETE never trips an FK. */
  order: string[];
  /** Every table, quoted — for the periodic compacting TRUNCATE. */
  truncateAll: string;
}

interface Recycled {
  db: Kysely<DB>;
  /** True while a test holds this handle; a second opener gets a real clone. */
  busy: boolean;
  plan: ResetPlan | null;
  /** Resets served, to schedule the compaction below. */
  resets: number;
}

/**
 * DELETE leaves dead tuples behind, and the EXISTS probe seq-scans to find its
 * first live row — on a table that is mostly dead tuples that scan degrades.
 * Autovacuum normally keeps up at these row counts, but a periodic TRUNCATE
 * bounds the worst case for ~1s amortised over 250 tests (~4ms each).
 */
const COMPACT_EVERY = 250;

const RECYCLED_KEY = Symbol.for('chord.testRecycledDb');
const RECYCLED_PENDING_KEY = Symbol.for('chord.testRecycledDbPending');
interface RecycledHolder {
  [RECYCLED_KEY]?: Recycled;
  [RECYCLED_PENDING_KEY]?: Promise<Recycled>;
}

async function getRecycled(): Promise<Recycled> {
  const holder = globalThis as RecycledHolder;
  const ready = holder[RECYCLED_KEY];
  if (ready) return ready;
  const pending = holder[RECYCLED_PENDING_KEY];
  if (pending) return pending;
  const started = (async () => {
    const entry: Recycled = { db: await cloneTestDb(), busy: false, plan: null, resets: 0 };
    holder[RECYCLED_KEY] = entry;
    holder[RECYCLED_PENDING_KEY] = undefined;
    return entry;
  })();
  holder[RECYCLED_PENDING_KEY] = started;
  return started;
}

const quoteIdent = (t: string): string => `"${t.replace(/"/g, '""')}"`;

/**
 * Topologically sort so every table comes before the tables it references.
 * Edges are child -> parent ("child must be deleted first"), so a table with
 * no remaining referrers is safe to emit. Tables caught in an FK cycle are
 * appended in arbitrary order — ON DELETE CASCADE covers those in practice,
 * and `resetDb` falls back to TRUNCATE if a DELETE batch ever fails anyway.
 */
function deleteOrder(tables: string[], edges: Array<{ child: string; parent: string }>): string[] {
  const known = new Set(tables);
  const pending = new Set(tables);
  const out: string[] = [];
  while (pending.size) {
    const safe = [...pending].filter(
      (t) =>
        !edges.some(
          (e) => e.parent === t && e.child !== t && known.has(e.child) && pending.has(e.child),
        ),
    );
    if (!safe.length) break; // cycle
    for (const t of safe) {
      out.push(t);
      pending.delete(t);
    }
  }
  return [...out, ...pending];
}

async function buildResetPlan(db: Kysely<DB>): Promise<ResetPlan> {
  const tables = (
    await sql<{ tablename: string }>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_migrations'
    `.execute(db)
  ).rows.map((r) => r.tablename);

  const edges = (
    await sql<{ child: string; parent: string }>`
      SELECT src.relname AS child, tgt.relname AS parent
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      WHERE con.contype = 'f' AND src.relname <> tgt.relname
    `.execute(db)
  ).rows;

  return {
    probe: tables
      .map((t) => `SELECT '${t}' AS t WHERE EXISTS (SELECT 1 FROM ${quoteIdent(t)})`)
      .join(' UNION ALL '),
    order: deleteOrder(tables, edges),
    truncateAll: tables.length
      ? `TRUNCATE TABLE ${tables.map(quoteIdent).join(', ')} CASCADE`
      : '',
  };
}

/** Return the recycled database to a pristine, migrated-but-empty state. */
async function resetDb(entry: Recycled): Promise<void> {
  // Keys are deleted with the rest of the data, so an unwrapped key cached from
  // the previous test must not outlive its row. Encryption is off by default.
  if (hasContentCrypto()) contentCrypto().store.clearCache();
  setContentEncryption(false);
  entry.plan ??= await buildResetPlan(entry.db);
  const plan = entry.plan;
  if (!plan.truncateAll) return;

  if (++entry.resets % COMPACT_EVERY === 0) {
    await sql.raw(plan.truncateAll).execute(entry.db);
    return;
  }

  const dirty = new Set(
    (await sql<{ t: string }>`${sql.raw(plan.probe)}`.execute(entry.db)).rows.map((r) => r.t),
  );
  if (!dirty.size) return;

  const stmts = plan.order
    .filter((t) => dirty.has(t))
    .map((t) => `DELETE FROM ${quoteIdent(t)};`)
    .join(' ');
  try {
    await sql.raw(stmts).execute(entry.db);
  } catch {
    // An FK cycle or an unexpected constraint beat the computed order.
    // TRUNCATE is slower but cannot be blocked by referential integrity.
    await sql.raw(plan.truncateAll).execute(entry.db);
  }
}

export async function openTestDb(): Promise<Kysely<DB>> {
  if (!RECYCLE) return cloneTestDb();
  const entry = await getRecycled();
  // Already checked out — the caller wants a second, independent database.
  if (entry.busy) return cloneTestDb();
  // Reset on the way OUT, not on the way in. Integration tests fire-and-forget
  // async work (bot reactions, calendar push) that can still land after their
  // own `afterEach`; wiping immediately before the next test hands out the
  // handle is the last moment those stragglers can be cleared.
  await resetDb(entry);
  entry.busy = true;
  return entry.db;
}

export async function closeTestDb(db: Kysely<DB>): Promise<void> {
  const holder = globalThis as RecycledHolder;
  const entry = holder[RECYCLED_KEY];
  if (entry && entry.db === db) {
    // Recycled handle: return it to the worker. Destroying the driver or
    // dropping the database here would defeat the whole point — which also
    // means a test can NOT use this call to simulate Postgres going away.
    // Point an app at an unreachable pool instead; health.integration does.
    entry.busy = false;
    return;
  }

  const tagged = db as unknown as DbNameTagged;
  const dbName = tagged[DBNAME_KEY];
  if (!dbName) {
    // Already cleaned up — closeTestDb called twice (e.g. in both an
    // afterEach and an inline try/finally). Silently no-op rather than
    // throw an unhandled rejection that crashes the vitest worker.
    return;
  }
  tagged[DBNAME_KEY] = undefined;
  detachContentCrypto(db);
  try {
    await db.destroy();
  } catch {
    // Pool already ended — ignore.
  }
  try {
    const admin = await getAdmin();
    await dropDatabase(admin, dbName);
  } catch {
    // DB drop best-effort. globalSetup sweeps any chord_test_t_*
    // leftovers on the next run, so a single failure here doesn't
    // accumulate state.
  }
}

/**
 * A second handle on the same test database with `max` connections. The
 * handle from openTestDb has one, so requests in a test take turns and two
 * writes can never overlap; a test about writes at the same moment builds its
 * app on this instead. Destroy it before closeTestDb.
 */
export function openParallelHandle(db: Kysely<DB>, max = 8): Kysely<DB> {
  const dbName = (db as unknown as DbNameTagged)[DBNAME_KEY];
  if (!dbName) throw new Error('openParallelHandle: not a handle from openTestDb');
  const pool = new Pool({ connectionString: urlForDb(dbName), max, options: '-c synchronous_commit=off' });
  pool.on('error', () => {});
  const keyPool = new Pool({ connectionString: urlForDb(dbName), max: 2, options: '-c synchronous_commit=off' });
  keyPool.on('error', () => {});
  const keyDb = new Kysely<DB>({ dialect: new PostgresDialect({ pool: keyPool }) });
  const handle = attachContentCrypto(new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }), { keyDb });
  parallelKeyDbs.set(handle, keyDb);
  return handle;
}

const parallelKeyDbs = new WeakMap<Kysely<DB>, Kysely<DB>>();

export async function closeParallelHandle(handle: Kysely<DB>): Promise<void> {
  detachContentCrypto(handle);
  await handle.destroy().catch(() => {});
  await parallelKeyDbs.get(handle)?.destroy().catch(() => {});
}

export async function createUser(
  db: Kysely<DB>,
  username?: string,
  displayName?: string,
): Promise<string> {
  const id = newId('u');
  const uname = username ?? id;
  const display = displayName ?? uname;
  await db
    .insertInto('users')
    .values({
      id,
      username: uname,
      display_name: display,
      // Mirror real signup: first_name is the leading word of the full name.
      first_name: display.trim().split(/\s+/)[0] || null,
      created_at: new Date().toISOString(),
      shadow: 0,
    })
    .execute();
  return id;
}

export async function addMember(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  role: 'owner' | 'member' = 'member',
  tier: 'verified' | 'trusted' | 'guest' = 'trusted',
): Promise<void> {
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role,
      tier,
      joined_at: new Date().toISOString(),
    })
    .execute();
}

export type MessageSource = 'chat' | 'import' | 'slack' | 'discord' | 'telegram';

export interface InsertMessageOpts {
  groupId: string;
  senderId: string;
  body: string;
  /** Override the regex-based @-mention detection. */
  mentionsBot?: boolean;
  /** External source for relay-style triggers. Default null = from Chord. */
  source?: MessageSource | null;
  externalMessageId?: string | null;
  /** 1 = visible in Chord (default). 0 = bot-only mention from a bridge. */
  chordVisible?: 0 | 1;
  /** Attach an uploaded file to the message (sets messages.attachment_id). */
  attachmentId?: string;
}

export async function insertMessage(
  db: Kysely<DB>,
  opts: InsertMessageOpts,
): Promise<Message> {
  const id = newId('m');
  const now = new Date().toISOString();
  const mentionsBot = opts.mentionsBot ?? kernelMentionsBot(opts.body);
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: opts.groupId,
      sender_id: opts.senderId,
      kind: 'text',
      body: opts.body,
      attachment_id: opts.attachmentId ?? null,
      reply_to_id: null,
      mentions_bot: mentionsBot ? 1 : 0,
      created_at: now,
      source: opts.source ?? null,
      external_message_id: opts.externalMessageId ?? null,
      chord_visible: opts.chordVisible ?? 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
  return {
    id,
    groupId: opts.groupId,
    senderId: opts.senderId,
    kind: 'text',
    body: opts.body,
    mentionsBot,
    createdAt: now,
    attachmentId: opts.attachmentId,
  };
}

/**
 * Wrap tool calls in the bot's text-fence protocol with a trailing
 * acknowledgement. Pass `tail` to override the default; relay tests
 * assert on a specific reply phrasing.
 */
export function fence(...calls: object[]): string {
  return fenceWith('Done.', ...calls);
}

export function fenceWith(tail: string, ...calls: object[]): string {
  return (
    calls.map((c) => '```chord-tool\n' + JSON.stringify(c) + '\n```').join('\n\n') +
    `\n\n${tail}`
  );
}

/**
 * Setup shorthand for `resolveOrCreateListByName`. Fixtures create lists in
 * fresh groups where the name cannot be ambiguous, so unwrapping here keeps
 * the resolution union out of every arrange block.
 */
export async function ensureList(
  db: Kysely<DB>,
  groupId: string,
  name: string,
  createdBy: string | null,
): Promise<List> {
  const r = await resolveOrCreateListByName(db, groupId, name, createdBy);
  if (r.status !== 'resolved') {
    throw new Error(`ensureList: "${name}" was ambiguous in ${groupId}`);
  }
  return r.match;
}
