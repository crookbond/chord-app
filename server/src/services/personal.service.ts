/**
 * Lightweight CRUD for the personal-chat primitives: places, contacts, media
 * items. Shape parallels the data-plane services; all three are group-scoped
 * so they also work in shared groups (flows don't forbid this).
 */
import type { Kysely } from 'kysely';

import type { Contact, MediaItem, Place } from '@chord/kernel';

import type {
  ContactsTable,
  DB,
  MediaItemsTable,
  PlacesTable,
} from '../db/schema.js';
import { newId } from '../utils/ids.js';

const parseTags = (s: string): string[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
};
const parseStrArr = parseTags;

function rowToPlace(row: PlacesTable): Place {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    area: row.area ?? undefined,
    city: row.city ?? undefined,
    tags: parseTags(row.tags),
    note: row.note ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function rowToContact(row: ContactsTable): Contact {
  return {
    id: row.id,
    groupId: row.group_id,
    name: row.name,
    org: row.org ?? undefined,
    education: row.education ? parseStrArr(row.education) : undefined,
    family: row.family ?? undefined,
    tags: parseTags(row.tags),
    note: row.note ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function rowToMedia(row: MediaItemsTable): MediaItem {
  return {
    id: row.id,
    groupId: row.group_id,
    kind: row.kind,
    title: row.title,
    note: row.note ?? undefined,
    done: row.done === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

// ── places ──────────────────────────────────────────────────────────

export async function listPlaces(db: Kysely<DB>, groupId: string): Promise<Place[]> {
  const rows = await db
    .selectFrom('places')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToPlace);
}

export async function createPlace(
  db: Kysely<DB>,
  input: {
    groupId: string;
    name: string;
    area?: string;
    city?: string;
    tags?: string[];
    note?: string;
    createdBy: string | null;
  },
): Promise<Place> {
  const id = newId('pl');
  const row: PlacesTable = {
    id,
    group_id: input.groupId,
    name: input.name,
    area: input.area ?? null,
    city: input.city ?? null,
    tags: JSON.stringify(input.tags ?? []),
    note: input.note ?? null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('places').values(row).execute();
  return rowToPlace(row);
}

// ── contacts ────────────────────────────────────────────────────────

export async function listContacts(db: Kysely<DB>, groupId: string): Promise<Contact[]> {
  const rows = await db
    .selectFrom('contacts')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToContact);
}

export async function createContact(
  db: Kysely<DB>,
  input: {
    groupId: string;
    name: string;
    org?: string;
    education?: string[];
    family?: string;
    tags?: string[];
    note?: string;
    createdBy: string | null;
  },
): Promise<Contact> {
  const id = newId('co');
  const row: ContactsTable = {
    id,
    group_id: input.groupId,
    name: input.name,
    org: input.org ?? null,
    education: input.education ? JSON.stringify(input.education) : null,
    family: input.family ?? null,
    tags: JSON.stringify(input.tags ?? []),
    note: input.note ?? null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('contacts').values(row).execute();
  return rowToContact(row);
}

// ── media ───────────────────────────────────────────────────────────

export async function listMedia(db: Kysely<DB>, groupId: string): Promise<MediaItem[]> {
  const rows = await db
    .selectFrom('media_items')
    .selectAll()
    .where('group_id', '=', groupId)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(rowToMedia);
}

export async function createMedia(
  db: Kysely<DB>,
  input: {
    groupId: string;
    kind: MediaItem['kind'];
    title: string;
    note?: string;
    createdBy: string | null;
  },
): Promise<MediaItem> {
  const id = newId('md');
  const row: MediaItemsTable = {
    id,
    group_id: input.groupId,
    kind: input.kind,
    title: input.title,
    note: input.note ?? null,
    done: 0,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('media_items').values(row).execute();
  return rowToMedia(row);
}

export async function getMediaItem(db: Kysely<DB>, id: string): Promise<MediaItem | null> {
  const row = await db.selectFrom('media_items').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToMedia(row) : null;
}

export async function setMediaDone(
  db: Kysely<DB>,
  id: string,
  done: boolean,
): Promise<MediaItem | null> {
  await db.updateTable('media_items').set({ done: done ? 1 : 0 }).where('id', '=', id).execute();
  const row = await db
    .selectFrom('media_items')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToMedia(row) : null;
}
