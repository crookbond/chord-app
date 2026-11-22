/**
 * ADR 0019 — Catchup folders service.
 *
 * Folders are per-user views over group-scoped entities. When an entity
 * is created in a group, we run the classifier once and fan the result
 * out to every group member as an assignment row. Each member's folder
 * set is independent (one user might have promoted "shopping" already,
 * another hasn't crossed the threshold yet).
 *
 * Seed folders (tasks/lists/trips/other) are created lazily on the
 * triggering user's first entity to avoid touching every user-creation
 * code path (session, OAuth, identity-resolver, fixtures).
 */
import type { Kysely } from 'kysely';

import type { CatchupFoldersTable, DB } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';

import {
  type ClassifierEntity,
  type EntityType,
  classifyEntity,
  defaultFolderForType,
} from './classifier.service.js';

interface SeedSpec {
  name: string;
  display: string;
}

const SEEDS: SeedSpec[] = [
  { name: 'tasks', display: 'Tasks' },
  { name: 'lists', display: 'Lists' },
  { name: 'trips', display: 'Trips' },
  { name: 'other', display: 'Other' },
];

export async function ensureSeedFolders(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  const existing = await db
    .selectFrom('catchup_folders')
    .select(['name'])
    .where('user_id', '=', userId)
    .where('kind', '=', 'seed')
    .execute();
  const have = new Set(existing.map((r) => r.name));
  const missing = SEEDS.filter((s) => !have.has(s.name));
  if (missing.length === 0) return;
  const now = new Date().toISOString();
  await db
    .insertInto('catchup_folders')
    .values(
      missing.map((s) => ({
        id: newId('cf'),
        user_id: userId,
        name: s.name,
        display: s.display,
        kind: 'seed' as const,
        pinned: 0,
        created_at: now,
      })),
    )
    .execute();
}

/**
 * Every folder for a set of users, grouped by user, creating any missing seed
 * folders on the way: ONE select, plus one insert only when a member is new. The
 * fan-out used to run a seed check and a full load as two selects over the same
 * rows.
 */
