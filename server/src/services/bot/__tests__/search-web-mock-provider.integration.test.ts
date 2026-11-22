/**
 * `search_web` with SEARCH_PROVIDER=mock — the success path: real results
 * (fixture, not live) come back and the top hit rides as a tappable action
 * card, distinct from suggest_external_action's link-only cards.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, SEARCH_PROVIDER: 'mock' } };
});

let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john', 'John Doe');
  const g = await createGroup(db, { name: 'John', kind: 'personal', createdBy: userId });
  groupId = g.id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('search_web tool (SEARCH_PROVIDER=mock)', () => {
  it('returns results and a tappable card for the top hit', async () => {
    const { applyToolCall } = await import('@/services/bot/executor.js');
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'search_web', args: { query: 'best thai restaurant in Sonoma' } },
    });
    expect(res.data).toMatchObject({ ok: true });
    const results = (res.data as { results: Array<{ title: string; url: string }> }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('best thai restaurant in Sonoma');
    expect(res.card?.kind).toBe('action');
    expect(res.card?.url).toBe(results[0].url);
  });

  it('returns no results for an empty-signal query, with no card', async () => {
    const { applyToolCall } = await import('@/services/bot/executor.js');
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'search_web', args: { query: 'nothing' } },
    });
    expect(res.data).toMatchObject({ ok: true, results: [] });
    expect(res.card).toBeUndefined();
  });
});
