/**
 * ADR 0061 — classifier contract ingest + tile rollup (consumer side).
 */
import { Kysely, type KyselyPlugin } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EmailClassificationSnapshot } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import {
  categorySubtreeIds,
  getTiles,
  ingestClassification,
  validateSnapshot,
  storageCategoryId as sid,
} from '@/services/email/classification.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seedThread(
  userId: string,
  gmailThreadId: string,
  subject = 's',
  snippet = '',
): Promise<string> {
  const id = newId('emt');
  const now = new Date().toISOString();
  await db
    .insertInto('email_threads')
    .values({
      id,
      user_id: userId,
      gmail_thread_id: gmailThreadId,
      subject,
      snippet,
      last_message_at: now,
      created_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

function snap(
  userId: string,
  categories: EmailClassificationSnapshot['categories'],
  assignments: EmailClassificationSnapshot['assignments'],
): EmailClassificationSnapshot {
  return { version: 1, userId, categories, assignments };
}

describe('validateSnapshot', () => {
  const cat = (id: string, parentId: string | null, depth: number) => ({
    id,
    parentId,
    title: id,
    depth,
  });

  it('rejects a dangling parentId', () => {
    const s = snap('u', [cat('a', 'ghost', 1)], []);
    expect(validateSnapshot(s)).toMatchObject({ ok: false });
  });

  it('rejects a cycle', () => {
    const s = snap('u', [cat('a', 'b', 1), cat('b', 'a', 1)], []);
    expect(validateSnapshot(s)).toMatchObject({ ok: false });
  });

  it('rejects an assignment to an unknown category', () => {
    const s = snap('u', [cat('a', null, 0)], [{ gmailThreadId: 't', categoryId: 'x' }]);
    expect(validateSnapshot(s)).toMatchObject({ ok: false });
  });

  it('accepts a well-formed tree', () => {
    const s = snap('u', [cat('a', null, 0), cat('b', 'a', 1)], [{ gmailThreadId: 't', categoryId: 'b' }]);
    expect(validateSnapshot(s)).toEqual({ ok: true });
  });
});

describe('ingest + tiles rollup', () => {
  const TREE = [
    { id: 'fin', parentId: null, title: 'Finance', depth: 0, sortOrder: 0 },
    { id: 'fin/stmt', parentId: 'fin', title: 'Statements', depth: 1, sortOrder: 0 },
    { id: 'fin/bank', parentId: 'fin', title: 'Bank alerts', depth: 1, sortOrder: 1 },
  ];

  it('maps gmail thread ids, skips unknown, and rolls counts up the tree', async () => {
    const userId = await createUser(db, 'tiles-user');
    await seedThread(userId, 't1');
    await seedThread(userId, 't2');
    await seedThread(userId, 't3');

    const res = await ingestClassification(
      db,
      userId,
      snap(userId, TREE, [
        { gmailThreadId: 't1', categoryId: 'fin/stmt' },
        { gmailThreadId: 't2', categoryId: 'fin/stmt' },
        { gmailThreadId: 't3', categoryId: 'fin/bank' },
        { gmailThreadId: 'not-synced', categoryId: 'fin/bank' },
      ]),
    );
    expect(res).toMatchObject({ categories: 3, assignments: 3, skippedUnknownThreads: 1 });

    // Root level: Finance carries the whole subtree count (2 + 1).
    const root = await getTiles(db, userId, null);
    expect(root.tiles).toHaveLength(1);
    expect(root.tiles[0]).toMatchObject({ id: sid(userId, 'fin'), count: 3, hasChildren: true });
    expect(root.directThreadCount).toBe(0); // all 3 threads are classified

    // Drill into Finance: its two leaves with their own counts.
    const fin = await getTiles(db, userId, sid(userId, 'fin'));
    expect(fin.parent).toMatchObject({ id: sid(userId, 'fin'), count: 3 });
    expect(fin.tiles.map((t) => [t.id, t.count, t.hasChildren])).toEqual([
      [sid(userId, 'fin/stmt'), 2, false],
      [sid(userId, 'fin/bank'), 1, false],
    ]);

    // Leaf: no child tiles, directThreadCount = its assignments (flip-to-list).
    const stmt = await getTiles(db, userId, sid(userId, 'fin/stmt'));
    expect(stmt.tiles).toHaveLength(0);
    expect(stmt.directThreadCount).toBe(2);
  });

  it('replace-upserts: a second snapshot prunes the old tree', async () => {
    const userId = await createUser(db, 'replace-user');
    await seedThread(userId, 't1');
    await ingestClassification(db, userId, snap(userId, TREE, [{ gmailThreadId: 't1', categoryId: 'fin/stmt' }]));

    // New snapshot with a different tree + no assignment for t1.
    await ingestClassification(
      db,
      userId,
      snap(userId, [{ id: 'trav', parentId: null, title: 'Travel', depth: 0 }], []),
    );
    const root = await getTiles(db, userId, null);
    expect(root.tiles.map((t) => t.id)).toEqual([sid(userId, 'trav')]);
    // t1 is unclassified again → surfaces in root's directThreadCount.
    expect(root.directThreadCount).toBe(1);
  });

  it('rolls attention + magic up the tree; deep nests children (ADR 0068)', async () => {
    const userId = await createUser(db, 'attn-user');
    const t1 = await seedThread(userId, 't1', 'Statement ready'); // unread AND carrying a suggestion → attention once
    await seedThread(userId, 't2'); // read, nothing pending
    const t3 = await seedThread(userId, 't3'); // read but carrying a suggestion
    await db.updateTable('email_threads').set({ is_unread: 1 }).where('id', '=', t1).execute();

    await ingestClassification(
      db,
      userId,
      snap(userId, TREE, [
        { gmailThreadId: 't1', categoryId: 'fin/stmt' },
        { gmailThreadId: 't2', categoryId: 'fin/stmt' },
        { gmailThreadId: 't3', categoryId: 'fin/bank' },
      ]),
    );

    const personal = await ensurePersonalGroup(db, userId);
    for (const gid of ['t1', 't3']) {
      await createProposal(db, {
        groupId: personal.id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: 'add_list_item',
        args: { listName: 'Todo', items: ['x'] },
        provenance: `gmail:${gid}`,
      });
    }

    const root = await getTiles(db, userId, null, { deep: true });
    expect(root.tiles[0]).toMatchObject({ id: sid(userId, 'fin'), count: 3, attention: 2, magicCount: 2 });
    const kids = root.tiles[0].children!;
    expect(kids.map((k) => [k.id, k.attention, k.magicCount])).toEqual([
      [sid(userId, 'fin/stmt'), 1, 1],
      [sid(userId, 'fin/bank'), 1, 1],
    ]);

    // Previews: magic titles first, then newest-unread subjects; the parent
    // rolls up its subtree's lines (capped at 3), each carrying the local
    // thread row id for the deep link.
    const finPreview = root.tiles[0].preview!;
    expect(finPreview).toHaveLength(3);
    // Two magics lead (created same instant — order between them unspecified),
    // the unread subject fills last.
    expect(finPreview.slice(0, 2).map((p) => p.kind)).toEqual(['magic', 'magic']);
    expect(new Set(finPreview.slice(0, 2).map((p) => p.threadId))).toEqual(new Set([t1, t3]));
    expect(finPreview[2]).toEqual({ kind: 'unread', text: 'Statement ready', threadId: t1 });
    const stmt = kids.find((k) => k.id === sid(userId, 'fin/stmt'))!;
    // ADR 0110 — t2 is read with nothing pending, and used to contribute
    // nothing at all: a tile built only from open work goes blank the moment
    // its work is done. It now fills the third slot, below both open lines.
    expect(stmt.preview).toEqual([
      { kind: 'magic', text: 'x', threadId: t1 },
      { kind: 'unread', text: 'Statement ready', threadId: t1 },
      { kind: 'recent', text: 's', threadId: expect.any(String) },
    ]);
    // ADR 0110 — t3 is read, so it used to appear ONLY through its pending
    // suggestion, and this tile went blank the moment that was acted on. It now
    // also carries the thread's own subject, below the suggestion.
    const bank = kids.find((k) => k.id === sid(userId, 'fin/bank'))!;
    expect(bank.preview).toEqual([
      { kind: 'magic', text: 'x', threadId: t3 },
      { kind: 'recent', text: 's', threadId: t3 },
    ]);

    // Without deep, no children; counts unchanged.
    const flat = await getTiles(db, userId, null);
    expect(flat.tiles[0].children).toBeUndefined();
    expect(flat.tiles[0]).toMatchObject({ attention: 2, magicCount: 2 });

    // Resolving a suggestion removes it from attention + magic.
    await db
      .updateTable('proposals')
      .set({ status: 'rejected' })
      .where('provenance', '=', 'gmail:t3')
      .execute();
    const after = await getTiles(db, userId, null);
    expect(after.tiles[0]).toMatchObject({ attention: 1, magicCount: 1 });
  });

  it('falls back to a keyword emoji for tile icons; explicit icon wins (ADR 0068)', async () => {
    const userId = await createUser(db, 'icon-user');
    await ingestClassification(
      db,
      userId,
      snap(
        userId,
        [
          { id: 'trav', parentId: null, title: 'Travel', depth: 0, icon: '🚀' },
          { id: 'news', parentId: null, title: 'Newsletters', depth: 0 },
          { id: 'misc', parentId: null, title: 'Zebra facts', depth: 0 },
        ],
        [],
      ),
    );
    const root = await getTiles(db, userId, null);
    const iconOf = (id: string) => root.tiles.find((t) => t.id === sid(userId, id))!.icon;
    expect(iconOf('trav')).toBe('🚀'); // classifier-assigned wins over the ✈️/🧳 keywords
    expect(iconOf('news')).toBe('📰'); // keyword fallback
    expect(iconOf('misc')).toBeNull(); // no match → no icon
  });

  it('categorySubtreeIds returns the node plus all descendants', async () => {
    const userId = await createUser(db, 'subtree-user');
    await ingestClassification(db, userId, snap(userId, TREE, []));
    const ids = await categorySubtreeIds(db, userId, sid(userId, 'fin'));
    expect(new Set(ids)).toEqual(new Set([sid(userId, 'fin'), sid(userId, 'fin/stmt'), sid(userId, 'fin/bank')]));
  });

  it('attaches timeline facts for a school event proposal (ADR 0087)', async () => {
    const userId = await createUser(db, 'facts-school');
    const threadId = await seedThread(userId, 'g-recital', 'Recital Friday');
    await ingestClassification(
      db,
      userId,
      snap(
        userId,
        [
          { id: 'fam', parentId: null, title: 'Friends & family', depth: 0 },
          { id: 'fam/school', parentId: 'fam', title: 'School notes', depth: 1 },
        ],
        [{ gmailThreadId: 'g-recital', categoryId: 'fam/school' }],
      ),
    );
    const personal = await ensurePersonalGroup(db, userId);
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Recital', startsAt: '2099-01-15T15:00:00-07:00' },
      provenance: 'gmail:g-recital',
    });
    await createProposal(db, {
      groupId: personal.id,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_event',
      args: { title: 'Old concert', startsAt: '2020-01-01T15:00:00Z' },
      provenance: 'gmail:g-recital',
    });

    const root = await getTiles(db, userId, null, { deep: true });
    const school = root.tiles[0].children!.find((c) => c.id === sid(userId, 'fam/school'))!;
    expect(school.archetype).toBe('timeline');
    expect(school.facts).toEqual({
      kind: 'timeline',
      items: [
        {
          title: 'Recital',
          at: '2099-01-15T15:00:00-07:00',
          threadId,
          proposalId: expect.any(String),
        },
      ],
    });
  });

  it('attaches ledger facts only when an amount parses; skips receipts without due', async () => {
    const userId = await createUser(db, 'facts-led');
    await seedThread(userId, 'g-bill', 'Invoice $1,240 due 2026-09-01', 'Please pay');
    await seedThread(userId, 'g-rcpt', 'Your receipt $12.00', 'Thank you for your order');
    await ingestClassification(
      db,
      userId,
      snap(userId, TREE, [
        { gmailThreadId: 'g-bill', categoryId: 'fin/stmt' },
        { gmailThreadId: 'g-rcpt', categoryId: 'fin/bank' },
      ]),
    );
    const fin = await getTiles(db, userId, sid(userId, 'fin'));
    const stmt = fin.tiles.find((t) => t.id === sid(userId, 'fin/stmt'))!;
    expect(stmt.archetype).toBe('ledger');
    expect(stmt.facts?.kind).toBe('ledger');
    expect(stmt.facts?.kind === 'ledger' && stmt.facts.items[0].amount).toBe(1240);
    const bank = fin.tiles.find((t) => t.id === sid(userId, 'fin/bank'))!;
    expect(bank.archetype ?? null).toBeNull();
    expect(bank.facts).toBeUndefined();
  });

  it('reads facts from the last year of mail and from email events still ahead only', async () => {
    const userId = await createUser(db, 'facts-bounded');
    const liveId = await seedThread(userId, 'g-ship', 'Your package shipped', 'Out for delivery today');
    const oldId = await seedThread(userId, 'g-old', 'Your package shipped', 'Out for delivery today');
    const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    await db.updateTable('email_threads').set({ last_message_at: longAgo }).where('id', '=', oldId).execute();
    await ingestClassification(
      db,
      userId,
      snap(
        userId,
        [
          { id: 'deliv', parentId: null, title: 'Deliveries', depth: 0 },
          { id: 'deliv/ship', parentId: 'deliv', title: 'Shipping updates', depth: 1 },
        ],
        [
          { gmailThreadId: 'g-ship', categoryId: 'deliv/ship' },
          { gmailThreadId: 'g-old', categoryId: 'deliv/ship' },
        ],
      ),
    );
    const personal = await ensurePersonalGroup(db, userId);
    const now = new Date().toISOString();
    const event = (title: string, startsAt: string) => ({
      id: newId('evt'),
      group_id: personal.id,
      owner_user_id: userId,
      title,
      starts_at: startsAt,
      source_raw_context: 'gmail:g-ship',
      created_at: now,
      updated_at: now,
    });
    await db
      .insertInto('events')
      .values([
        ...Array.from({ length: 5 }, (_, i) =>
          event(`Past ${i}`, new Date(Date.now() - (30 + i) * 86_400_000).toISOString()),
        ),
        event('Pickup', new Date(Date.now() + 3 * 86_400_000).toISOString()),
      ] as never)
      .execute();

    // Which table each read hit, and how many rows it brought back.
    const tables = new Map<unknown, string>();
    const rowsRead: Record<string, number> = {};
    const spy: KyselyPlugin = {
      transformQuery(args) {
        const node = args.node as { kind: string; from?: { froms: { table?: { identifier?: { name?: string } } }[] } };
        const name = node.kind === 'SelectQueryNode' ? node.from?.froms[0]?.table?.identifier?.name : undefined;
        if (name) tables.set(args.queryId, name);
        return args.node;
      },
      async transformResult(args) {
        const name = tables.get(args.queryId);
        if (name) rowsRead[name] = (rowsRead[name] ?? 0) + args.result.rows.length;
        return args.result;
      },
    };

    const root = await getTiles(db.withPlugin(spy), userId, null, { deep: true });
    const ship = root.tiles[0].children!.find((c) => c.id === sid(userId, 'deliv/ship'))!;
    expect(ship.facts).toEqual({
      kind: 'state_board',
      items: [{ title: 'Your package shipped', status: 'out_for_delivery', threadId: liveId }],
    });
    expect(rowsRead.events).toBe(1);
  });

  it('attaches state-board facts for live shipping and drops delivered', async () => {
    const userId = await createUser(db, 'facts-ship');
    const liveId = await seedThread(userId, 'g-ship', 'Your package shipped', 'Out for delivery today');
    await seedThread(userId, 'g-done', 'Your package was delivered', 'Left at the door');
    await ingestClassification(
      db,
      userId,
      snap(
        userId,
        [
          { id: 'deliv', parentId: null, title: 'Deliveries', depth: 0 },
          { id: 'deliv/ship', parentId: 'deliv', title: 'Shipping updates', depth: 1 },
        ],
        [
          { gmailThreadId: 'g-ship', categoryId: 'deliv/ship' },
          { gmailThreadId: 'g-done', categoryId: 'deliv/ship' },
        ],
      ),
    );
    const root = await getTiles(db, userId, null, { deep: true });
    const ship = root.tiles[0].children!.find((c) => c.id === sid(userId, 'deliv/ship'))!;
    expect(ship.archetype).toBe('state_board');
    expect(ship.facts).toEqual({
      kind: 'state_board',
      items: [{ title: 'Your package shipped', status: 'out_for_delivery', threadId: liveId }],
    });
  });
});
