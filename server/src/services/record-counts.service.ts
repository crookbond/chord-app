import { sql, type Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

/** One group's record, or every group a user belongs to (ADR 0290). */
export type RecordScope = { groupId: string } | { userId: string };

export interface ListCount {
  id: string;
  name: string;
  groupId: string;
  open: number;
  done: number;
}

export interface RecordCounts {
  /** Every list in scope, newest first, with exact item counts. */
  lists: ListCount[];
  saves: {
    total: number;
    byKind: Array<[kind: string, count: number]>;
    /** Every tag in scope, most used first; case-folded. */
    byTag: Array<[tag: string, count: number]>;
  };
  openTasks: number;
}

/**
 * Exact counts of what the bot's snapshot shows samples of. The samples are
 * capped (a turn cannot carry a family's whole record), so the model was
 * left to count a truncated preview and under-counted; these are counted in
 * SQL over the whole scope instead, and never capped.
 */
export async function loadRecordCounts(db: Kysely<DB>, scope: RecordScope): Promise<RecordCounts> {
  const inScope = <T extends 'lists.group_id' | 'saves.group_id' | 'tasks.group_id'>(col: T) =>
    'groupId' in scope
      ? sql<boolean>`${sql.ref(col)} = ${scope.groupId}`
      : sql<boolean>`${sql.ref(col)} in (select group_id from group_members where user_id = ${scope.userId})`;

  const [listRows, saveRows, taskRow] = await Promise.all([
    db
      .selectFrom('lists')
      .leftJoin('list_items', 'list_items.list_id', 'lists.id')
      .where(inScope('lists.group_id'))
      .select([
        'lists.id as id',
        'lists.name as name',
        'lists.group_id as groupId',
        sql<string>`count(list_items.id) filter (where list_items.checked = 0)`.as('open'),
        sql<string>`count(list_items.id) filter (where list_items.checked = 1)`.as('done'),
      ])
      .groupBy(['lists.id', 'lists.name', 'lists.group_id', 'lists.created_at'])
      .orderBy('lists.created_at', 'desc')
      .execute(),
    db.selectFrom('saves').where(inScope('saves.group_id')).select(['kind', 'tags']).execute(),
    db
      .selectFrom('tasks')
      .where(inScope('tasks.group_id'))
      .where('status', 'in', ['open', 'active'])
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirst(),
  ]);

  const byKind = new Map<string, number>();
  const byTag = new Map<string, number>();
  for (const s of saveRows) {
    byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    let tags: unknown = [];
    try {
      tags = JSON.parse(s.tags);
    } catch {
      // a malformed tags cell counts the save, not its tags
    }
    if (!Array.isArray(tags)) continue;
    const seen = new Set<string>();
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      const k = t.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      byTag.set(k, (byTag.get(k) ?? 0) + 1);
    }
  }
  const desc = (a: [string, number], b: [string, number]) => b[1] - a[1] || a[0].localeCompare(b[0]);

  return {
    lists: listRows.map((r) => ({
      id: r.id,
      name: r.name,
      groupId: r.groupId,
      open: Number(r.open),
      done: Number(r.done),
    })),
    saves: {
      total: saveRows.length,
      byKind: [...byKind.entries()].sort(desc),
      byTag: [...byTag.entries()].sort(desc),
    },
    openTasks: Number(taskRow?.n ?? 0),
  };
}
