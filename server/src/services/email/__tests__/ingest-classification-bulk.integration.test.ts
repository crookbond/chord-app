/**
 * `ingestClassification` replaces a user's whole tree. The snapshot the LLM
 * classifier builds carries the WHOLE mailbox forward from baseline, so its size
 * is every thread the user has, not the few that just arrived. It used to write
 * that one statement at a time inside a transaction (an insert and an update per
 * thread, an insert per category): 18.9 of each per sync at 19 threads in the
 * load test, thousands for a real mailbox, all while holding a connection and
 * the per-user advisory lock. It now writes in chunks; the rows must be the same.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmailClassificationSnapshot } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { ingestClassification, storageCategoryId } from '@/services/email/classification.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const THREADS = 1_230; // deliberately not a multiple of the chunk size
const CATS = 12;

/** Count the statements the ingest transaction issues, by kind. */
function countTxWrites(db: Kysely<DB>): { db: Kysely<DB>; counts: () => Record<string, number> } {
  const c: Record<string, number> = {};
  const wrapTx = (tx: unknown) =>
    new Proxy(tx as object, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === 'insertInto' || prop === 'updateTable' || prop === 'deleteFrom') {
          return (table: string) => {
            const k = `${String(prop)}:${table}`;
            c[k] = (c[k] ?? 0) + 1;
            return (v as (t: string) => unknown).call(target, table);
          };
        }
        if (prop === 'executeQuery') {
          return (q: { sql?: string }) => {
            const first = String(q?.sql ?? '').trim().split(/\s+/)[0]?.toLowerCase();
            if (first === 'update') c['raw:update'] = (c['raw:update'] ?? 0) + 1;
            return (v as (q: unknown) => unknown).call(target, q);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as never;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'transaction') {
        return () => ({
          execute: (fn: (tx: unknown) => Promise<unknown>) => target.transaction().execute((tx) => fn(wrapTx(tx))),
        });
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as Kysely<DB>;
  return { db: proxy, counts: () => ({ ...c }) };
}

describe('ingestClassification writes in bulk', () => {
  let db: Kysely<DB>;
  let uid: string;

  beforeEach(async () => {
    db = await openTestDb();
    uid = await createUser(db, 'bulk-cls');
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function seedThreads(n: number): Promise<string[]> {
    const now = new Date().toISOString();
    const ids: string[] = [];
    for (let start = 0; start < n; start += 300) {
      const rows = [];
      for (let i = start; i < Math.min(n, start + 300); i++) {
        ids.push(`gt${i}`);
        rows.push({
          id: `et_${i}`,
          user_id: uid,
          gmail_thread_id: `gt${i}`,
          subject: `Subject ${i}`,
          snippet: 'snippet',
          from_name: 'Sender',
          from_email: 'sender@example.com',
          last_message_at: now,
          message_count: 1,
          is_unread: 1,
          is_archived: 0,
          gmail_label_ids: JSON.stringify(['INBOX']),
          created_at: now,
          updated_at: now,
        });
      }
      await db.insertInto('email_threads').values(rows).execute();
    }
    return ids;
  }

  const snapshot = (ids: string[]): EmailClassificationSnapshot => ({
    version: 1,
    userId: uid,
    // A two-level tree so parents must land before children across the chunking.
    categories: [
      { id: 'root', parentId: null, title: 'Everything', depth: 0, sortOrder: 0 },
      ...Array.from({ length: CATS }, (_, i) => ({
        id: `c${i}`,
        parentId: 'root',
        title: `Cat ${i}`,
        depth: 1,
        sortOrder: i,
      })),
    ],
    assignments: ids.map((g, i) => ({
      gmailThreadId: g,
      categoryId: `c${i % CATS}`,
      confidence: 0.5,
      action: (['to_do', 'reply_needed', 'informational', 'other'] as const)[i % 4],
    })),
  });

  it('issues a handful of statements for a mailbox-sized snapshot, not two per thread', async () => {
    const ids = await seedThreads(THREADS);
    const counted = countTxWrites(db);
    const res = await ingestClassification(counted.db, uid, snapshot(ids));
    expect('ok' in res).toBe(false);

    const c = counted.counts();
    // 1,230 threads over 500-row chunks: 3 statements each, never 1,230.
    expect(c['insertInto:email_message_categories']).toBe(3);
    expect(c['insertInto:email_categories']).toBe(1);
    // The updates are one reset plus chunked set-based updates.
    expect((c['updateTable:email_threads'] ?? 0) + (c['raw:update'] ?? 0)).toBeLessThanOrEqual(5);
  });

  it('lands exactly the rows the one-at-a-time version did', async () => {
    const ids = await seedThreads(THREADS);
    const res = await ingestClassification(db, uid, snapshot(ids));
    expect(res).toMatchObject({ categories: CATS + 1, assignments: THREADS, skippedUnknownThreads: 0 });

    const threads = await db
      .selectFrom('email_threads')
      .select(['gmail_thread_id', 'category_id', 'action', 'classified_at'])
      .where('user_id', '=', uid)
      .execute();
    expect(threads).toHaveLength(THREADS);
    const actions = ['to_do', 'reply_needed', 'informational', 'other'];
    for (const t of threads) {
      const i = Number(t.gmail_thread_id.slice(2));
      expect(t.category_id).toBe(storageCategoryId(uid, `c${i % CATS}`));
      expect(t.action).toBe(actions[i % 4]);
      expect(t.classified_at).not.toBeNull();
    }
    const assigned = await db
      .selectFrom('email_message_categories')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', uid)
      .executeTakeFirstOrThrow();
    expect(Number(assigned.n)).toBe(THREADS);
    const cats = await db.selectFrom('email_categories').select('parent_id').where('user_id', '=', uid).execute();
    expect(cats).toHaveLength(CATS + 1);
    expect(cats.filter((c) => c.parent_id === null)).toHaveLength(1);
  });

  it('replaces what was there, and counts threads it does not know as skipped', async () => {
    const ids = await seedThreads(50);
    await ingestClassification(db, uid, snapshot(ids));
    const next = snapshot(ids.slice(0, 10));
    next.assignments.push({ gmailThreadId: 'never-synced', categoryId: 'c0', confidence: 1 });
    const res = await ingestClassification(db, uid, next);
    expect(res).toMatchObject({ assignments: 10, skippedUnknownThreads: 1 });

    const classified = await db
      .selectFrom('email_threads')
      .select('gmail_thread_id')
      .where('user_id', '=', uid)
      .where('category_id', 'is not', null)
      .execute();
    // Only the ten in the new snapshot keep a category; the rest were reset.
    // (`classified_at` is kept on all fifty: a classifier did read them.)
    expect(classified).toHaveLength(10);
  });

  it('lands "other" when a classifier sends no action', async () => {
    const ids = await seedThreads(3);
    const snap = snapshot(ids);
    delete snap.assignments[0]!.action;
    await ingestClassification(db, uid, snap);

    const t0 = await db
      .selectFrom('email_threads')
      .select(['action'])
      .where('gmail_thread_id', '=', ids[0]!)
      .where('user_id', '=', uid)
      .executeTakeFirstOrThrow();
    expect(t0.action).toBe('other');
  });
});
