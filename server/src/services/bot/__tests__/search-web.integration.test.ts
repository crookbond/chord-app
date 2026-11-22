/**
 * `search_web` when SEARCH_PROVIDER is unset (the default, and — per the
 * owner's call that a paid search API isn't worth it for this product's
 * volume — the expected steady state). The tool must never let the model
 * fabricate a live result (ADR 0102 posture), but the fallback is not a
 * dead end: it hands back a zero-cost, no-key-needed "search this
 * yourself" link (a plain Google search URL, never fetched by us) as a
 * tappable card, so the honest "I can't search" answer still gives the
 * user somewhere to go.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

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

describe('search_web tool (SEARCH_PROVIDER unset)', () => {
  it('reports unavailable and writes nothing, but offers a search-yourself link', async () => {
    const res = await applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'search_web', args: { query: 'best thai restaurant in Sonoma' } },
    });
    expect(res.data).toMatchObject({ ok: false, reason: 'unavailable' });
    const searchUrl = (res.data as { searchUrl: string }).searchUrl;
    expect(searchUrl).toContain('google.com/search');
    expect(searchUrl).toContain(encodeURIComponent('best thai restaurant in Sonoma'));
    expect(res.card?.kind).toBe('action');
    expect(res.card?.url).toBe(searchUrl);
  });
});
