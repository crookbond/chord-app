/**
 * Fill `email_messages.has_attachments` for mail stored before the column
 * existed (migration 129). The part list is sealed, so this reads it through
 * the decrypting plugin a batch at a time after a sync, until none is left.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { attachmentFlag } from './content-seal.js';

const BATCH = 500;

export async function fillAttachmentFlags(db: Kysely<DB>, userId: string): Promise<number> {
  const rows = await db
    .selectFrom('email_messages')
    .select(['id', 'attachments_json'])
    .where('user_id', '=', userId)
    .where('has_attachments', 'is', null)
    .where('attachments_json', 'is not', null)
    .limit(BATCH)
    .execute();
  // One UPDATE per flag value, not per row: a backlog is 500 rows a batch.
  const byFlag = new Map<number, string[]>();
  for (const r of rows) {
    // An unreadable list (a destroyed key) is settled as 0, or it would be
    // picked up again on every sync.
    const flag = attachmentFlag(r.attachments_json === null ? null : JSON.stringify(r.attachments_json)) ?? 0;
    const ids = byFlag.get(flag) ?? [];
    ids.push(r.id);
    byFlag.set(flag, ids);
  }
  for (const [flag, ids] of byFlag) {
    await db.updateTable('email_messages').set({ has_attachments: flag }).where('id', 'in', ids).execute();
  }
  return rows.length;
}
