import { sql, type Kysely } from 'kysely';

import type { List, ListItem, ListNameResolution } from '@chord/kernel';
import { listNameKey, normalizeText, resolveListName } from '@chord/kernel';

import type { DB, ListItemsTable, ListsTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { mergeListInto } from '../db/list-merge.js';
import { loadDisplayNames } from '../utils/display-names.js';
import { fanoutAssignment } from './catchup/folders.service.js';
import { logger } from '../config/logging.js';

function rowToList(row: ListsTable): List {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/**
 * Every item of these lists, oldest first (display order), under a defensive
 * cap - bounding the lists bounds the IN clause, not how many items each list
 * holds. When the cap bites it drops the oldest TICKED items: taken oldest-
 * first, it dropped the newest ones, so a long-used grocery list stopped
 * showing what was just added. Ticked items are never pruned, so this is the
 * pile that grows.
 */
async function loadItemsForLists(db: Kysely<DB>, listIds: string[]): Promise<ListItemsTable[]> {
  const rows = await db
    .selectFrom('list_items')
    .selectAll()
    .where('list_id', 'in', listIds)
    .orderBy('checked', 'asc')
    .orderBy('created_at', 'desc')
    .limit(5000)
    .execute();
  return rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
}

/** The first `perList` unticked items of each list, oldest first - what a
 *  preview shows, without loading every item of every list. */
export async function openItemSamples(
  db: Kysely<DB>,
  listIds: string[],
  perList: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (listIds.length === 0 || perList <= 0) return out;
  const rows = await db
    .selectFrom((qb) =>
      qb
        .selectFrom('list_items')
        .select([
          'list_id',
          'text',
          sql<number>`row_number() over (partition by list_id order by created_at asc, id asc)`.as('n'),
        ])
        .where('list_id', 'in', listIds)
        .where('checked', '=', 0)
        .as('ranked'),
    )
    .select(['list_id', 'text'])
    .where('n', '<=', perList)
    .orderBy('list_id')
    .orderBy('n')
    .execute();
  for (const r of rows) {
    const arr = out.get(r.list_id) ?? [];
    arr.push(r.text);
    out.set(r.list_id, arr);
  }
  return out;
}

function rowToItem(row: ListItemsTable): ListItem {
  return {
    id: row.id,
    listId: row.list_id,
    text: row.text,
    checked: row.checked === 1,
    createdAt: row.created_at,
  };
}

export async function listLists(
  db: Kysely<DB>,
  groupId: string,
  opts?: { withNames?: boolean; limit?: number },
): Promise<Array<List & { items: ListItem[] }>> {
  const lists = await db
    .selectFrom('lists')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc')
    // Unbounded over a group's lifetime otherwise; see listTasks for the
    // same reasoning. 200 is generous for any normal family group.
    .limit(opts?.limit ?? 200)
    .execute();
  if (lists.length === 0) return [];
  const items = await loadItemsForLists(db, lists.map((l) => l.id));
  const byList = new Map<string, ListItem[]>();
  for (const it of items) {
    const arr = byList.get(it.list_id) ?? [];
    arr.push(rowToItem(it));
    byList.set(it.list_id, arr);
  }
  // Callers that only read names/items (e.g. the bot's group snapshot) pass
  // withNames:false to skip the per-creator display-name lookup.
  if (opts?.withNames === false) {
    return lists.map((l) => ({ ...rowToList(l), items: byList.get(l.id) ?? [] }));
  }
  const names = await loadDisplayNames(db, lists.map((l) => l.created_by));
  return lists.map((l) => ({
    ...rowToList(l),
    createdByName: l.created_by ? names.get(l.created_by) : undefined,
    items: byList.get(l.id) ?? [],
  }));
}

export async function listListsForUser(
  db: Kysely<DB>,
  userId: string,
  opts?: { limit?: number },
): Promise<Array<List & { items: ListItem[] }>> {
  // Lists are group-scoped; surface every list from every group the user
  // is a member of, regardless of who created it. Filtering by
  // `created_by` would hide lists the bot wrote on behalf of another
  // member (e.g. John asks @Chord to add to the Walmart list — the row's
  // created_by points at John, but Alice in the same group should
  // also see it in her /me/lists view).
  const lists = await db
    .selectFrom('lists')
    .innerJoin('group_members', 'group_members.group_id', 'lists.group_id')
    .where('group_members.user_id', '=', userId)
    .selectAll('lists')
    .orderBy('lists.created_at', 'desc')
    .limit(opts?.limit ?? 200)
    .execute();
  if (lists.length === 0) return [];
  const items = await loadItemsForLists(db, lists.map((l) => l.id));
  const byList = new Map<string, ListItem[]>();
  for (const it of items) {
    const arr = byList.get(it.list_id) ?? [];
    arr.push(rowToItem(it));
    byList.set(it.list_id, arr);
  }
  const names = await loadDisplayNames(db, lists.map((l) => l.created_by));
  return lists.map((l) => ({
    ...rowToList(l),
    createdByName: l.created_by ? names.get(l.created_by) : undefined,
    items: byList.get(l.id) ?? [],
  }));
}

/**
 * Direct-SQL search for `search_saves`/`search`'s lists category — matches a
 * list NAME (`search_tsv`/literal) or an item's TEXT, scoped by group_id or
 * cross-group membership in SQL, not `listLists(ForUser)`'s 200-row
 * `created_at DESC` page. `list_items` carries no `group_id` of its own, so
 * item matching joins through `lists` for scope. When the list's own NAME
 * matched, every item is returned (matching the pre-existing "restaurants"
 * → "restaurants to try" surfaces the whole list behavior); otherwise only
 * the matching items. See `findEventsByTitle`'s doc comment
 * (events.service.ts) for the root-cause class of bug this replaces.
 */
export async function searchListsScoped(
  db: Kysely<DB>,
  scope: { groupId: string } | { crossGroupUserId: string },
  opts: { tsq: string | null; qLike: string; cap: number },
): Promise<Array<List & { items: ListItem[]; nameHit: boolean }>> {
  const nameMatchedRows =
    'groupId' in scope
      ? await db
          .selectFrom('lists')
          .selectAll()
          .where('group_id', '=', scope.groupId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(name) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .execute()
      : await db
          .selectFrom('lists')
          .innerJoin('group_members', 'group_members.group_id', 'lists.group_id')
          .where('group_members.user_id', '=', scope.crossGroupUserId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`lists.search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(lists.name) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .selectAll('lists')
          .execute();

  const itemMatchedRows =
    'groupId' in scope
      ? await db
          .selectFrom('list_items')
          .innerJoin('lists', 'lists.id', 'list_items.list_id')
          .where('lists.group_id', '=', scope.groupId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`list_items.search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(list_items.text) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .selectAll('list_items')
          .orderBy('list_items.created_at', 'asc')
          .limit(2000)
          .execute()
      : await db
          .selectFrom('list_items')
          .innerJoin('lists', 'lists.id', 'list_items.list_id')
          .innerJoin('group_members', 'group_members.group_id', 'lists.group_id')
          .where('group_members.user_id', '=', scope.crossGroupUserId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`list_items.search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(list_items.text) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .selectAll('list_items')
          .orderBy('list_items.created_at', 'asc')
          .limit(2000)
          .execute();

  const nameMatchedIds = new Set(nameMatchedRows.map((l) => l.id));
  const itemsByList = new Map<string, typeof itemMatchedRows>();
  for (const it of itemMatchedRows) {
    const arr = itemsByList.get(it.list_id) ?? [];
    arr.push(it);
    itemsByList.set(it.list_id, arr);
  }

  // Lists that matched only via an item, not their own name — need their
  // own row (name/groupId) too, fetched by exact id (small, bounded set).
  const itemOnlyIds = [...itemsByList.keys()].filter((id) => !nameMatchedIds.has(id));
  const itemOnlyRows = itemOnlyIds.length
    ? await db.selectFrom('lists').selectAll().where('id', 'in', itemOnlyIds).execute()
    : [];

  const candidateLists = [...nameMatchedRows, ...itemOnlyRows].slice(0, opts.cap);
  if (candidateLists.length === 0) return [];

  // Name-matched lists surface EVERY item — fetched by exact list id (a
  // small set), never by group-recency-cap.
  const nameMatchedInResult = candidateLists.filter((l) => nameMatchedIds.has(l.id)).map((l) => l.id);
  const allItemsForNameMatched = nameMatchedInResult.length
    ? await db
        .selectFrom('list_items')
        .selectAll()
        .where('list_id', 'in', nameMatchedInResult)
        .orderBy('created_at', 'asc')
        .execute()
    : [];
  const allItemsByList = new Map<string, typeof allItemsForNameMatched>();
  for (const it of allItemsForNameMatched) {
    const arr = allItemsByList.get(it.list_id) ?? [];
    arr.push(it);
    allItemsByList.set(it.list_id, arr);
  }

  return candidateLists.map((l) => {
    const nameHit = nameMatchedIds.has(l.id);
    const items = nameHit ? (allItemsByList.get(l.id) ?? []) : (itemsByList.get(l.id) ?? []);
    return { ...rowToList(l), nameHit, items: items.map(rowToItem) };
  });
}

export async function getList(db: Kysely<DB>, id: string): Promise<List | null> {
  const row = await db.selectFrom('lists').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToList(row) : null;
}

export interface RenameListResult {
  /** The surviving list. On a merge this may NOT be the list that was renamed. */
  list: List;
  /** Set when the new name collided with a list that already existed. */
  merged: { removedListId: string; removedName: string; movedItems: number } | null;
}

/**
 * Rename a list, merging rather than colliding.
 *
 * Since ADR 0094 a name is identified by `listNameKey`, so renaming
 * "restaurants" to "Restaurants" when "Restaurants" already exists would
 * leave two rows sharing one key — and resolution takes the older, quietly
 * stranding the other list's items. Renaming a list is not asking to lose it,
 * so the collision folds: the OLDEST of the colliding set keeps the rows (the
 * same keeper rule migration 042 uses), takes the name the user typed, and
 * absorbs the others' items.
 */
export async function renameList(
  db: Kysely<DB>,
  listId: string,
  newName: string,
): Promise<RenameListResult | null> {
  const trimmed = newName.trim();
  if (!trimmed) return null;
  const existing = await db
    .selectFrom('lists')
    .selectAll()
    .where('id', '=', listId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.name === trimmed) return { list: rowToList(existing), merged: null };

  const key = listNameKey(trimmed);
  const collisions = (await listListNames(db, existing.group_id)).filter(
    (l) => l.id !== listId && listNameKey(l.name) === key,
  );

  if (collisions.length === 0) {
    await db.updateTable('lists').set({ name: trimmed }).where('id', '=', listId).execute();
    return { list: rowToList({ ...existing, name: trimmed }), merged: null };
  }

  // Oldest wins. `listListNames` is oldest-first and `existing` is not in it,
  // so compare against the head explicitly.
  const oldest = collisions[0];
  const keeperIsExisting = existing.created_at <= oldest.createdAt;
  const keeperId = keeperIsExisting ? listId : oldest.id;
  const absorb = [...collisions.map((l) => l.id), listId].filter((id) => id !== keeperId);

  let movedItems = 0;
  let removedName = '';
  for (const dupeId of absorb) {
    const row = collisions.find((l) => l.id === dupeId);
    removedName = row ? row.name : existing.name;
    movedItems += await mergeListInto(db, keeperId, dupeId);
  }
  await db.updateTable('lists').set({ name: trimmed }).where('id', '=', keeperId).execute();

  const keeperRow = await db
    .selectFrom('lists')
    .selectAll()
    .where('id', '=', keeperId)
    .executeTakeFirstOrThrow();
  return {
    list: rowToList(keeperRow),
    merged: { removedListId: absorb[0], removedName, movedItems },
  };
}

export async function createList(
  db: Kysely<DB>,
  input: { groupId: string; name: string; createdBy: string | null },
): Promise<List> {
  const id = newId('l');
  const row: ListsTable = {
    id,
    group_id: input.groupId,
    name: input.name,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('lists').values(row).execute();
  await fanoutAssignment(db, input.groupId, 'list', id, {
    type: 'list',
    primary: input.name,
  }).catch((err) => logger.warn('catchup fanout (list) failed', { err }));
  return rowToList(row);
}

/**
 * Result of `addItem`. `created=true` for fresh rows; `false` when the
 * call was a no-op because an item with the same normalized text
 * already exists on the list. Callers (bot tools, route handlers)
 * read this so the user gets "already on your list" instead of a
 * silent duplicate.
 */
export interface AddItemResult {
  item: ListItem;
  created: boolean;
}

export async function addItem(
  db: Kysely<DB>,
  listId: string,
  text: string,
): Promise<AddItemResult> {
  // Dedup on normalized text within the same list. We always return the
  // *unchecked* duplicate first if there is one (so re-adding a checked-
  // off item naturally un-archives it for the user) and fall back to any
  // existing match otherwise.
  const wantedKey = normalizeText(text);
  // Two adds of the same text at once (two people, two devices, an offline
  // replay) would both miss the SELECT below and both INSERT; the same lock
  // shape as resolveOrCreateListByName (ADR 0165) makes the second one wait
  // and find the first.
  const run = async (trx: Kysely<DB>): Promise<AddItemResult> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${listId}), hashtext(${wantedKey}))`.execute(trx);
    return addItemLocked(trx, listId, text, wantedKey);
  };
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

async function addItemLocked(
  db: Kysely<DB>,
  listId: string,
  text: string,
  wantedKey: string,
): Promise<AddItemResult> {
  // Bounded, not a real index lookup: normalizeText has no SQL-side
  // equivalent (ADR 0094 rejected porting a JS normalizer into Postgres —
  // "the drift trap"), so this still matches in JS. Ordering newest-first and
  // capping at 500 keeps a long-lived list from being loaded whole on every
  // add; 500 items on one list is far beyond any real family list, so this
  // doesn't change dedup behavior today. A from-scratch SQL-side exact-match
  // design (an ADR 0094-style canonical key for item text) would remove the
  // cap entirely, but needs its own ADR + migration.
  const candidates = await db
    .selectFrom('list_items')
    .selectAll()
    .where('list_id', '=', listId)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
  const match =
    candidates.find((c) => normalizeText(c.text) === wantedKey && c.checked === 0) ??
    candidates.find((c) => normalizeText(c.text) === wantedKey);
  if (match) {
    return { item: rowToItem(match), created: false };
  }

  const id = newId('li');
  const row: ListItemsTable = {
    id,
    list_id: listId,
    text,
    checked: 0,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('list_items').values(row).execute();
  return { item: rowToItem(row), created: true };
}

/**
 * Toggle an item's checked flag and fan out to every other item in
 * the same group with the same normalized text. So checking "milk" in
 * the Walmart list also marks "milk" in the Errands list as done —
 * across every list of every kind in that group. The user's mental
 * model treats "milk" as one logical thing; the storage shape happens
 * to hold N rows. This keeps them in sync.
 *
 * Returns the (now-updated) item the caller asked about, or null if
 * it didn't exist.
 */
export async function setItemChecked(
  db: Kysely<DB>,
  itemId: string,
  checked: boolean,
): Promise<ListItem | null> {
  // Resolve the source item + its enclosing list's group_id so we can
  // scope the fanout to a single group (privacy + scale).
  const source = await db
    .selectFrom('list_items')
    .innerJoin('lists', 'lists.id', 'list_items.list_id')
    .select([
      'list_items.id as id',
      'list_items.text as text',
      'lists.group_id as groupId',
    ])
    .where('list_items.id', '=', itemId)
    .executeTakeFirst();
  if (!source) return null;
  const wantedKey = normalizeText(source.text);

  // Single UPDATE-FROM driven by the functional index on the
  // normalized expression (migration 002_list_items_indexes). The
  // expression here must stay byte-identical to the index's so the
  // planner picks it up, and must produce the same string as
  // `normalizeText()` in kernel/src/lists-bucketing.ts. Use
  // `[[:space:]]+` rather than `\s+`: a JS string literal collapses
  // `\s` to `s` and we'd accidentally strip every "s" character.
  await sql`
    UPDATE list_items
       SET checked = ${checked ? 1 : 0}
      FROM lists
     WHERE lists.id = list_items.list_id
       AND lists.group_id = ${source.groupId}
       AND LOWER(TRIM(REGEXP_REPLACE(list_items.text, '[[:space:]]+', ' ', 'g'))) = ${wantedKey}
  `.execute(db);

  const row = await db
    .selectFrom('list_items')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row ? rowToItem(row) : null;
}

/**
 * Rename a single item's text. Single-row update by design: the mobile
 * Lists view fans a rename out across a consolidated bucket item's
 * source rows itself (the same way it fans out delete/toggle), so we
 * don't reuse `setItemChecked`'s group-wide normalized-text SQL fanout —
 * a rename shouldn't silently rewrite same-named items in unrelated
 * lists. Returns the updated item, or null if it doesn't exist / the
 * trimmed text is empty.
 */
export async function setItemText(
  db: Kysely<DB>,
  itemId: string,
  text: string,
): Promise<ListItem | null> {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const existing = await db
    .selectFrom('list_items')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.text === trimmed) return rowToItem(existing);
  await db.updateTable('list_items').set({ text: trimmed }).where('id', '=', itemId).execute();
  return rowToItem({ ...existing, text: trimmed });
}

export async function deleteList(db: Kysely<DB>, listId: string): Promise<void> {
  await db.deleteFrom('lists').where('id', '=', listId).execute();
}

export async function deleteItem(db: Kysely<DB>, itemId: string): Promise<void> {
  await db.deleteFrom('list_items').where('id', '=', itemId).execute();
}

export async function getItem(db: Kysely<DB>, itemId: string): Promise<ListItem | null> {
  const row = await db
    .selectFrom('list_items')
    .selectAll()
    .where('id', '=', itemId)
    .executeTakeFirst();
  return row ? rowToItem(row) : null;
}

/**
 * Resolve a spoken list name against a group, creating the list only when
 * nothing matches. Reads and writes share `resolveListName`, so the list the
 * bot enumerates for "restaurants" is the list it appends to.
 *
 * Oldest-first, so two rows sharing a key (pre-migration-042 leftovers)
 * resolve to the original rather than to whichever fork was made last.
 *
 * `ambiguous` is not a failure: it means the name genuinely fits several
 * lists, and the caller should ask rather than mint a third one.
 */
export async function resolveOrCreateListByName(
  db: Kysely<DB>,
  groupId: string,
  name: string,
  createdBy: string | null,
): Promise<Exclude<ListNameResolution<List>, { status: 'none' }>> {
  const key = listNameKey(name);
  // ADR 0155 — take a transaction-scoped advisory lock on (group, name key)
  // so two concurrent turns resolving the same spoken name can't both miss
  // the SELECT and both INSERT a fork. `_xact_` releases on commit/rollback
  // and is the only advisory-lock form safe under transaction-mode pooling.
  // Two-int form rather than hashing `groupId || sep || key`: a NUL
  // separator is rejected in Postgres text (ADR 0126) and any printable
  // separator collides across the split.
  const run = async (
    trx: Kysely<DB>,
  ): Promise<Exclude<ListNameResolution<List>, { status: 'none' }>> => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(${groupId}), hashtext(${key}))`.execute(trx);
    const existing = await listListNames(trx, groupId);
    const resolved = resolveListName(existing, name);
    if (resolved.status === 'resolved') return resolved;
    if (resolved.status === 'ambiguous') return resolved;
    return {
      status: 'resolved',
      match: await createList(trx, { groupId, name, createdBy }),
    };
  };
  // Proposal confirm / bundle commit already hold a transaction — take the
  // lock on it (it releases with that outer transaction) rather than nesting.
  return db.isTransaction ? run(db) : db.transaction().execute(run);
}

/** The group's lists, oldest first, without the item join `listLists` pays for. */
export async function listListNames(db: Kysely<DB>, groupId: string): Promise<List[]> {
  const rows = await db
    .selectFrom('lists')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(rowToList);
}
