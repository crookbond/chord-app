import { sql, type Kysely, type Transaction } from 'kysely';

import { fullName } from '@chord/kernel';

import type { DB } from '../db/schema';
import { mapConcurrent } from '../utils/concurrency';
import { newId, newInviteCode, slugify } from '../utils/ids';
import { deleteAttachment } from './attachments.service';
import { ensurePersonaForMember } from './personas.service';

export interface CreateGroupInput {
  name: string;
  kind: 'group' | 'personal';
  createdBy: string;
  adultsOnly?: boolean;
  /** True when a PERSON typed this name (the create-group form). Service-side
   *  callers that mint a name themselves — pair groups, WhatsApp imports,
   *  connector chats — leave it false so a two-person chat can show the other
   *  member instead. */
  nameIsCustom?: boolean;
}

export interface GroupRow {
  id: string;
  name: string;
  kind: 'group' | 'personal';
  invite_code: string;
  ingest_email: string;
  created_by: string;
  created_at: string;
  adults_only: number;
  mirror_inbound: number;
}

export interface GroupListRow extends GroupRow {
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  last_read_at: string | null;
}

export async function createGroup(
  db: Kysely<DB>,
  input: CreateGroupInput,
): Promise<GroupRow> {
  const id = newId('g');
  const inviteCode = newInviteCode();
  const now = new Date().toISOString();
  const slug = slugify(input.name) || 'group';
  const ingestEmail = `${slug}-${id.slice(2, 8)}@chord.app`;

  await db
    .insertInto('groups')
    .values({
      id,
      name: input.name,
      kind: input.kind,
      invite_code: inviteCode,
      ingest_email: ingestEmail,
      created_by: input.createdBy,
      created_at: now,
      adults_only: input.adultsOnly ? 1 : 0,
      mirror_inbound: 0,
      name_is_custom: input.nameIsCustom ? 1 : 0,
    })
    .execute();

  await db
    .insertInto('group_members')
    .values({
      group_id: id,
      user_id: input.createdBy,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();

  // Family-profile roster (Phase 1): a shared group's members are personas.
  if (input.kind === 'group') {
    await ensurePersonaForMember(db, id, input.createdBy);
  }

  const row = await db
    .selectFrom('groups')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row;
}

/**
 * Rename a group. Returns the new name on success, or null when the group
 * doesn't exist or is a personal group (those carry a synthesized name —
 * see PERSONAL_GROUP_NAME — and shouldn't be renamed via the bot tool).
 */
export async function renameGroup(
  db: Kysely<DB>,
  groupId: string,
  newName: string,
): Promise<{ id: string; name: string; kind: 'group' | 'personal' } | null> {
  const trimmed = newName.trim();
  if (!trimmed) return null;
  const existing = await db
    .selectFrom('groups')
    .select(['id', 'name', 'kind'])
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (!existing) return null;
  if (existing.kind === 'personal') return null;
  if (existing.name === trimmed) return existing;
  // Renaming IS the act that makes a name deliberate — from here on this chat
  // shows what it was called, not who is in it.
  await db
    .updateTable('groups')
    .set({ name: trimmed, name_is_custom: 1 })
    .where('id', '=', groupId)
    .execute();
  return { id: existing.id, name: trimmed, kind: existing.kind };
}

/**
 * The other member's name, for each two-person chat nobody has named.
 *
 * Returned only for groups that should actually display it, so callers do not
 * re-derive the rule: shared (never personal), exactly two members, and
 * `name_is_custom = 0`. A rename or a name typed at creation wins, because
 * that is somebody saying what this chat is.
 *
 * Members are counted rather than trusting `pair_key`: a group can reach two
 * members by people leaving, and it reads the same way when it does.
 */
export async function counterpartNames(
  db: Kysely<DB>,
  userId: string,
  groups: Array<{ id: string; kind: string; name_is_custom?: number }>,
): Promise<Map<string, string>> {
  const candidates = groups
    .filter((g) => g.kind !== 'personal' && (g.name_is_custom ?? 0) === 0)
    .map((g) => g.id);
  const out = new Map<string, string>();
  if (candidates.length === 0) return out;

  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .select([
      'group_members.group_id as groupId',
      'users.id as userId',
      'users.username as username',
      'users.display_name as displayName',
      'users.first_name as firstName',
      'users.last_name as lastName',
    ])
    .where('group_members.group_id', 'in', candidates)
    .execute();

  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    const bucket = byGroup.get(r.groupId);
    if (bucket) bucket.push(r);
    else byGroup.set(r.groupId, [r]);
  }
  for (const [groupId, members] of byGroup) {
    if (members.length !== 2) continue;
    const other = members.find((m) => m.userId !== userId);
    if (!other) continue;
    out.set(
      groupId,
      fullName({
        username: other.username,
        displayName: other.displayName ?? undefined,
        firstName: other.firstName ?? undefined,
        lastName: other.lastName ?? undefined,
      }),
    );
  }
  return out;
}

/** Unread counts stop here; the chat list badge reads "99+" past 99. */
export const UNREAD_COUNT_CAP = 100;

export async function listGroupsForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<GroupListRow[]> {
  // The newest visible message (one lateral lookup gives its time and text)
  // and the unread count of visible messages from
  // other senders since this member's last_read_at. We use raw SQL because
  // Kysely's correlated subquery ergonomics are noisy and this query is
  // straightforward. The columns are computed once in a CTE so the ORDER BY can
  // sort on them by name instead of re-running the unread COUNT and MAX(created_at)
  // subqueries a second time (this is the hottest read — every app open).
  const rows = await sql<GroupListRow>`
    WITH group_rows AS (
      SELECT
        g.*,
        lm.created_at AS last_message_at,
        lm.body AS last_message_preview,
        -- Counted only up to UNREAD_COUNT_CAP: the badge shows "99+" past 99,
        -- and a chat never marked read would otherwise count its whole history
        -- on every app open.
        (SELECT COUNT(*) FROM (
          SELECT 1
           FROM messages m
           WHERE m.group_id = g.id
             AND m.chord_visible = 1
             AND (m.sender_id IS NULL OR m.sender_id != ${userId})
             AND (gm.last_read_at IS NULL OR m.created_at > gm.last_read_at)
             AND (gm.cleared_at IS NULL OR m.created_at > gm.cleared_at)
             AND NOT EXISTS (SELECT 1 FROM message_hides mh
                             WHERE mh.message_id = m.id AND mh.user_id = ${userId})
             AND NOT EXISTS (SELECT 1 FROM blocks bl
                             WHERE bl.blocker_user_id = ${userId} AND bl.blocked_user_id = m.sender_id)
           LIMIT ${UNREAD_COUNT_CAP}
        ) unread) AS unread_count,
        gm.last_read_at AS last_read_at
      FROM groups g
      INNER JOIN group_members gm ON gm.group_id = g.id
      -- The newest message this member can see: its time and its text.
      LEFT JOIN LATERAL (
        SELECT m.created_at, m.body
          FROM messages m
          WHERE m.group_id = g.id AND m.chord_visible = 1
            AND (gm.cleared_at IS NULL OR m.created_at > gm.cleared_at)
            AND NOT EXISTS (SELECT 1 FROM message_hides mh
                            WHERE mh.message_id = m.id AND mh.user_id = ${userId})
            AND NOT EXISTS (SELECT 1 FROM blocks bl
                            WHERE bl.blocker_user_id = ${userId} AND bl.blocked_user_id = m.sender_id)
          ORDER BY m.created_at DESC
          LIMIT 1
      ) lm ON true
      WHERE gm.user_id = ${userId}
    )
    SELECT * FROM group_rows
    ORDER BY
      CASE WHEN unread_count > 0 THEN 0 ELSE 1 END,
      COALESCE(last_message_at, created_at) DESC
  `.execute(db);
  return rows.rows;
}

export async function markGroupRead(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<string> {
  const lastReadAt = new Date().toISOString();
  await db
    .updateTable('group_members')
    .set({ last_read_at: lastReadAt })
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();
  return lastReadAt;
}

export async function setGroupMuted(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  await db
    .updateTable('group_members')
    .set({ muted: muted ? 1 : 0 })
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .execute();
}

export async function joinGroupByCode(
  db: Kysely<DB>,
  userId: string,
  inviteCode: string,
): Promise<GroupRow | null> {
  const normalized = inviteCode.trim().toUpperCase();
  const group = await db
    .selectFrom('groups')
    .selectAll()
    .where('invite_code', '=', normalized)
    .executeTakeFirst();
  if (!group) return null;
  if (group.kind === 'personal') return null;

  const existing = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', group.id)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (!existing) {
    const now = new Date().toISOString();
    await db
      .insertInto('group_members')
      .values({
        group_id: group.id,
        user_id: userId,
        role: 'member',
        tier: 'trusted',
        joined_at: now,
      })
      .execute();
    await ensurePersonaForMember(db, group.id, userId);
  }
  return group;
}

export async function isMember(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!row;
}

export async function getMemberRole(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<'owner' | 'member' | null> {
  const row = await db
    .selectFrom('group_members')
    .select('role')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return (row?.role as 'owner' | 'member' | undefined) ?? null;
}

/**
 * Drop a group and everything scoped to it. Group-scoped rows (messages,
 * tasks, lists, events, members, …) fall away via `group_id … ON DELETE
 * CASCADE`, but attachments use a polymorphic `scope_id` with no FK, so their
 * rows, FTS chunks, and on-disk files are removed explicitly first. Runs in
 * the caller's transaction so a failure rolls the whole teardown back.
 */
async function purgeGroup(trx: Kysely<DB>, groupId: string): Promise<number> {
  const atts = await trx
    .selectFrom('attachments')
    .select('id')
    .where('scope_kind', '=', 'group')
    .where('scope_id', '=', groupId)
    .execute();
  // Each attachment's chunk removal + row delete + disk unlink is independent
  // of every other attachment's, so bounded-concurrent instead of one at a
  // time (mapConcurrent pattern from gmail.service.ts's backfill).
  await mapConcurrent(atts, 8, (a) => deleteAttachment(trx, a.id));
  await trx.deleteFrom('groups').where('id', '=', groupId).execute();
  return atts.length;
}

export async function deleteGroup(
  db: Kysely<DB>,
  groupId: string,
): Promise<{ attachmentsDeleted: number }> {
  // A confirmed delete_group card commits inside confirmProposal's transaction.
  const attachmentsDeleted = db.isTransaction
    ? await purgeGroup(db, groupId)
    : await db.transaction().execute((trx) => purgeGroup(trx, groupId));
  return { attachmentsDeleted };
}

/**
 * Remove a member from a group. Three cases:
 *  - sole member leaving → the group is deleted outright (returns deleted=true);
 *  - the owner leaving a group with others → ownership auto-transfers to the
 *    earliest-joined remaining member, who is promoted to owner and recorded as
 *    `created_by` (returns the new owner id);
 *  - a non-owner leaving → just drops their membership.
 */
/**
 * Claim the current name as deliberate, because the group is about to become a
 * two-person chat and ADR 0101 would otherwise display the remaining member
 * instead. Losing a name silently is worse than keeping a dull one: a dull name
 * is visible and one rename away, a lost one is only noticed by accident.
 *
 * Pair groups are excluded — `ensurePairGroup` names them "Direct message", so
 * there is nothing there worth claiming. This is the one thing `pair_key`
 * genuinely answers: whether WE minted the name.
 */
async function keepNameOnShrink(
  db: Kysely<DB> | Transaction<DB>,
  groupId: string,
): Promise<void> {
  await db
    .updateTable('groups')
    .set({ name_is_custom: 1 })
    .where('id', '=', groupId)
    .where('name_is_custom', '=', 0)
    .where('pair_key', 'is', null)
    .execute();
}

export async function leaveGroup(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<{ deleted: boolean; newOwnerId?: string }> {
  // A confirmed leave_group card commits inside confirmProposal's transaction,
  // and Kysely refuses a nested one — reuse it instead.
  const inTransaction = <T>(run: (trx: Kysely<DB>) => Promise<T>) =>
    db.isTransaction ? run(db) : db.transaction().execute(run);
  return inTransaction(async (trx) => {
    const members = await trx
      .selectFrom('group_members')
      .select(['user_id', 'role', 'joined_at'])
      .where('group_id', '=', groupId)
      .orderBy('joined_at', 'asc')
      .execute();
    const me = members.find((m) => m.user_id === userId);
    if (!me) return { deleted: false };

    if (members.length <= 1) {
      await purgeGroup(trx, groupId);
      return { deleted: true };
    }

    await trx
      .deleteFrom('group_members')
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();

    // Three people becoming two would otherwise hand the chat's name over to
    // whoever is left (ADR 0101). A group that has been called something for a
    // while was called that on purpose, even if nobody re-typed it since, so
    // the name is claimed at the moment it would be lost.
    if (members.length === 3) await keepNameOnShrink(trx, groupId);

    if (me.role !== 'owner') return { deleted: false };

    // Oldest remaining member inherits ownership (members is joined_at asc).
    const next = members.find((m) => m.user_id !== userId);
    if (!next) return { deleted: false };
    await trx
      .updateTable('group_members')
      .set({ role: 'owner' })
      .where('group_id', '=', groupId)
      .where('user_id', '=', next.user_id)
      .execute();
    await trx
      .updateTable('groups')
      .set({ created_by: next.user_id })
      .where('id', '=', groupId)
      .execute();
    return { deleted: false, newOwnerId: next.user_id };
  });
}

export type GroupLifecycleRefusal = 'not_member' | 'not_owner' | 'not_found' | 'personal';

/**
 * Leave a chat as `userId`, with the rules the route, the Messages list and the bot all
 * share (ADR 0259): you must be in it, and your personal chat cannot be left.
 */
export async function leaveGroupAs(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<({ ok: true } & Awaited<ReturnType<typeof leaveGroup>>) | { ok: false; reason: GroupLifecycleRefusal }> {
  const [role, group] = await Promise.all([
    getMemberRole(db, groupId, userId),
    db.selectFrom('groups').select('kind').where('id', '=', groupId).executeTakeFirst(),
  ]);
  if (!role) return { ok: false, reason: 'not_member' };
  if (!group) return { ok: false, reason: 'not_found' };
  if (group.kind === 'personal') return { ok: false, reason: 'personal' };
  return { ok: true, ...(await leaveGroup(db, groupId, userId)) };
}

/** Delete a chat for everyone as `userId`: only its owner, and never a personal chat. */
export async function deleteGroupAs(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<{ ok: true; attachmentsDeleted: number } | { ok: false; reason: GroupLifecycleRefusal }> {
  const [role, group] = await Promise.all([
    getMemberRole(db, groupId, userId),
    db.selectFrom('groups').select('kind').where('id', '=', groupId).executeTakeFirst(),
  ]);
  if (!role) return { ok: false, reason: 'not_member' };
  if (role !== 'owner') return { ok: false, reason: 'not_owner' };
  if (!group) return { ok: false, reason: 'not_found' };
  if (group.kind === 'personal') return { ok: false, reason: 'personal' };
  return { ok: true, ...(await deleteGroup(db, groupId)) };
}

export async function regenerateInviteCode(
  db: Kysely<DB>,
  groupId: string,
): Promise<string> {
  const inviteCode = newInviteCode();
  await db
    .updateTable('groups')
    .set({ invite_code: inviteCode })
    .where('id', '=', groupId)
    .execute();
  return inviteCode;
}

const PERSONAL_GROUP_NAME = 'My Chord';

// Every table with a `group_id` FK to groups(id) EXCEPT events (handled
// separately for its `group_ids` JSONB) and group_members / connector
// channels (special-cased below for composite-key / alias collisions).
// Keep exhaustive over the schema's group_id FKs — a new group-scoped
// table must be added here or consolidation will strand its rows.
const GROUP_ID_TABLES = [
  'messages',
  'lists',
  'saves',
  'places',
  'contacts',
  'media_items',
  'memories',
  'tasks',
  'proactive_messages',
  'trips',
  'proposals',
  'document_permissions',
  'pending_connector_pairings',
  'forms',
  'skill_runs',
  // ADR 0301 — FK is ON DELETE SET NULL, so a merged pair chat's report
  // would otherwise lose the chat it was made in.
  'content_reports',
] as const;

// group_id-FK tables handled out-of-loop: events and event_series (group_ids JSONB),
// group_members (composite PK dedup), group_external_channels (alias
// collision), email_routing_rules (FK column is target_group_id, not
// group_id), personas (only ever created for kind='group' — a personal
// group never has one, so the consolidation CASCADE is a no-op),
// message_hides (ADR 0242 - only written for shared chats; a personal chat
// deletes its rows instead, so there is never one to move), chat_invites
// (ADR 0318 - only ever names a shared chat).
// Listed here so the drift-guard test can assert the union of
// these + GROUP_ID_TABLES equals the live FK set referencing groups(id).
const SPECIAL_GROUP_ID_TABLES = [
  'events',
  'event_series',
  'group_members',
  'group_external_channels',
  'email_routing_rules',
  'personas',
  'message_hides',
  'chat_invites',
] as const;

/**
 * Every table with a `group_id` FK to groups(id) that
 * `consolidatePersonalGroupInto` re-points. A drift-guard test
 * (`group-consolidation-coverage.test.ts`) asserts this exactly matches the
 * live schema's FK set — so adding a group-scoped table without teaching
 * consolidation about it fails CI rather than silently losing those rows to
 * the ON DELETE CASCADE when the emptied group is dropped. (attachments is
 * excluded — it has no FK, so it orphans rather than cascades, and is
 * re-pointed via its polymorphic scope.)
 */
export const ALL_GROUP_ID_FK_TABLES: readonly string[] = [
  ...GROUP_ID_TABLES,
  ...SPECIAL_GROUP_ID_TABLES,
];

/**
 * Fold one personal group entirely into another, then delete the emptied
 * source. Used when a connector-taster shadow (which had its own personal
 * group) merges into a user who ALREADY has a personal group — without
 * this the user ends up with two personal groups and their connector
 * binding, calendar, and data split across them (see ADR 0053 addendum).
 *
 * Moves every group-scoped row (messages, events incl. `group_ids` JSONB,
 * lists, attachments, connector bindings, …) from `fromGroupId` to
 * `toGroupId`, dedups membership, then drops the now-empty source. Must run
 * inside a transaction — a partial move would split the data worse than
 * leaving it. Scalar `group_id` FKs are all ON DELETE CASCADE, so the final
 * group delete cleans up anything intentionally left behind.
 */
export async function consolidatePersonalGroupInto(
  tx: Kysely<DB>,
  fromGroupId: string,
  toGroupId: string,
): Promise<void> {
  if (fromGroupId === toGroupId) return;

  // Membership: ensure every member of `from` is a member of `to` (the
  // source rows cascade away with the group delete below). Composite PK
  // (group_id, user_id) means a blind UPDATE would collide.
  const fromMembers = await tx
    .selectFrom('group_members')
    .selectAll()
    .where('group_id', '=', fromGroupId)
    .execute();
  if (fromMembers.length > 0) {
    // (group_id, user_id) is the composite PK, so ON CONFLICT DO NOTHING
    // replaces the per-member dupe-check-then-conditional-insert with one
    // batched insert (same pattern mergeTrips already uses for participants).
    await tx
      .insertInto('group_members')
      .values(
        fromMembers.map((m) => ({
          group_id: toGroupId,
          user_id: m.user_id,
          role: m.role,
          tier: m.tier,
          joined_at: m.joined_at,
          last_read_at: m.last_read_at,
          muted: m.muted,
        })),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  // Plain scalar group_id re-point.
  for (const table of GROUP_ID_TABLES) {
    await tx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .updateTable(table as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ group_id: toGroupId } as any)
      .where('group_id', '=', fromGroupId)
      .execute();
  }

  // Events: move the legacy scalar group_id AND rewrite the `group_ids`
  // JSONB visibility array (replace from→to, dedup). Empty arrays (personal
  // Google pulls) stay empty.
  await tx
    .updateTable('events')
    .set({ group_id: toGroupId })
    .where('group_id', '=', fromGroupId)
    .execute();
  await sql`
    UPDATE events
    SET group_ids = (
      SELECT COALESCE(
        jsonb_agg(DISTINCT CASE WHEN v = ${fromGroupId} THEN ${toGroupId} ELSE v END),
        '[]'::jsonb)
      FROM jsonb_array_elements_text(group_ids) AS v
    )
    WHERE group_ids ? ${fromGroupId}
  `.execute(tx);
  // ADR 0217 — a series carries the same two group columns as its occurrences.
  await tx
    .updateTable('event_series')
    .set({ group_id: toGroupId })
    .where('group_id', '=', fromGroupId)
    .execute();
  await sql`
    UPDATE event_series
    SET group_ids = (
      SELECT COALESCE(
        jsonb_agg(DISTINCT CASE WHEN v = ${fromGroupId} THEN ${toGroupId} ELSE v END),
        '[]'::jsonb)
      FROM jsonb_array_elements_text(group_ids) AS v
    )
    WHERE group_ids ? ${fromGroupId}
  `.execute(tx);

  // Email routing rules (ADR 0077) target a group via target_group_id; a
  // rule aimed at the folded group re-points rather than cascading away.
  // The (user, kind, pattern) unique key doesn't include the target, so a
  // blind update can't collide.
  await tx
    .updateTable('email_routing_rules')
    .set({ target_group_id: toGroupId })
    .where('target_group_id', '=', fromGroupId)
    .execute();

  // Connector bindings: (group_id, alias) is unique per group, so only move
  // a binding when `to` doesn't already hold that alias. (platform,
  // external_channel_id) stays globally unique — unaffected by the move.
  // One UPDATE with a NOT EXISTS guard replaces the per-binding
  // collide-check-then-conditional-update loop (same raw-SQL shape as the
  // group_ids JSONB rewrite just above).
  await sql`
    UPDATE group_external_channels g
    SET group_id = ${toGroupId}
    WHERE g.group_id = ${fromGroupId}
      AND NOT EXISTS (
        SELECT 1 FROM group_external_channels g2
        WHERE g2.group_id = ${toGroupId} AND g2.alias = g.alias
      )
  `.execute(tx);

  // Attachments scope on the polymorphic (scope_kind, scope_id) — no FK,
  // so it doesn't cascade and must be re-pointed explicitly.
  await tx
    .updateTable('attachments')
    .set({ scope_id: toGroupId })
    .where('scope_kind', '=', 'group')
    .where('scope_id', '=', fromGroupId)
    .execute();

  // Source group is now empty of moved content; delete it (CASCADE clears
  // any leftover group_members + rows of a table not listed above).
  await tx.deleteFrom('groups').where('id', '=', fromGroupId).execute();
}

export async function ensurePersonalGroup(
  db: Kysely<DB>,
  userId: string,
): Promise<GroupRow> {
  const existing = await db
    .selectFrom('groups')
    .selectAll()
    .where('kind', '=', 'personal')
    .where('created_by', '=', userId)
    // Deterministic: if two personal groups ever coexist (e.g. mid-merge),
    // always resolve to the oldest — the user's canonical one.
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
  if (existing) {
    // Self-heal the legacy "{displayName} · My Chord" naming. Clients
    // derive the displayed title from the user's preferred name; the
    // stored name only surfaces on bridges, where the bare label is right.
    if (existing.name !== PERSONAL_GROUP_NAME) {
      await db
        .updateTable('groups')
        .set({ name: PERSONAL_GROUP_NAME })
        .where('id', '=', existing.id)
        .execute();
      return { ...existing, name: PERSONAL_GROUP_NAME };
    }
    return existing;
  }

  return createGroup(db, {
    name: PERSONAL_GROUP_NAME,
    kind: 'personal',
    createdBy: userId,
  });
}

/**
 * ADR 0067 — find-or-create the 2-member shared group that hosts cross-user
 * messages/events between two users. Keyed by the sorted id pair, so the same
 * two users always resolve to one group regardless of who initiates. This is
 * how the flagship *creates* scope instead of crossing it (ADR 0032): both
 * users are members, so the group-scope scrubber is satisfied, not bypassed.
 */
export async function ensurePairGroup(
  db: Kysely<DB>,
  userA: string,
  userB: string,
): Promise<GroupRow> {
  if (userA === userB) throw new Error('ensurePairGroup requires two distinct users');
  const [lo, hi] = [userA, userB].sort();
  const pairKey = `${lo}|${hi}`;
  const existing = await db
    .selectFrom('groups')
    .selectAll()
    .where('pair_key', '=', pairKey)
    .executeTakeFirst();
  if (existing) return existing;

  // An ordinary shared group (kind='group'); the initiator is the creator.
  const group = await createGroup(db, { name: 'Direct message', kind: 'group', createdBy: userA });
  await db.updateTable('groups').set({ pair_key: pairKey }).where('id', '=', group.id).execute();
  await db
    .insertInto('group_members')
    .values({
      group_id: group.id,
      user_id: userB,
      role: 'member',
      tier: 'trusted',
      joined_at: new Date().toISOString(),
    })
    .execute();
  return group;
}
