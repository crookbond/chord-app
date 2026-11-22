/**
 * The contract half of the mail-encryption rollout (ADR 0201, phase 3): once
 * every row is sealed and indexed, drop the plaintext search columns and
 * rewrite the tables so the old plaintext is not left behind in dead tuples.
 *
 * Refuses to run while anything readable remains, and while the running code
 * still reads the legacy columns, because dropping a column a query names turns
 * every search into an error.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { countPlaintextMail } from './backfill-email.js';

export interface FinalizeResult {
  dropped: string[];
  vacuumed: boolean;
}

export class FinalizeRefused extends Error {}

export async function finalizeEmailEncryption(
  db: Kysely<DB>,
  opts: { vacuum?: boolean } = {},
): Promise<FinalizeResult> {
  if (env.CONTENT_LEGACY_TSV) {
    throw new FinalizeRefused(
      'CONTENT_LEGACY_TSV is still true. Set it to false on every instance (web and worker), restart, then run this again: the code must stop reading search_tsv before the column goes.',
    );
  }
  const remaining = await countPlaintextMail(db);
  if (remaining.total > 0) {
    throw new FinalizeRefused(
      `${remaining.total} value(s) are still readable in the database. Run the backfill first: ${JSON.stringify(remaining)}`,
    );
  }
  const dropped: string[] = [];
  for (const table of ['email_threads', 'email_messages'] as const) {
    await sql`ALTER TABLE ${sql.table(table)} DROP COLUMN IF EXISTS search_tsv`.execute(db);
    dropped.push(`${table}.search_tsv`);
  }
  let vacuumed = false;
  if (opts.vacuum) {
    // Cannot run inside a transaction; each statement is its own.
    for (const table of ['email_threads', 'email_messages']) {
      await sql`VACUUM (FULL, ANALYZE) ${sql.table(table)}`.execute(db);
    }
    vacuumed = true;
  }
  return { dropped, vacuumed };
}
