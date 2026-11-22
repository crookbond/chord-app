/**
 * Work that follows a write and must not run on the write's transaction
 * (ADR 0313). Started un-awaited on a Kysely transaction, it outlives the
 * transaction: its first queries run inside it, the rest hit a committed
 * handle and throw. A calendar push then claimed its event, sent it, and
 * could not record the Google id.
 *
 * A transaction opened with `transactionThen` (or bound with
 * `bindAfterCommit`) collects such work and starts it on the outer handle
 * once committed; a rollback discards it.
 */
import type { Kysely } from 'kysely';
import { logger } from '../config/logging.js';
import { runInBackground } from '../utils/background.js';
import type { DB } from './schema.js';

export type AfterCommitJob = (db: Kysely<DB>) => Promise<void>;
export type AfterCommitSink = (job: AfterCommitJob) => void;

const sinks = new WeakMap<object, AfterCommitSink>();

/** Send work deferred on `trx` to `sink`, which the caller runs after commit. */
export function bindAfterCommit(trx: Kysely<DB>, sink: AfterCommitSink): void {
  sinks.set(trx, sink);
}

/**
 * `db.transaction().execute(fn)`, then start whatever `fn` deferred with
 * `runAfterCommit`, on `db`. Already in a transaction: joins it, and its
 * owner starts the work.
 */
export async function transactionThen<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn(db);
  const jobs: AfterCommitJob[] = [];
  const result = await db.transaction().execute(async (trx) => {
    bindAfterCommit(trx, (job) => jobs.push(job));
    return fn(trx);
  });
  for (const job of jobs) runInBackground(job(db), 'after-commit work');
  return result;
}

/**
 * Start `job` without waiting for it, once the write it follows is
 * committed. Outside a transaction that is now. Inside one, it goes to
 * `explicit` if given, else to the sink bound to the transaction. With
 * neither it is dropped and logged (returns false): callers whose work is
 * picked up later anyway (a dirty event waits for the calendar sweep) say so.
 */
export function runAfterCommit(
  db: Kysely<DB>,
  job: AfterCommitJob,
  label: string,
  explicit?: AfterCommitSink,
): boolean {
  if (!db.isTransaction) {
    runInBackground(job(db), label);
    return true;
  }
  const sink = explicit ?? sinks.get(db);
  if (sink) {
    sink(job);
    return true;
  }
  logger.warn(`${label} not started: inside a transaction with no after-commit`);
  return false;
}
