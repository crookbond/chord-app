/**
 * Backfill a `personas` row for every existing member of every shared
 * (`kind='group'`) group (family-profile Phase 1). Extracted + idempotent so
 * the migration runner can call it without importing upward through the
 * service layer — same pattern as `mergeDuplicateLists` / `hardenCalendarIdentity`.
 *
 * One persona per (group, account-member). Managed non-users are added later
 * through the API, not here.
 */
import type { Kysely } from 'kysely';

import { logger } from '../config/logging.js';
import { newId } from '../utils/ids.js';
import type { DB } from './schema.js';

export async function seedGroupPersonas(db: Kysely<DB>): Promise<void> {
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .leftJoin('personas', (join) =>
      join
        .onRef('personas.group_id', '=', 'group_members.group_id')
        .onRef('personas.member_user_id', '=', 'group_members.user_id'),
    )
    .where('groups.kind', '=', 'group')
    .where('personas.id', 'is', null)
    .select([
      'group_members.group_id as group_id',
      'group_members.user_id as user_id',
      'users.display_name as display_name',
      'users.username as username',
    ])
    .execute();

  if (rows.length === 0) return;

  const now = new Date().toISOString();
  await db
    .insertInto('personas')
    .values(
      rows.map((r) => ({
        id: newId('pers'),
        group_id: r.group_id,
        member_user_id: r.user_id,
        name: (r.display_name ?? r.username ?? 'Member').trim() || 'Member',
        household_role: 'other' as const,
        is_managed: 0,
        managed_by: null,
        birthdate: null,
        linked_person_id: null,
        created_at: now,
      })),
    )
    .execute();

  logger.info(`seedGroupPersonas: created ${rows.length} persona(s)`);
}