async function loadFoldersEnsuringSeeds(
  db: Kysely<DB>,
  userIds: string[],
): Promise<Map<string, CatchupFoldersTable[]>> {
  const byUser = new Map<string, CatchupFoldersTable[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .selectFrom('catchup_folders')
    .selectAll()
    .where('user_id', 'in', userIds)
    .execute();
  for (const r of rows) {
    const arr = byUser.get(r.user_id) ?? [];
    arr.push(r);
    byUser.set(r.user_id, arr);
  }
  const now = new Date().toISOString();
  const missing: CatchupFoldersTable[] = [];
  for (const userId of userIds) {
    const have = new Set(
      (byUser.get(userId) ?? []).filter((f) => f.kind === 'seed').map((f) => f.name),
    );
    for (const s of SEEDS) {
      if (have.has(s.name)) continue;
      missing.push({
        id: newId('cf'),
        user_id: userId,
        name: s.name,
        display: s.display,
        kind: 'seed',
        pinned: 0,
        created_at: now,
      });
    }
  }
  if (missing.length > 0) {
    // Two fan-outs for the same member can run at once (a member of several
    // groups, each just written to), and both see no seeds. (user_id, name) is
    // unique, so the loser's plain insert used to fail the whole assignment.
    // Insert-or-skip, then re-read if another writer got there first.
    const inserted = await db
      .insertInto('catchup_folders')
      .values(missing)
      .onConflict((oc) => oc.columns(['user_id', 'name']).doNothing())
      .returning('id')
      .execute();
    if (inserted.length === missing.length) {
      for (const f of missing) {
        const arr = byUser.get(f.user_id) ?? [];
        arr.push(f);
        byUser.set(f.user_id, arr);
      }
    } else {
      const fresh = await db
        .selectFrom('catchup_folders')
        .selectAll()
        .where('user_id', 'in', userIds)
        .execute();
      byUser.clear();
      for (const r of fresh) {
        const arr = byUser.get(r.user_id) ?? [];
        arr.push(r);
        byUser.set(r.user_id, arr);
      }
    }
  }
  return byUser;
}

async function findFolderByName(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<CatchupFoldersTable | undefined> {
  return db
    .selectFrom('catchup_folders')
    .selectAll()
    .where('user_id', '=', userId)
    .where('name', '=', name)
    .executeTakeFirst();
}

/**
 * Result of running the classifier on an entity for one user.
 * `promoted` is set when the assignment crossed the threshold and a new
 * derived folder was created on the spot.
 */
export interface AssignResult {
  folderId: string;
  folderName: string;
  promoted?: { id: string; name: string; display: string };
}

export async function assignEntityForUser(
  db: Kysely<DB>,
  userId: string,
  entityType: EntityType,
  entityId: string,
  classifier: ClassifierEntity,
  source: 'classifier' | 'manual' = 'classifier',
  opts?: { preloadedFolders?: CatchupFoldersTable[] },
): Promise<AssignResult> {
  // In a group fan-out the caller has already bulk-ensured seed folders and
  // bulk-loaded each member's folder set, so resolve from that snapshot instead
  // of a seed-check + per-name select per member (the per-write N+1).
  const preloaded = opts?.preloadedFolders;
  if (!preloaded) await ensureSeedFolders(db, userId);
  const findFolder = async (name: string): Promise<CatchupFoldersTable | undefined> =>
    preloaded ? preloaded.find((f) => f.name === name) : findFolderByName(db, userId, name);

  const suggested = classifyEntity(classifier);
  let folder: CatchupFoldersTable | undefined;
  let pendingName: string | null = null;
  let promoted: AssignResult['promoted'];

  if (suggested) {
    const existing = await findFolder(suggested);
    if (existing) {
      // If the suggestion matches an archived folder, re-promote it.
      if (existing.kind === 'archived') {
        await db
          .updateTable('catchup_folders')
          .set({ kind: 'derived' })
          .where('id', '=', existing.id)
          .execute();
        folder = { ...existing, kind: 'derived' };
      } else {
        folder = existing;
      }
    } else {
      // Not a known folder. Park in `other` with the suggested name as a
      // promotion candidate.
      const other = await findFolder('other');
      if (!other) throw new Error('seed `other` folder missing after ensureSeedFolders');
      folder = other;
      pendingName = suggested;
    }
  } else {
    const fallback = defaultFolderForType(entityType);
    const existing = await findFolder(fallback);
    if (!existing) throw new Error(`seed ${fallback} missing after ensureSeedFolders`);
    folder = existing;
  }
  if (!folder) throw new Error('folder unresolved');
  const resolvedFolder = folder;

  const now = new Date().toISOString();
  await db
    .insertInto('catchup_assignments')
    .values({
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      folder_id: resolvedFolder.id,
      source,
      pending_folder_name: pendingName,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'entity_type', 'entity_id']).doUpdateSet({
        folder_id: resolvedFolder.id,
        source,
        pending_folder_name: pendingName,
      }),
    )
    .execute();

  // Promotion check: when N items in `other` share the same pending name,
  // create a derived folder and reassign them all.
  if (pendingName) {
    const cluster = await db
      .selectFrom('catchup_assignments')
      .select(['entity_type', 'entity_id'])
      .where('user_id', '=', userId)
      .where('pending_folder_name', '=', pendingName)
      .where('source', '=', 'classifier')
      .execute();
    if (cluster.length >= env.CATCHUP_PROMOTION_THRESHOLD) {
      const newFolder = await promoteFolder(db, userId, pendingName);
      await db
        .updateTable('catchup_assignments')
        .set({ folder_id: newFolder.id, pending_folder_name: null })
        .where('user_id', '=', userId)
        .where('pending_folder_name', '=', pendingName)
        .execute();
      promoted = { id: newFolder.id, name: newFolder.name, display: newFolder.display };
    }
  }

  return {
    folderId: promoted?.id ?? resolvedFolder.id,
    folderName: promoted?.name ?? resolvedFolder.name,
    promoted,
  };
}

async function promoteFolder(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<CatchupFoldersTable> {
  const id = newId('cf');
  const display = name.charAt(0).toUpperCase() + name.slice(1);
  const row: CatchupFoldersTable = {
    id,
    user_id: userId,
    name,
    display,
    kind: 'derived',
    pinned: 0,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('catchup_folders').values(row).execute();
  logger.info('catchup folder promoted', { userId, name });
  return row;
}

/**
 * Fan-out: run the classifier once and assign for every group member who
 * can see the entity. Group entities are visible to all members; we don't
 * apply per-member adults-only or document_permissions filtering here
 * because tasks/lists/saves/trips are uniformly group-visible.
 */
export async function fanoutAssignment(
  db: Kysely<DB>,
  groupId: string,
  entityType: EntityType,
  entityId: string,
  classifier: ClassifierEntity,
): Promise<void> {
  const members = await db
    .selectFrom('group_members')
    .select(['user_id'])
    .where('group_id', '=', groupId)
    .execute();
  if (members.length === 0) return;

  // One folder query for the whole group (seeds created on the way), then the
  // members whose folder simply resolves are written in ONE insert. Only a
  // member that needs a side effect (an archived folder to revive, or a
  // suggested name that is not a folder yet and may tip a promotion) takes the
  // per-member path, so the result is identical to running assignEntityForUser
  // for everyone; a five-person group used to cost five sequential inserts.
  const memberIds = members.map((m) => m.user_id);
  const foldersByUser = await loadFoldersEnsuringSeeds(db, memberIds);
  const suggested = classifyEntity(classifier);
  const fallbackName = defaultFolderForType(entityType);
  const now = new Date().toISOString();

  const bulk: {
    user_id: string;
    entity_type: EntityType;
    entity_id: string;
    folder_id: string;
    source: 'classifier';
    pending_folder_name: null;
    created_at: string;
  }[] = [];
  const perMember: string[] = [];
  for (const m of members) {
    const folders = foldersByUser.get(m.user_id) ?? [];
    const target = folders.find((f) => f.name === (suggested ?? fallbackName));
    if (target && target.kind !== 'archived') {
      bulk.push({
        user_id: m.user_id,
        entity_type: entityType,
        entity_id: entityId,
        folder_id: target.id,
        source: 'classifier',
        pending_folder_name: null,
        created_at: now,
      });
    } else {
      perMember.push(m.user_id);
    }
  }

  if (bulk.length > 0) {
    try {
      await db
        .insertInto('catchup_assignments')
        .values(bulk)
        .onConflict((oc) =>
          oc.columns(['user_id', 'entity_type', 'entity_id']).doUpdateSet((eb) => ({
            folder_id: eb.ref('excluded.folder_id'),
            source: eb.ref('excluded.source'),
            pending_folder_name: eb.ref('excluded.pending_folder_name'),
          })),
        )
        .execute();
    } catch (err) {
      logger.warn('catchup bulk assignment failed', { err, groupId, entityType, entityId });
    }
  }

  for (const userId of perMember) {
    try {
      await assignEntityForUser(db, userId, entityType, entityId, classifier, 'classifier', {
        preloadedFolders: foldersByUser.get(userId) ?? [],
      });
    } catch (err) {
      logger.warn('catchup assignment failed', { err, userId, entityType, entityId });
    }
  }
}

export interface FolderSummary {
  id: string;
  name: string;
  display: string;
  kind: 'seed' | 'derived' | 'archived';
  pinned: boolean;
  /** Total non-archived assignments in this folder. */
  count: number;
}

export async function listFoldersForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<FolderSummary[]> {
  await ensureSeedFolders(db, userId);
  const folders = await db
    .selectFrom('catchup_folders')
    .selectAll()
    .where('user_id', '=', userId)
    .where('kind', '!=', 'archived')
    .execute();
  const counts = await db
    .selectFrom('catchup_assignments')
    .select(['folder_id'])
    .where('user_id', '=', userId)
    .execute();
  const byFolder = new Map<string, number>();
  for (const a of counts) byFolder.set(a.folder_id, (byFolder.get(a.folder_id) ?? 0) + 1);

  return folders
    .map((f) => ({
      id: f.id,
      name: f.name,
      display: f.display,
      kind: f.kind,
      pinned: f.pinned === 1,
      count: byFolder.get(f.id) ?? 0,
    }))
    .filter((f) => f.kind === 'seed' || f.count > 0)
    .sort((a, b) => {
      // Seeds first (in spec order), then derived alphabetically.
      const seedOrder = ['tasks', 'lists', 'trips', 'other'];
      const ai = seedOrder.indexOf(a.name);
      const bi = seedOrder.indexOf(b.name);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.display.localeCompare(b.display);
    });
}

/**
 * Move an entity to a different folder. Sets source='manual' so the
 * classifier can't overwrite it on a future update.
 */
export async function moveAssignment(
  db: Kysely<DB>,
  userId: string,
  entityType: EntityType,
  entityId: string,
  folderId: string,
): Promise<void> {
  const folder = await db
    .selectFrom('catchup_folders')
    .select(['id'])
    .where('id', '=', folderId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!folder) throw new Error('folder not found');
  const now = new Date().toISOString();
  await db
    .insertInto('catchup_assignments')
    .values({
      user_id: userId,
      entity_type: entityType,
      entity_id: entityId,
      folder_id: folderId,
      source: 'manual',
      pending_folder_name: null,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'entity_type', 'entity_id']).doUpdateSet({
        folder_id: folderId,
        source: 'manual',
        pending_folder_name: null,
      }),
    )
    .execute();
}

/**
 * List every entity in a given folder, grouped by type. Returns the bare
 * id list per type — callers hydrate via the existing `listAll*` services.
 */
export async function listFolderContents(
  db: Kysely<DB>,
  userId: string,
  folderId: string,
): Promise<{ tasks: string[]; lists: string[]; saves: string[]; trips: string[] }> {
  const rows = await db
    .selectFrom('catchup_assignments')
    .select(['entity_type', 'entity_id'])
    .where('user_id', '=', userId)
    .where('folder_id', '=', folderId)
    .execute();
  const out = { tasks: [] as string[], lists: [] as string[], saves: [] as string[], trips: [] as string[] };
  for (const r of rows) {
    if (r.entity_type === 'task') out.tasks.push(r.entity_id);
    else if (r.entity_type === 'list') out.lists.push(r.entity_id);
    else if (r.entity_type === 'save') out.saves.push(r.entity_id);
    else if (r.entity_type === 'trip') out.trips.push(r.entity_id);
  }
  return out;
}
