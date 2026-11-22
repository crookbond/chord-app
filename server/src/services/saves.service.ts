import { sql, type Kysely } from 'kysely';

import type { CreateSaveRequest, Save } from '@chord/kernel';

import type { DB, SavesTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { loadDisplayNames } from '../utils/display-names.js';
import { fanoutAssignment } from './catchup/folders.service.js';
import { logger } from '../config/logging.js';

function rowToSave(row: SavesTable): Save {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    // ignore
  }
  return {
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    title: row.title,
    url: row.url ?? undefined,
    note: row.note ?? undefined,
    tags,
    tripLabel: row.trip_label ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
  };
}

async function enrichSavesWithCreatorNames(
  db: Kysely<DB>,
  rows: SavesTable[],
): Promise<Save[]> {
  if (rows.length === 0) return [];
  const names = await loadDisplayNames(db, rows.map((r) => r.created_by));
  return rows.map((r) => ({
    ...rowToSave(r),
    createdByName: r.created_by ? names.get(r.created_by) : undefined,
  }));
}

export async function listSaves(
  db: Kysely<DB>,
  groupId: string,
  opts?: { tripLabel?: string; withNames?: boolean; limit?: number },
): Promise<Save[]> {
  let q = db
    .selectFrom('saves')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc');
  if (opts?.tripLabel) q = q.where('trip_label', '=', opts.tripLabel);
  // Unbounded over a group's lifetime otherwise; see tasks.service.ts's
  // listTasks for the same reasoning. 200 is generous for any normal family
  // group.
  const rows = await q.limit(opts?.limit ?? 200).execute();
  // Callers that only read titles/tags (e.g. the bot's group snapshot) pass
  // withNames:false to skip the per-creator display-name lookup.
  if (opts?.withNames === false) return rows.map(rowToSave);
  return enrichSavesWithCreatorNames(db, rows);
}

export async function listSavesForUser(
  db: Kysely<DB>,
  userId: string,
  opts?: { withNames?: boolean; limit?: number; before?: string },
): Promise<Save[]> {
  const rows = await db
    .selectFrom('saves')
    .innerJoin('group_members', 'group_members.group_id', 'saves.group_id')
    .where('group_members.user_id', '=', userId)
    .selectAll('saves')
    .$if(opts?.before !== undefined, (q) => q.where('saves.created_at', '<', opts!.before!))
    .orderBy('saves.created_at', 'desc')
    .$if(opts?.limit !== undefined, (q) => q.limit(opts!.limit!))
    .execute();
  if (opts?.withNames === false) return rows.map(rowToSave);
  return enrichSavesWithCreatorNames(db, rows);
}

/**
 * Direct-SQL search for `search_saves`/`search`'s saves category — matches
 * `search_tsv` (ADR 0085's FTS arm) OR a literal substring across
 * title/note/url/tags, scoped by group_id or cross-group membership, in ONE
 * query. Not `listSaves(db, groupId)`'s 200-row `created_at DESC` page (the
 * cross-group `listSavesForUser` has no such cap, but the in-group one did):
 * a match ranked past that page was silently invisible however well FTS
 * found it, since the old code intersected FTS ids against that capped page
 * rather than scoping the query itself. See `findEventsByTitle`'s doc
 * comment (events.service.ts) for the same root-cause class of bug.
 */
