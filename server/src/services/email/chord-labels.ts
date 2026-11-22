/**
 * ADR 0141 — local Chord labels on `email_threads.chord_label_ids`.
 *
 * Never touches the provider. `recomputeThread` never touches this column
 * either (it owns `gmail_label_ids`). Identity is the display name; apply /
 * remove dedupe with `listNameKey` (ADR 0094).
 */
import { listNameKey } from '@chord/kernel';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

export function mergeChordLabels(
  current: string[],
  add: string[] | undefined,
  remove: string[] | undefined,
): string[] {
  let out = Array.isArray(current) ? [...current] : [];
  for (const raw of remove ?? []) {
    const key = listNameKey(raw);
    if (!key) continue;
    out = out.filter((x) => listNameKey(x) !== key);
  }
  for (const raw of add ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = listNameKey(trimmed);
    if (!key) continue;
    if (out.some((x) => listNameKey(x) === key)) continue;
    out.push(trimmed);
  }
  return out;
}

export function chordLabelPatchRequested(patch: {
  addChordLabels?: string[];
  removeChordLabels?: string[];
}): boolean {
  return (patch.addChordLabels?.length ?? 0) > 0 || (patch.removeChordLabels?.length ?? 0) > 0;
}

/** True when the patch needs a provider write (not merely Chord labels). */
export function providerModifyRequested(patch: {
  markRead?: boolean;
  archive?: boolean;
  trash?: boolean;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  applyCategoryLabel?: boolean;
}): boolean {
  return (
    patch.markRead !== undefined ||
    patch.archive !== undefined ||
    patch.trash === true ||
    patch.applyCategoryLabel === true ||
    (patch.addLabelIds?.length ?? 0) > 0 ||
    (patch.removeLabelIds?.length ?? 0) > 0
  );
}

/**
 * Apply Chord label adds/removes on one thread. Returns whether the row
 * changed. Missing / wrong-user threads return false.
 */
export async function applyChordLabelPatch(
  db: Kysely<DB>,
  userId: string,
  threadRowId: string,
  patch: { addChordLabels?: string[]; removeChordLabels?: string[] },
): Promise<boolean> {
  if (!chordLabelPatchRequested(patch)) return false;
  const row = await db
    .selectFrom('email_threads')
    .select(['id', 'chord_label_ids'])
    .where('id', '=', threadRowId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!row) return false;
  const current = Array.isArray(row.chord_label_ids) ? row.chord_label_ids : [];
  const next = mergeChordLabels(current, patch.addChordLabels, patch.removeChordLabels);
  if (
    next.length === current.length &&
    next.every((v, i) => v === current[i])
  ) {
    return false;
  }
  await db
    .updateTable('email_threads')
    .set({
      // No updated_at: that re-queues the thread for classification, and a
      // label the user chose is not new content (ADR 0141).
      chord_label_ids: JSON.stringify(next),
    })
    .where('id', '=', row.id)
    .execute();
  return true;
}
