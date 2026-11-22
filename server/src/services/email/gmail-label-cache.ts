/**
 * The primary Gmail's label list, remembered for a few minutes.
 *
 * It was fetched from Gmail on every label-sheet open and on every
 * find-or-create of a `Chord/<category>` label, though a mailbox's labels
 * rarely change. Chord forgets its copy whenever it creates a label; a label
 * made or removed in Gmail itself shows here within the TTL. Keyed on the
 * database too, so two test databases never share a list.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import type { GmailApi, GmailLabel } from '../google/gmail-api.js';

const LABELS_TTL_MS = 5 * 60_000;
const MAX_USERS = 500;

const byDb = new WeakMap<object, Map<string, { at: number; labels: GmailLabel[] }>>();

export async function cachedGmailLabels(
  db: Kysely<DB>,
  userId: string,
  api: GmailApi,
): Promise<GmailLabel[]> {
  let byUser = byDb.get(db);
  if (!byUser) {
    byUser = new Map();
    byDb.set(db, byUser);
  }
  const hit = byUser.get(userId);
  if (hit && Date.now() - hit.at < LABELS_TTL_MS) return hit.labels;
  const labels = await api.listLabels();
  byUser.delete(userId);
  if (byUser.size >= MAX_USERS) {
    const oldest = byUser.keys().next().value;
    if (oldest !== undefined) byUser.delete(oldest);
  }
  byUser.set(userId, { at: Date.now(), labels });
  return labels;
}

/** Chord just created a label in this user's primary Gmail. */
export function forgetGmailLabels(db: Kysely<DB>, userId: string): void {
  byDb.get(db)?.delete(userId);
}
