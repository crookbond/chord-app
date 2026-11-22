/**
 * The embedding sweep (ADR 0276) took the users with the newest unembedded
 * mail every tick. One who can never be embedded (no embedder for their key,
 * no consent) kept the first slot forever and everyone behind them waited.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetEmbedSweepForTests, sweepEmbeddings } from '@/services/search/embed-pass.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

const who = vi.hoisted(() => ({ noEmbedder: new Set<string>() }));

vi.mock('@/services/llm/embeddings.js', async (orig) => {
  const real = await orig<typeof import('@/services/llm/embeddings.js')>();
  const mock = new real.MockEmbedder();
  return {
    ...real,
    getEmbedderForUser: async (_db: unknown, userId: string) => (who.noEmbedder.has(userId) ? null : mock),
  };
});

const flags = env as { EMBEDDINGS_ENABLED: boolean; EMBED_SWEEP_BATCH: number };
const saved = { EMBEDDINGS_ENABLED: env.EMBEDDINGS_ENABLED, EMBED_SWEEP_BATCH: env.EMBED_SWEEP_BATCH };

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
  flags.EMBEDDINGS_ENABLED = true;
  flags.EMBED_SWEEP_BATCH = 1;
  who.noEmbedder.clear();
  __resetEmbedSweepForTests?.();
});

afterEach(async () => {
  Object.assign(flags, saved);
  await closeTestDb(db);
});

const embedded = async (userId: string) =>
  (
    await db
      .selectFrom('email_thread_embeddings as v')
      .innerJoin('email_threads as e', 'e.id', 'v.thread_id')
      .select('v.thread_id')
      .where('e.user_id', '=', userId)
      .execute()
  ).length;

describe('sweepEmbeddings', () => {
  it('does not let a user who can never be embedded starve the next one', async () => {
    const stuck = await createUser(db, 'stuck');
    const waiting = await createUser(db, 'waiting');
    await ensurePersonalGroup(db, stuck);
    await ensurePersonalGroup(db, waiting);
    who.noEmbedder.add(stuck);
    // The stuck user has the newest mail, so they sort first.
    await seedSyncedMail(db, stuck, { subject: 'Newest', fromEmail: 'a@x.test', at: new Date().toISOString() });
    await seedSyncedMail(db, waiting, {
      subject: 'Older',
      fromEmail: 'b@x.test',
      at: new Date(Date.now() - 86_400_000).toISOString(),
    });

    await sweepEmbeddings(db);
    await sweepEmbeddings(db);

    expect(await embedded(waiting)).toBe(1);
    expect(await embedded(stuck)).toBe(0);
  });

  it('does not re-run the candidate query while nothing is left to embed', async () => {
    const spy = vi.spyOn(db, 'selectFrom');
    expect(await sweepEmbeddings(db)).toBe(0);
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    expect(await sweepEmbeddings(db)).toBe(0);
    expect(spy.mock.calls.length).toBe(first);
  });
});
