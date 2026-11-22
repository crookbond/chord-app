/**
 * Backfill the family-profile fact columns onto existing `memories` rows
 * (migration `067_memories_subject_facts`). Extracted + idempotent so the
 * migration runner can call it without importing upward through the service
 * layer — same pattern as `seedGroupPersonas` / `mergeDuplicateLists`.
 *
 *   scope='persona' → subject_type='user',      subject_id=persona_id
 *   scope='group'   → subject_type='household',  subject_id=NULL
 *   scope='event'   → left NULL (out of the profile's scope in Phase 1)
 *
 * `category` is inferred from `key` via the shared kernel map. Only rows with
 * a NULL `subject_type` are touched, so a re-run is a no-op.
 */
import { sql, type Kysely } from 'kysely';

import { categoryForKey } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB } from './schema.js';

export async function classifyLegacyMemories(db: Kysely<DB>): Promise<void> {
  // Subject columns — set-based, cheap.
  await sql`
    UPDATE memories
       SET subject_type = 'user', subject_id = persona_id
     WHERE subject_type IS NULL AND scope = 'persona'
  `.execute(db);
  await sql`
    UPDATE memories
       SET subject_type = 'household'
     WHERE subject_type IS NULL AND scope = 'group'
  `.execute(db);

  // Category — per-row (the map lives in kernel). Bounded: the memory table
  // is small and this runs once.
  const rows = await db
    .selectFrom('memories')
    .select(['id', 'key'])
    .where('category', 'is', null)
    .execute();
  let n = 0;
  for (const r of rows) {
    await db
      .updateTable('memories')
      .set({ category: categoryForKey(r.key) })
      .where('id', '=', r.id)
      .execute();
    n += 1;
  }
  if (n > 0) logger.info(`classifyLegacyMemories: categorised ${n} memory row(s)`);
}
