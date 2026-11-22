/**
 * ADR 0280 — a group's bot turns run one at a time across processes.
 *
 * Two web copies are two processes, each with its own pool. They are modelled
 * here as two independent pools onto the same test database: the ticket table
 * is the only thing they share, which is exactly the production situation. The
 * old in-memory tail cannot be shown failing this way in one process (both
 * pools would share the one module-level map), which is why it was replaced.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/db/pg-types.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb, urlForDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';
import { withGroupTurn } from '@/services/bot/turn-order.js';

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe('withGroupTurn across processes', () => {
  let db: Kysely<DB>;
  let other: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
    const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
    const pool = new Pool({ connectionString: urlForDb(name), max: 2 });
    pool.on('error', () => {});
    other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  });

  afterEach(async () => {
    await other.destroy();
    await closeTestDb(db);
  });

  it('a turn arriving on another process waits for the one already running', async () => {
    const order: string[] = [];
    const first = gate();
    const a = withGroupTurn(db, 'g1', 'm1', async () => {
      order.push('a:start');
      await first.wait;
      order.push('a:end');
    });
    await waitFor(() => order.includes('a:start'));
    const b = withGroupTurn(other, 'g1', 'm2', async () => {
      order.push('b:start');
    });
    // B has its ticket and is polling; it must not start while A runs.
    await waitFor(async () => {
      const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM bot_turn_tickets`.execute(db);
      return r.rows[0]!.n === 2;
    });
    expect(order).toEqual(['a:start']);
    first.open();
    await Promise.all([a, b]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    const left = await sql<{ n: number }>`SELECT count(*)::int AS n FROM bot_turn_tickets`.execute(db);
    expect(left.rows[0]!.n).toBe(0);
  });

  it('another group on another process is not held up', async () => {
    const first = gate();
    const a = withGroupTurn(db, 'g1', 'm1', () => first.wait);
    let ran = false;
    await withGroupTurn(other, 'g2', 'm2', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    first.open();
    await a;
  });

  it('a ticket left by a dead process does not wedge the group', async () => {
    await sql`INSERT INTO bot_turn_tickets (group_id, message_id, heartbeat_at)
      VALUES ('g1', 'dead', now() - interval '5 minutes')`.execute(db);
    let ran = false;
    await withGroupTurn(other, 'g1', 'm2', async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('turns called in order in one process run in that order', async () => {
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        withGroupTurn(db, 'g1', `m${n}`, async () => {
          order.push(n);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
