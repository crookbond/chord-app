/**
 * Seal the attachment files that predate content encryption (ADR 0201).
 *
 * Safe to stop and re-run: a file already sealed is skipped, and each file is
 * replaced by writing a sibling temp file and renaming it over the original, so
 * a crash leaves either the old plaintext or the new ciphertext and never half
 * of one. The sealed copy is opened again and compared before the rename, so a
 * file is never replaced by something that does not read back.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { contentCrypto, isSealedFile, openFile, sealFile } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';

export interface FileBackfillOptions {
  dryRun?: boolean;
  /** Rows read per query. */
  batch?: number;
  onProgress?: (p: FileBackfillResult) => void;
}

export interface FileBackfillResult {
  scanned: number;
  sealed: number;
  alreadySealed: number;
  missing: number;
  failed: number;
  bytes: number;
}

export async function sealExistingAttachments(
  db: Kysely<DB>,
  opts: FileBackfillOptions = {},
): Promise<FileBackfillResult> {
  const { store, raw } = contentCrypto();
  const batch = opts.batch ?? 200;
  const result: FileBackfillResult = { scanned: 0, sealed: 0, alreadySealed: 0, missing: 0, failed: 0, bytes: 0 };
  // Copies of a file into another group share one blob; each blob is sealed
  // once, under the owner of the row that created it.
  const seen = new Set<string>();
  let cursor = '';

  for (;;) {
    const rows = await db
      .selectFrom('attachments')
      .select(['id', 'path', 'scope_id'])
      .where('id', '>', cursor)
      .orderBy('id', 'asc')
      .limit(batch)
      .execute();
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      result.scanned++;
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      const full = path.join(env.DATA_DIR, row.path);
      try {
        const data = await fs.readFile(full);
        if (isSealedFile(data)) {
          result.alreadySealed++;
          continue;
        }
        if (!opts.dryRun) {
          const sealed = await sealFile(store, raw, row.scope_id, data);
          const check = await openFile(store, raw, sealed);
          if (!check.equals(data)) throw new Error('sealed copy did not read back identically');
          const tmp = `${full}.sealing`;
          await fs.writeFile(tmp, sealed);
          await fs.rename(tmp, full);
        }
        result.sealed++;
        result.bytes += data.length;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') result.missing++;
        else result.failed++;
      }
    }
    opts.onProgress?.({ ...result });
  }
  return result;
}
