/**
 * Account deletion (ADR 0043).
 *
 * Erases a user and everything they solely own, while preserving the shared
 * groups they belong to. The data model wires many `REFERENCES users(id)`
 * columns *without* `ON DELETE CASCADE` (groups.created_by, attachments.
 * uploaded_by, people.owner_user_id, and the `created_by`/`assignee_id`
 * provenance columns), so a bare `DELETE FROM users` is rejected by the FK
 * layer. We therefore tear down in dependency order:
 *
 *   1. Reassign ownership of *shared* groups (and their files) to a remaining
 *      member, so the group survives the departing user.
 *   2. Delete the user's solo/personal groups — `group_id … ON DELETE CASCADE`
 *      sweeps all their content (messages, tasks, lists, events, …).
 *   3. Delete attachments the user solely owns (polymorphic scope, no group FK
 *      cascade) via the path-aware `deleteAttachment` helper.
 *   4. Anonymize the user's remaining footprint in *kept* groups by nulling the
 *      nullable provenance columns (ADR 0043 — "keep shared data, anonymize").
 *   5. Delete user-owned `people` (cascades `important_dates`).
 *   6. Delete trust/permission rows (no FK, but logically dangling).
 *   7. Delete the user row — the `ON DELETE CASCADE` / `SET NULL` columns
 *      (sessions, group_members, calendar_sources, external_identities,
 *      catchup_*, memories.persona_id, …) clean up the rest.
 *
 * Google and Apple authorizations are revoked at the provider (best-effort)
 * *before* the transaction; the stored tokens are dropped by step 7 regardless.
 * Microsoft has no revoke endpoint for an app's grant (ADR 0293): its identity
 * (`microsoft_sub`) and the mailbox's sealed refresh token go with the rows.
 */
import { sql, type Kysely } from 'kysely';

import { contentCrypto, hasContentCrypto } from '../db/crypto/index.js';
import type { DB } from '../db/schema.js';
import { logger } from '../config/logging.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { deleteAttachment } from './attachments.service.js';
import { deletePreloadedImages } from './email/image-preload.js';
import { env } from '../config/env.js';
import { revokeAppleTokens } from './apple/apple-auth.service.js';
import { revokeGoogleTokens } from './google/oauth.service.js';
import { recordSpentFreeAllowance } from './spent-free-allowance.service.js';
import { cancelSubscriptionNow, getSubscriptionState } from './stripe.service.js';

/** ADR 0342 — the Stripe plan could not be ended, so nothing was deleted:
 *  deleting anyway leaves the person billed every month for nothing. */
export class PlanNotCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanNotCancelledError';
  }
}

const ENDED_STRIPE_STATES = new Set(['canceled', 'incomplete_expired']);

/**
 * ADR 0342 — end the user's Stripe subscription now, before any deletion.
 * Returns whether one was ended. Throws PlanNotCancelledError when Stripe
 * cannot be asked or refuses; a subscription Stripe reports ended is fine.
 */
async function cancelStripePlan(db: Kysely<DB>, userId: string, fetchFn: typeof fetch): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('stripe_subscription_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  const subscriptionId = row?.stripe_subscription_id;
  if (!subscriptionId) return false;
  if (!env.STRIPE_SECRET_KEY) {
    throw new PlanNotCancelledError('Stripe is not configured on this server, so the plan cannot be cancelled');
  }
  const state = await getSubscriptionState(subscriptionId, fetchFn);
  if (state && ENDED_STRIPE_STATES.has(state.status)) return false;
  try {
    await cancelSubscriptionNow(subscriptionId, fetchFn);
  } catch (err) {
    throw new PlanNotCancelledError((err as Error).message);
  }
  return true;
}

/** Nullable `REFERENCES users(id)` provenance columns we anonymize in kept
 *  (shared) groups rather than delete. Rows in deleted solo groups are already
 *  gone via the group cascade, so these updates only touch shared-group rows. */