export async function searchSavesScoped(
  db: Kysely<DB>,
  scope: { groupId: string } | { crossGroupUserId: string },
  opts: { tsq: string | null; qLike: string; tripLabel?: string; cap: number },
): Promise<Save[]> {
  const matched =
    'groupId' in scope
      ? await db
          .selectFrom('saves')
          .selectAll()
          .where('group_id', '=', scope.groupId)
          .$if(!!opts.tripLabel, (qb) => qb.where('trip_label', '=', opts.tripLabel!))
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(title) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(note,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(url,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(tags) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .orderBy('created_at', 'desc')
          .limit(opts.cap)
          .execute()
      : await db
          .selectFrom('saves')
          .innerJoin('group_members', 'group_members.group_id', 'saves.group_id')
          .where('group_members.user_id', '=', scope.crossGroupUserId)
          .$if(!!opts.tripLabel, (qb) => qb.where('saves.trip_label', '=', opts.tripLabel!))
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`saves.search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(saves.title) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(saves.note,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(saves.url,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(saves.tags) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .selectAll('saves')
          .orderBy('saves.created_at', 'desc')
          .limit(opts.cap)
          .execute();
  return enrichSavesWithCreatorNames(db, matched);
}

export interface CreateSaveInput extends CreateSaveRequest {
  groupId: string;
  createdBy: string | null;
  sourceRawContext?: string | null;
}

export interface CreateSaveResult {
  save: Save;
  created: boolean;
}

/**
 * Normalize a URL for dedup-equality. Drops protocol, www., trailing
 * slash, hash, and tracking query params (utm_*, fbclid, gclid). The
 * result is *not* a valid URL — it's a comparison key only.
 */
function urlDedupKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    const drop: string[] = [];
    u.searchParams.forEach((_, k) => {
      const lk = k.toLowerCase();
      if (lk.startsWith('utm_') || lk === 'fbclid' || lk === 'gclid' || lk === 'mc_eid' || lk === 'mc_cid') {
        drop.push(k);
      }
    });
    for (const k of drop) u.searchParams.delete(k);
    const host = u.host.replace(/^www\./, '').toLowerCase();
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    const qs = u.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

function titleDedupKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Look up an existing save in the same group that the new input would
 * duplicate. Returns null when there's no match (fresh save).
 *
 * Match rules:
 *   - kind=link: matching normalized URL
 *   - kind=place, media, contact: matching normalized title (case
 *     and whitespace insensitive)
 *   - kind=note: no dedup — notes are intentionally free-form
 */
async function findDuplicate(
  db: Kysely<DB>,
  input: CreateSaveInput,
): Promise<SavesTable | null> {
  if (input.kind === 'note') return null;
  // Bounded, not a real index lookup: the URL/title normalizers below have no
  // SQL-side equivalent (ADR 0094 rejected porting a JS normalizer into
  // Postgres — "the drift trap"), so this still matches in JS. Ordering
  // newest-first and capping at 500 keeps a years-old group's save pile from
  // being loaded whole on every save; 500 saves of one kind in a group is far
  // beyond any real family group, so this doesn't change dedup behavior
  // today. A from-scratch SQL-side exact-match design (an ADR 0094-style
  // canonical key for save URLs/titles) would remove the cap entirely, but
  // needs its own ADR + migration.
  const rows = await db
    .selectFrom('saves')
    .selectAll()
    .where('group_id', '=', input.groupId)
    .where('kind', '=', input.kind)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
  if (input.kind === 'link' && input.url) {
    const key = urlDedupKey(input.url);
    return rows.find((r) => r.url && urlDedupKey(r.url) === key) ?? null;
  }
  const tkey = titleDedupKey(input.title);
  return rows.find((r) => titleDedupKey(r.title) === tkey) ?? null;
}

export async function createSave(db: Kysely<DB>, input: CreateSaveInput): Promise<Save> {
  const result = await createSaveWithDedup(db, input);
  return result.save;
}

/**
 * Like `createSave` but returns `{save, created}` so callers (bot
 * tools, route handlers) can tell the user "already saved" instead of
 * silently double-inserting.
 */
export async function createSaveWithDedup(
  db: Kysely<DB>,
  input: CreateSaveInput,
): Promise<CreateSaveResult> {
  const existing = await findDuplicate(db, input);
  if (existing) {
    // A repeat save is how a category arrives after the fact ("yes, under
    // places to eat") and how a moved list labels a place that was already
    // saved (ADR 0290), so its new tags join the existing ones.
    const current = rowToSave(existing);
    const known = new Set(current.tags.map((t) => t.trim().toLowerCase()));
    const added = (input.tags ?? []).filter((t) => {
      const k = t.trim().toLowerCase();
      if (!k || known.has(k)) return false;
      known.add(k);
      return true;
    });
    if (added.length === 0) return { save: current, created: false };
    const tags = [...current.tags, ...added].slice(0, 20);
    await db
      .updateTable('saves')
      .set({ tags: JSON.stringify(tags) })
      .where('id', '=', existing.id)
      .execute();
    return { save: { ...current, tags }, created: false };
  }
  const id = newId('s');
  const row: SavesTable = {
    id,
    group_id: input.groupId,
    kind: input.kind,
    title: input.title,
    url: input.url ?? null,
    note: input.note ?? null,
    tags: JSON.stringify(input.tags ?? []),
    trip_label: input.tripLabel ?? null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    source_raw_context: input.sourceRawContext ?? null,
  };
  await db.insertInto('saves').values(row).execute();
  await fanoutAssignment(db, input.groupId, 'save', id, {
    type: 'save',
    primary: input.title,
    secondary: [input.url ?? '', input.note ?? '', ...(input.tags ?? [])].join(' '),
  }).catch((err) => logger.warn('catchup fanout (save) failed', { err }));
  return { save: rowToSave(row), created: true };
}

export async function getSave(db: Kysely<DB>, id: string): Promise<Save | null> {
  const row = await db
    .selectFrom('saves')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToSave(row) : null;
}

export async function deleteSave(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('saves').where('id', '=', id).execute();
}

export interface UpdateSaveInput {
  title?: string;
  url?: string;
  note?: string;
  tags?: string[];
  tripLabel?: string;
}

export async function updateSave(
  db: Kysely<DB>,
  id: string,
  patch: UpdateSaveInput,
): Promise<Save | null> {
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title.trim();
  if (patch.url !== undefined) set.url = patch.url || null;
  if (patch.note !== undefined) set.note = patch.note || null;
  if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
  if (patch.tripLabel !== undefined) set.trip_label = patch.tripLabel || null;
  if (Object.keys(set).length === 0) {
    const row = await db
      .selectFrom('saves')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToSave(row) : null;
  }
  await db.updateTable('saves').set(set).where('id', '=', id).execute();
  const row = await db
    .selectFrom('saves')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToSave(row) : null;
}
