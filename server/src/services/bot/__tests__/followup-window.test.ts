/**
 * Post-invocation follow-up window (ADR 0051): the store's open/within/consume
 * lifecycle, and decideReaction's use of it. Assumes the default config
 * (BOT_FOLLOWUP_TURNS=3) — the test asserts relative to that N rather than
 * hardcoding 3 where it can.
 */
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '@/db/pg-types.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, openTestDb, urlForDb } from '@/__test-helpers__/db.js';
import { decideReaction } from '@/services/bot/bot.service.js';
import {
  consumeFollowupTurn,
  isWithinFollowupWindow,
  MAX_FOLLOWUP_TURNS,
  openFollowupWindow,
} from '@/services/bot/followup-window.js';

const G = 'g-1';
// Configured turns, clamped to the same cap the store enforces.
const N = Math.min(MAX_FOLLOWUP_TURNS, Math.max(0, env.BOT_FOLLOWUP_TURNS));

let db: Kysely<DB>;
beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('followup-window store', () => {
  it('is closed until opened', async () => {
    expect(await isWithinFollowupWindow(db, G)).toBe(false);
  });

  it('opens a window and stays open until the turns are spent', async () => {
    await openFollowupWindow(db, G);
    for (let i = 0; i < N; i++) {
      expect(await isWithinFollowupWindow(db, G), `hint: open before turn ${i}`).toBe(true);
      await consumeFollowupTurn(db, G);
    }
    expect(await isWithinFollowupWindow(db, G), 'hint: closed after N consumes').toBe(false);
  });

  it('is scoped per group — a different group has no window', async () => {
    await openFollowupWindow(db, G);
    expect(await isWithinFollowupWindow(db, 'other-group')).toBe(false);
    expect(await isWithinFollowupWindow(db, G)).toBe(true);
  });

  it('never opens for more than the hard cap of turns', async () => {
    await openFollowupWindow(db, G);
    for (let i = 0; i < MAX_FOLLOWUP_TURNS; i++) await consumeFollowupTurn(db, G);
    expect(await isWithinFollowupWindow(db, G), 'hint: capped at MAX_FOLLOWUP_TURNS').toBe(false);
  });

  it('re-opening refreshes the remaining turns', async () => {
    await openFollowupWindow(db, G);
    await consumeFollowupTurn(db, G); // N-1 left
    await openFollowupWindow(db, G); // back to N
    for (let i = 0; i < N; i++) await consumeFollowupTurn(db, G);
    expect(await isWithinFollowupWindow(db, G)).toBe(false);
  });

  it('consuming a non-existent window is a no-op', async () => {
    await expect(consumeFollowupTurn(db, G)).resolves.toBeUndefined();
    expect(await isWithinFollowupWindow(db, G)).toBe(false);
  });

  it('an expired window is closed', async () => {
    await openFollowupWindow(db, G);
    await sql`UPDATE bot_pending_state SET expires_at = now() - interval '1 second'`.execute(db);
    expect(await isWithinFollowupWindow(db, G)).toBe(false);
  });

  // ADR 0280 — the mention can land on one web copy and the next message on
  // another; a second pool onto the same database stands in for the other copy.
  it('a window opened by one process is seen and spent by another', async () => {
    if (N < 1) return;
    const name = (await sql<{ n: string }>`SELECT current_database() AS n`.execute(db)).rows[0]!.n;
    const pool = new Pool({ connectionString: urlForDb(name), max: 1 });
    pool.on('error', () => {});
    const other = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
    try {
      await openFollowupWindow(db, G);
      expect(await isWithinFollowupWindow(other, G)).toBe(true);
      for (let i = 0; i < N; i++) await consumeFollowupTurn(other, G);
      expect(await isWithinFollowupWindow(db, G)).toBe(false);
    } finally {
      await other.destroy();
    }
  });
});

describe('decideReaction — follow-up window', () => {
  const base = {
    kind: 'text' as const,
    senderId: 'u-1',
    groupKind: 'group' as const,
  };

  it('a mention reacts and recommends opening the window', () => {
    const d = decideReaction({ ...base, body: '@chord hi', inFollowupWindow: false });
    expect(d.react).toBe(true);
    expect(d.followup).toBe('open');
  });

  it('a non-mention inside the window reacts and consumes a turn', () => {
    const d = decideReaction({ ...base, body: 'Fairfax County', inFollowupWindow: true });
    expect(d.react).toBe(true);
    expect(d.reason).toBe('follow-up window');
    expect(d.followup).toBe('consume');
  });

  it('a non-mention outside the window stays silent', () => {
    const d = decideReaction({ ...base, body: 'just chatting', inFollowupWindow: false });
    expect(d.react).toBe(false);
    expect(d.followup).toBeUndefined();
  });

  it('a mention takes precedence over the window (opens, not consumes)', () => {
    const d = decideReaction({ ...base, body: '@chord again', inFollowupWindow: true });
    expect(d.followup).toBe('open');
  });

  it('the window overrides passive listening (replies instead of silently extracting)', () => {
    const d = decideReaction({
      ...base,
      body: 'more context',
      listeningMode: 'passive',
      inFollowupWindow: true,
    });
    expect(d.react).toBe(true);
    expect(d.passiveExtract).toBe(false);
  });

  it('personal chats never carry a window action', () => {
    const d = decideReaction({ ...base, groupKind: 'personal', body: 'hi', inFollowupWindow: true });
    expect(d.react).toBe(true);
    expect(d.followup).toBeUndefined();
  });
});
