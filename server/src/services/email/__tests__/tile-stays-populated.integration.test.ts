/**
 * ADR 0110 — a tile still shows what it holds after you act on it.
 *
 * Reported: "emails that have been acted upon disappear. At least a snippet
 * should stay in the tile." Tile content was built entirely from OPEN work —
 * pending magic suggestions, plus newest-unread as filler — and confirming a
 * suggestion leaves both sources in one gesture: the proposal stops being
 * pending and the thread is marked read.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { getTiles, ingestClassification } from '@/services/email/classification.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('a handled tile keeps its content', () => {
  let db: Kysely<DB>;
  let userId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'tile-content');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const seed = async (gid: string, subject: string, unread: number): Promise<void> => {
    const now = new Date().toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: userId,
        gmail_thread_id: gid,
        subject,
        snippet: subject,
        is_unread: unread,
        last_message_at: now,
        created_at: now,
        updated_at: now,
      })
      .execute();
  };

  const classifyAll = async (gids: string[]): Promise<void> => {
    const res = await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'c:finance', parentId: null, title: 'Finance', depth: 0 }],
      assignments: gids.map((gmailThreadId) => ({ gmailThreadId, categoryId: 'c:finance' })),
    });
    expect('assignments' in res).toBe(true);
  };

  const financeTile = async () => {
    const tiles = await getTiles(db, userId, null, { deep: true });
    const tile = tiles.tiles.find((t) => t.title === 'Finance');
    expect(tile).toBeDefined();
    return tile!;
  };

  it('shows a line when nothing is unread and nothing is pending', async () => {
    // Everything here has been dealt with: read, no suggestions outstanding.
    await seed('t_a', 'Card statement ready', 0);
    await seed('t_b', 'Autopay scheduled', 0);
    await classifyAll(['t_a', 't_b']);

    const tile = await financeTile();
    // The count is allowed to fall to zero — a handled category should stop
    // shouting. Going BLANK is the defect.
    expect(tile.attention).toBe(0);
    expect(tile.preview?.length ?? 0).toBeGreaterThan(0);
    expect(tile.preview?.every((p) => p.kind === 'recent')).toBe(true);
    // Feed and Cards show a sentence or two of the email under its subject.
    expect(tile.preview?.find((p) => p.text === 'Autopay scheduled')?.snippet).toBe('Autopay scheduled');
  });

  it('still ranks unread above merely recent, and never lists a thread twice', async () => {
    await seed('t_read', 'Old statement', 0);
    await seed('t_new', 'Payment due Friday', 1);
    await classifyAll(['t_read', 't_new']);

    const tile = await financeTile();
    // The unread thread is also a recent one; one line, not two.
    const texts = (tile.preview ?? []).map((p) => p.text);
    expect(texts.filter((t) => t === 'Payment due Friday')).toHaveLength(1);
    expect(tile.preview?.[0]).toMatchObject({ kind: 'unread', text: 'Payment due Friday' });
  });
});
