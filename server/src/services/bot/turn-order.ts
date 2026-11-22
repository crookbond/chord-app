/**
 * ADR 0155 / 0280 — one bot turn per group at a time, across every process.
 *
 * Each turn takes a ticket (a per-group sequence number in Postgres), waits
 * until its ticket is the lowest live one for the group, runs, and gives the
 * ticket back. The owner refreshes `heartbeat_at` while waiting or running; a
 * ticket nobody has refreshed for STALE_MS belongs to a dead process and is
 * removed, so a crash cannot wedge a group.
 *
 * The wait happens before the turn is queued (ADR 0178), as the old in-memory
 * tail's did, so a waiting turn holds no queue slot and no pooled connection
 * between polls.
 */
import { sql, type Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';

const HEARTBEAT_MS = 15_000;
const STALE_MS = 60_000;
const POLL_MIN_MS = 25;
const POLL_MAX_MS = 500;

/**
 * Ticket inserts for a group are chained within this process, so the sequence
 * follows the order `withGroupTurn` was called in — the arrival order — and
 * not whichever of two pooled connections happened to commit first.
 */
const insertTails = new Map<string, Promise<unknown>>();

function takeTicket(db: Kysely<DB>, groupId: string, messageId: string | null): Promise<string> {
  const prev = insertTails.get(groupId) ?? Promise.resolve();
  const mine = prev
    .catch(() => {})
    .then(async () => {
      const r = await sql<{ seq: string }>`
        INSERT INTO bot_turn_tickets (group_id, message_id)
        VALUES (${groupId}, ${messageId})
        RETURNING seq::text AS seq
      `.execute(db);
      return r.rows[0]!.seq;
    });
  insertTails.set(groupId, mine);
  void mine
    .catch(() => {})
    .finally(() => {
      if (insertTails.get(groupId) === mine) insertTails.delete(groupId);
    });
  return mine;
}

async function isHead(db: Kysely<DB>, groupId: string, seq: string): Promise<boolean> {
  await sql`
    DELETE FROM bot_turn_tickets
    WHERE group_id = ${groupId}
      AND heartbeat_at < now() - make_interval(secs => ${STALE_MS / 1000})
  `.execute(db);
  const r = await sql<{ seq: string }>`
    SELECT seq::text AS seq FROM bot_turn_tickets
    WHERE group_id = ${groupId}
    ORDER BY seq
    LIMIT 1
  `.execute(db);
  // Our own row missing means a peer judged us dead; run rather than wait forever.
  return r.rows.length === 0 || r.rows[0]!.seq === seq || BigInt(r.rows[0]!.seq) > BigInt(seq);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withGroupTurn<T>(
  db: Kysely<DB>,
  groupId: string,
  messageId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const seq = await takeTicket(db, groupId, messageId);
  const beat = setInterval(() => {
    void sql`UPDATE bot_turn_tickets SET heartbeat_at = now() WHERE seq = ${seq}::bigint`
      .execute(db)
      .catch((err) => logger.warn('bot turn ticket heartbeat failed', { err: (err as Error).message }));
  }, HEARTBEAT_MS);
  beat.unref?.();
  try {
    let wait = POLL_MIN_MS;
    while (!(await isHead(db, groupId, seq))) {
      await sleep(wait);
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5));
    }
    return await fn();
  } finally {
    clearInterval(beat);
    await sql`DELETE FROM bot_turn_tickets WHERE seq = ${seq}::bigint`
      .execute(db)
      .catch((err) => logger.warn('bot turn ticket release failed', { err: (err as Error).message }));
  }
}

export const __testing = { STALE_MS };
