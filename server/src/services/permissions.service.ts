import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

/**
 * True if the user can read the attachment.
 * Grants: uploaded_by = userId (cross-group owner), or the attachment is
 * scoped to a group the user is a member of (guests blocked in adults-only groups).
 */
export async function userCanRead(
  db: Kysely<DB>,
  attachmentId: string,
  userId: string,
): Promise<boolean> {
  const att = await db
    .selectFrom('attachments')
    .select(['uploaded_by', 'scope_kind', 'scope_id'])
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  if (!att) return false;
  if (att.uploaded_by === userId) return true;
  if (att.scope_kind !== 'group') return false;

  const membership = await db
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .select(['group_members.tier', 'groups.adults_only'])
    .where('group_members.group_id', '=', att.scope_id)
    .where('group_members.user_id', '=', userId)
    .executeTakeFirst();

  if (!membership) return false;
  if (membership.adults_only === 1 && membership.tier === 'guest') return false;
  return true;
}