const ANONYMIZE: ReadonlyArray<[string, string]> = [
  ['messages', 'sender_id'],
  ['lists', 'created_by'],
  ['saves', 'created_by'],
  ['events', 'created_by'],
  ['events', 'owner_user_id'],
  ['events', 'organizer_user_id'],
  ['events', 'assignee_id'],
  ['rsvps', 'user_id'],
  ['places', 'created_by'],
  ['contacts', 'created_by'],
  ['media_items', 'created_by'],
  ['tasks', 'assignee_id'],
  ['tasks', 'created_by'],
  ['trips', 'created_by'],
  ['proposals', 'proposed_by_user_id'],
  ['proposals', 'resolved_by_user_id'],
  ['forms', 'created_by'],
  ['document_permissions', 'granted_by'],
  ['event_attendees', 'user_id'],
];

export interface DeleteAccountResult {
  groupsDeleted: number;
  groupsReassigned: number;
  attachmentsDeleted: number;
  googleRevoked: boolean;
  appleRevoked: boolean;
  sessionsDeleted: number;
  tasksDeleted: number;
  listsDeleted: number;
  savesDeleted: number;
  tasksAnonymized: number;
  listsAnonymized: number;
  savesAnonymized: number;
  peopleDeleted: number;
  /** ADR 0342 — a live Stripe plan was cancelled before the deletion. */
  stripePlanCancelled: boolean;
}

