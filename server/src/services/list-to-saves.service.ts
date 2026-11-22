import type { Kysely } from 'kysely';

import {
  saveTagForListName,
  type MovableSaveKind,
  type MoveListToSavesResult,
  type Save,
} from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { createSaveWithDedup } from './saves.service.js';

const URL_ONLY = /^https?:\/\/\S+$/i;
const TITLE_MAX = 200;

/**
 * Turn every item of a list into a save in the list's own group, then delete
 * the list (ADR 0290).
 *
 * The server reads the list itself, so the move cannot stop partway the way
 * a model calling `save_place` once per remembered item did. The list is
 * deleted only after every item is saved, so a failure part-way leaves items
 * in both places, never in neither. Not one transaction: `createSaveWithDedup`
 * swallows a failed catch-up fan-out, which inside a transaction would abort
 * it. An item already saved in that group (same normalized title, or same
 * URL) is not duplicated, and still leaves the list.
 */
export async function moveListToSaves(
  db: Kysely<DB>,
  input: { listId: string; actorUserId: string | null; kind: MovableSaveKind },
): Promise<(MoveListToSavesResult & { created: Save[] }) | null> {
  const list = await db
    .selectFrom('lists')
    .selectAll()
    .where('id', '=', input.listId)
    .executeTakeFirst();
  if (!list) return null;
  const items = await db
    .selectFrom('list_items')
    .selectAll()
    .where('list_id', '=', list.id)
    .orderBy('created_at', 'asc')
    .execute();

  const tag = saveTagForListName(list.name);
  const saves: Save[] = [];
  const created: Save[] = [];
  let alreadySaved = 0;
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    const isUrl = URL_ONLY.test(text);
    const { save, created: isNew } = await createSaveWithDedup(db, {
      groupId: list.group_id,
      createdBy: input.actorUserId,
      kind: isUrl ? 'link' : input.kind,
      title: text.slice(0, TITLE_MAX),
      url: isUrl ? text : undefined,
      // A line longer than a title keeps its full text rather than losing
      // the tail on the way over.
      note: !isUrl && text.length > TITLE_MAX ? text : undefined,
      tags: tag ? [tag] : [],
    });
    saves.push(save);
    if (isNew) created.push(save);
    else alreadySaved++;
  }

  // Items cascade with the list.
  await db.deleteFrom('lists').where('id', '=', list.id).execute();

  return {
    listId: list.id,
    groupId: list.group_id,
    listName: list.name,
    moved: created.length,
    alreadySaved,
    tag,
    saves,
    created,
  };
}
