/**
 * ADR 0178 — `bot-turn.queue.ts` registers itself onto `reactToMessage`'s
 * per-group tail (ADR 0155) via `setBotTurnEnqueuer`, mirroring the injection
 * shape ADR 0118's `setMailboxSyncRunner` and ADR 0176's `setMailSyncEnqueuer`
 * already established. These tests pin the injection point itself — the real
 * BullMQ mechanics (job add/complete round-trip, `maxStalledCount: 0`) were
 * smoke-tested against a real, disposable Redis and are not re-asserted here,
 * same split as `proactive.queue.ts`/`mail-sync.queue.ts`.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { awaitPendingBotReactions, reactToMessage, setBotTurnEnqueuer } from '@/services/bot/bot.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';
import { waitFor } from '@/__test-helpers__/wait.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await awaitPendingBotReactions();
  setBotTurnEnqueuer(null);
  await closeTestDb(db);
});

async function botReplyCount(groupId: string): Promise<number> {
  const rows = await db
    .selectFrom('messages')
    .select('id')
    .where('group_id', '=', groupId)
    .where('kind', '=', 'bot')
    .execute();
  return rows.length;
}

describe('bot turn enqueuer (REDIS_URL set — bot-turn.queue.ts registers this)', () => {
  it('hands the turn to the enqueuer instead of running it inline', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    const enqueuer = vi.fn(async () => {});
    setBotTurnEnqueuer(enqueuer);

    const msg = await insertMessage(db, { groupId: group.id, senderId: john, body: '@Chord hello' });
    reactToMessage(db, msg, { id: group.id, kind: 'group' });
    await awaitPendingBotReactions();

    expect(enqueuer).toHaveBeenCalledTimes(1);
    expect(enqueuer).toHaveBeenCalledWith(db, msg, { id: group.id, kind: 'group' }, undefined, undefined, 1);
    // The enqueuer only hands the turn off — the mock LLM never ran, so no
    // bot reply should exist.
    expect(await botReplyCount(group.id)).toBe(0);
  });

  it('falls back to running the turn inline once the enqueuer is cleared', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    const enqueuer = vi.fn(async () => {});
    setBotTurnEnqueuer(enqueuer);
    setBotTurnEnqueuer(null);

    const msg = await insertMessage(db, { groupId: group.id, senderId: john, body: '@Chord hello' });
    reactToMessage(db, msg, { id: group.id, kind: 'group' });
    await awaitPendingBotReactions();

    expect(enqueuer).not.toHaveBeenCalled();
    expect(await botReplyCount(group.id)).toBe(1);
  });

  it('still serializes same-group turns through the enqueuer (ADR 0155)', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    let inFlight = 0;
    let overlapped = false;
    const enqueuer = vi.fn(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
    });
    setBotTurnEnqueuer(enqueuer);

    const bodies = ['@Chord one', '@Chord two', '@Chord three'];
    for (const body of bodies) {
      const msg = await insertMessage(db, { groupId: group.id, senderId: john, body });
      reactToMessage(db, msg, { id: group.id, kind: 'group' });
    }
    await awaitPendingBotReactions();

    expect(enqueuer).toHaveBeenCalledTimes(3);
    expect(overlapped).toBe(false);
  });

  it('turns for different groups still run concurrently through the enqueuer', async () => {
    const john = await createUser(db, 'john', 'John');
    const a = await createGroup(db, { name: 'A', kind: 'group', createdBy: john });
    const b = await createGroup(db, { name: 'B', kind: 'group', createdBy: john });
    // Every turn is held open until the test lets go, so the second can only
    // start while the first is still running: no sleep decides the outcome.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueuer = vi.fn(async () => {
      await held;
    });
    setBotTurnEnqueuer(enqueuer);

    for (const g of [a, b]) {
      const msg = await insertMessage(db, { groupId: g.id, senderId: john, body: '@Chord hello' });
      reactToMessage(db, msg, { id: g.id, kind: 'group' });
    }
    const bothStarted = await waitFor(() => enqueuer.mock.calls.length === 2);
    release();
    await awaitPendingBotReactions();

    expect(bothStarted).toBe(true);
    expect(enqueuer).toHaveBeenCalledTimes(2);
  });
});