/** Count rows of a group-scoped table that live in the given groups. */
async function countInGroups(
  trx: Kysely<DB>,
  table: 'tasks' | 'lists' | 'saves',
  groupIds: string[],
): Promise<number> {
  if (groupIds.length === 0) return 0;
  const row = await trx
    .selectFrom(table)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('group_id', 'in', groupIds)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

export async function deleteAccount(
  db: Kysely<DB>,
  userId: string,
  fetchFn: typeof fetch = fetch,
): Promise<DeleteAccountResult> {
  const step = (msg: string, meta?: Record<string, unknown>) =>
    logger.info(`account-delete[${userId}] ${msg}`, meta);

  step('start');

  // ADR 0342 — first, so a plan that cannot be ended stops the deletion with
  // nothing removed yet. An App Store plan only the device can cancel; the
  // delete box tells them so.
  const stripePlanCancelled = await cancelStripePlan(db, userId, fetchFn);
  if (stripePlanCancelled) step('billing: stripe plan cancelled');

  // Best-effort, pre-transaction: tell Google to drop the grant. Never blocks
  // deletion — the token is wiped with the user row regardless.
  const googleRevoked = await revokeGoogleTokens(db, userId).catch(() => false);
  step(googleRevoked ? 'auth: google access revoked' : 'auth: no google token to revoke');
  // ADR 0156 — Apple requires apps offering Sign in with Apple to revoke on delete.
  const appleRevoked = await revokeAppleTokens(db, userId).catch(() => false);
  step(appleRevoked ? 'auth: apple access revoked' : 'auth: no apple token to revoke');
  step('auth: microsoft identity and outlook tokens forgotten with the account (no revoke endpoint)');

  // Groups that went with the user (only they were in them), captured so their
  // data keys can be destroyed after the deletion commits.
  let erasedGroupIds: string[] = [];

  const result = await db.transaction().execute(async (trx) => {
    // Every group the user belongs to, with its total member count and creator.
    const memberships = await trx
      .selectFrom('group_members as gm')
      .innerJoin('groups as g', 'g.id', 'gm.group_id')
      .select((eb) => [
        'g.id as groupId',
        'g.created_by as createdBy',
        'gm.role as role',
        eb
          .selectFrom('group_members as c')
          .select((e) => e.fn.countAll<number>().as('n'))
          .whereRef('c.group_id', '=', 'g.id')
          .as('memberCount'),
      ])
      .where('gm.user_id', '=', userId)
      .execute();

    const soloGroupIds: string[] = [];
    const sharedGroups: Array<{ groupId: string; createdBy: string; wasOwner: boolean }> = [];
    for (const m of memberships) {
      if (Number(m.memberCount) <= 1) {
        soloGroupIds.push(m.groupId);
      } else {
        sharedGroups.push({
          groupId: m.groupId,
          createdBy: m.createdBy,
          wasOwner: m.role === 'owner',
        });
      }
    }
    step('groups analyzed', { solo: soloGroupIds.length, shared: sharedGroups.length });
    erasedGroupIds = soloGroupIds;

    // Count the user's group-scoped content that the solo-group cascade will
    // remove, so the per-step log shows tasks/lists/saves actually deleted.
    const tasksDeleted = await countInGroups(trx, 'tasks', soloGroupIds);
    const listsDeleted = await countInGroups(trx, 'lists', soloGroupIds);
    const savesDeleted = await countInGroups(trx, 'saves', soloGroupIds);

    // 1. Reassign shared groups so they outlive this user. Pick the
    //    earliest-joined *other* member; promote them to owner if the
    //    departing user was the (or an) owner.
    let groupsReassigned = 0;
    const newOwnerByGroup = new Map<string, string>();
    for (const sg of sharedGroups) {
      const replacement = await trx
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', sg.groupId)
        .where('user_id', '!=', userId)
        .orderBy('joined_at', 'asc')
        .executeTakeFirst();
      if (!replacement) continue; // shouldn't happen (memberCount > 1)
      newOwnerByGroup.set(sg.groupId, replacement.user_id);

      if (sg.createdBy === userId) {
        await trx
          .updateTable('groups')
          .set({ created_by: replacement.user_id })
          .where('id', '=', sg.groupId)
          .execute();
        groupsReassigned += 1;
      }
      if (sg.wasOwner) {
        await trx
          .updateTable('group_members')
          .set({ role: 'owner' })
          .where('group_id', '=', sg.groupId)
          .where('user_id', '=', replacement.user_id)
          .execute();
      }
    }
    if (sharedGroups.length > 0) {
      step('shared groups reassigned to surviving members', { reassigned: groupsReassigned });
    }

    // 2. Keep the user's files in shared groups (others may rely on them) by
    //    reassigning uploaded_by — that column is NOT NULL, so it can't be
    //    anonymized to NULL like the provenance columns.
    for (const [groupId, newOwner] of newOwnerByGroup) {
      await trx
        .updateTable('attachments')
        .set({ uploaded_by: newOwner })
        .where('scope_kind', '=', 'group')
        .where('scope_id', '=', groupId)
        .where('uploaded_by', '=', userId)
        .execute();
    }

    // 3. Delete attachments the user solely owns: their personal (user-scoped)
    //    files plus everything in the solo groups we're about to drop. The
    //    group cascade does NOT reach attachments (polymorphic scope), so this
    //    is explicit. `deleteAttachment` handles FTS chunks + path-aware disk
    //    unlink.
    const owned = await trx
      .selectFrom('attachments')
      .select('id')
      .where((eb) =>
        eb.or([
          eb.and([eb('scope_kind', '=', 'user'), eb('scope_id', '=', userId)]),
          eb('uploaded_by', '=', userId),
        ]),
      )
      .execute();
    const idSet = new Set(owned.map((r) => r.id));
    if (soloGroupIds.length > 0) {
      const inSolo = await trx
        .selectFrom('attachments')
        .select('id')
        .where('scope_kind', '=', 'group')
        .where('scope_id', 'in', soloGroupIds)
        .execute();
      for (const r of inSolo) idSet.add(r.id);
    }
    const attachmentIds = [...idSet];
    // Each attachment's chunk removal + row delete + disk unlink is
    // independent of every other attachment's, so bounded-concurrent instead
    // of one at a time (mapConcurrent pattern from gmail.service.ts).
    await mapConcurrent(attachmentIds, 8, (id) => deleteAttachment(trx, id));
    if (attachmentIds.length > 0) step('attachments deleted', { count: attachmentIds.length });

    // 4. Delete solo/personal groups — cascades all their group-scoped content.
    if (soloGroupIds.length > 0) {
      await trx.deleteFrom('groups').where('id', 'in', soloGroupIds).execute();
      step('solo/personal groups deleted (cascaded content)', {
        groups: soloGroupIds.length,
        tasks: tasksDeleted,
        lists: listsDeleted,
        saves: savesDeleted,
      });
    }

    // 5. Anonymize the user's remaining footprint in the shared groups we kept.
    //    Capture per-table affected rows so the log shows what was anonymized.
    const anon: Record<string, number> = {};
    for (const [table, column] of ANONYMIZE) {
      const res = await sql`UPDATE ${sql.table(table)} SET ${sql.ref(column)} = NULL WHERE ${sql.ref(
        column,
      )} = ${userId}`.execute(trx);
      anon[`${table}.${column}`] = Number(res.numAffectedRows ?? 0n);
    }
    const tasksAnonymized = anon['tasks.created_by'] ?? 0;
    const listsAnonymized = anon['lists.created_by'] ?? 0;
    const savesAnonymized = anon['saves.created_by'] ?? 0;
    const totalAnonymized = Object.values(anon).reduce((a, b) => a + b, 0);
    if (totalAnonymized > 0) {
      step('authorship anonymized in shared groups', {
        total: totalAnonymized,
        tasks: tasksAnonymized,
        lists: listsAnonymized,
        saves: savesAnonymized,
      });
    }

    // 6. People are inherently personal (owner_user_id NOT NULL) — delete them;
    //    important_dates cascade off person_id.
    const peopleRes = await trx
      .deleteFrom('people')
      .where('owner_user_id', '=', userId)
      .executeTakeFirst();
    const peopleDeleted = Number(peopleRes?.numDeletedRows ?? 0n);
    if (peopleDeleted > 0) step('people deleted', { count: peopleDeleted });

    // 7. Trust + permission rows reference the user without a DB FK, so they'd
    //    otherwise linger pointing at a deleted account.
    await trx
      .deleteFrom('trusted_senders')
      .where((eb) =>
        eb.or([eb('recipient_user_id', '=', userId), eb('sender_user_id', '=', userId)]),
      )
      .execute();
    await trx
      .deleteFrom('permission_requests')
      .where((eb) =>
        eb.or([eb('recipient_user_id', '=', userId), eb('sender_user_id', '=', userId)]),
      )
      .execute();

    // 8. The user row — remaining CASCADE / SET NULL FKs (sessions,
    //    group_members, calendar_sources, external_identities, catchup_*,
    //    memories.persona_id, proactive_messages.persona_id, …) finish the job.
    //    Count sessions first so the log shows the logins being invalidated.
    const sessionsDeleted = Number(
      (
        await trx
          .selectFrom('sessions')
          .select((eb) => eb.fn.countAll<number>().as('n'))
          .where('user_id', '=', userId)
          .executeTakeFirst()
      )?.n ?? 0,
    );
    step('login: invalidating sessions', { sessions: sessionsDeleted });
    // ADR 0342 — read before the row goes: its identities keep the free
    // allowance spent for an account made with any of them again.
    const fingerprints = await recordSpentFreeAllowance(trx, userId);
    step('free allowance marked spent for its identities', { fingerprints });
    await trx.deleteFrom('users').where('id', '=', userId).execute();
    step('user row deleted');

    return {
      groupsDeleted: soloGroupIds.length,
      groupsReassigned,
      attachmentsDeleted: attachmentIds.length,
      sessionsDeleted,
      tasksDeleted,
      listsDeleted,
      savesDeleted,
      tasksAnonymized,
      listsAnonymized,
      savesAnonymized,
      peopleDeleted,
    };
  });

  // ADR 0225 — the stored email images. Their rows went with the user row;
  // the files are outside the database, so they are removed here.
  await deletePreloadedImages(userId).catch((err: unknown) => {
    logger.error('account-delete: could not remove stored email images', {
      userId,
      err: (err as Error).message,
    });
  });

  // ADR 0201 — destroy the keys their sealed data was under. Rows and files are
  // already gone; this is what makes any copy that survives (a restored dump,
  // a snapshot) unreadable from here on. Best-effort and after the commit: a
  // failure must not undo a deletion the user asked for. An older backup still
  // holds the wrapped key, so it stays readable until that backup expires.
  if (hasContentCrypto()) {
    const { store, keys } = contentCrypto();
    for (const owner of [userId, ...erasedGroupIds]) {
      await store.destroy(keys, owner).catch((err: unknown) => {
        logger.error('account-delete: could not destroy data key', { owner, err: (err as Error).message });
      });
    }
    step('data keys destroyed', { owners: 1 + erasedGroupIds.length });
  }

  logger.warn('account deleted', { userId, ...result, googleRevoked, appleRevoked, stripePlanCancelled });
  return { ...result, googleRevoked, appleRevoked, stripePlanCancelled };
}
