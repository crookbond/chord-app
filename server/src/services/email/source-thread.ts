/**
 * The email thread a to-do, save or trip item was read from. Mail-derived
 * rows carry `gmail:<threadId>` provenance (the provider id, account-prefixed
 * for attached mailboxes, ADR 0080); the reader is keyed on the local thread
 * row, which is per user. Trashed mail keeps its row (ADR 0215), so it still
 * resolves; only mail removed from the mirror does not.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';

export function gmailIdOfProvenance(raw: string | null | undefined): string | null {
  if (!raw?.startsWith('gmail:')) return null;
  const id = raw.slice('gmail:'.length).trim();
  return id || null;
}

export async function threadIdForProvenance(
  db: Kysely<DB>,
  userId: string,
  raw: string,
): Promise<string | null> {
  const gmailId = gmailIdOfProvenance(raw);
  if (!gmailId) return null;
  const row = await db
    .selectFrom('email_threads')
    .select('id')
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailId)
    .executeTakeFirst();
  return row?.id ?? null;
}
