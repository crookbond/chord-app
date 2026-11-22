/**
 * The contract half of phase 4 (ADR 0201): drop the plaintext tsvector on
 * attachment chunks once every chunk is sealed and indexed, and rewrite the
 * table so the old text is not left in dead tuples. Same refusals as the mail
 * finalize: not while the code still reads the column, not while anything
 * readable remains.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { countPlaintextDerived } from './backfill-derived.js';
import { FinalizeRefused } from './finalize-email.js';

export async function finalizeDerivedEncryption(
  db: Kysely<DB>,
  opts: { vacuum?: boolean } = {},
): Promise<{ dropped: string[]; vacuumed: boolean }> {
  if (env.CONTENT_LEGACY_TSV) {
    throw new FinalizeRefused(
      'CONTENT_LEGACY_TSV is still true. Set it to false on every instance (web and worker), restart, then run this again: the code must stop reading body_tsv before the column goes.',
    );
  }
  const remaining = await countPlaintextDerived(db);
  if (remaining.total > 0) {
    throw new FinalizeRefused(
      `${remaining.total} value(s) are still readable or unindexed. Run the backfill first: ${JSON.stringify(remaining.counts)}`,
    );
  }
  await sql`ALTER TABLE attachment_chunks DROP COLUMN IF EXISTS body_tsv`.execute(db);
  let vacuumed = false;
  if (opts.vacuum) {
    for (const table of ['attachment_chunks', 'attachments', 'proposals', 'email_drafts']) {
      await sql`VACUUM (FULL, ANALYZE) ${sql.table(table)}`.execute(db);
    }
    vacuumed = true;
  }
  return { dropped: ['attachment_chunks.body_tsv'], vacuumed };
}
