/**
 * ADR 0156 addendum — folding an Apple-only account into the Google account a
 * consent re-pointed its session to. The Google connect is the proof: the same
 * session just authenticated as both, the bar the Apple-identity move already
 * rests on. Everything the Apple row holds follows the person, except the row
 * itself, which stays behind empty (its login identities are gone, and deleting
 * a real user row means ADR 0043's teardown list).
 *
 * ADR 0293 addendum — a Microsoft-only account (Sign in with Microsoft) folds
 * the same way on the same proof; its mailboxes follow separately, after the
 * transaction (`moveMailboxesTo`).
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { reattributeUserFkColumns } from '../connectors/pairing.service.js';
import { consolidatePersonalGroupInto } from '../groups.service.js';
import { rescheduleDailyScanForUser } from '../proactive.service.js';
import { moveMicrosoftIdentityIn } from '../microsoft/microsoft-auth.service.js';
import { APPLE_FALLBACK_NAME, moveAppleIdentityIn } from './apple-auth.service.js';

export interface FoldResult {
  folded: boolean;
  /** What happened to the Apple row's number: it moved, or the Google row kept its own. */
  phone?: 'moved' | 'kept_existing';
}

/**
 * All-or-nothing, and a no-op unless an Apple or Microsoft login actually
 * moved (the Google row may already hold a different one of each — then
 * nothing is claimed).
 */
export async function foldSignInAccountInto(
  db: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<FoldResult> {
  if (fromUserId === toUserId) return { folded: false };
  return db.transaction().execute(async (trx) => {
    const apple = await moveAppleIdentityIn(trx, fromUserId, toUserId);
    const microsoft = await moveMicrosoftIdentityIn(trx, fromUserId, toUserId);
    if (!apple && !microsoft) return { folded: false };
    await fillProfileBlanks(trx, fromUserId, toUserId);
    const phone = await carryPhone(trx, fromUserId, toUserId);
    await trx.updateTable('push_tokens').set({ user_id: toUserId }).where('user_id', '=', fromUserId).execute();
    await trx
      .updateTable('external_identities')
      .set({ user_id: toUserId })
      .where('user_id', '=', fromUserId)
      .execute();
    const groups = await foldGroups(trx, fromUserId, toUserId);
    // Every group the Apple row was in is now one the Google row is in, so
    // what it authored can follow globally.
    await trx.updateTable('messages').set({ sender_id: toUserId }).where('sender_id', '=', fromUserId).execute();
    await dropDuplicateEventCopies(trx, fromUserId, toUserId);
    await reattributeUserFkColumns(trx, fromUserId, toUserId);
    await trx.updateTable('personas').set({ managed_by: toUserId }).where('managed_by', '=', fromUserId).execute();
    await moveContactLinks(trx, fromUserId, toUserId);
    // The Apple row's briefing was re-attributed above; collapse to one.
    await rescheduleDailyScanForUser(trx, toUserId);
    logger.info('sign-in account folded into google account', {
      from: fromUserId,
      to: toUserId,
      logins: [apple && 'apple', microsoft && 'microsoft'].filter(Boolean),
      groups,
      phone: phone ?? 'none',
    });
    return { folded: true, ...(phone ? { phone } : {}) };
  });
}

async function fillProfileBlanks(trx: Kysely<DB>, fromUserId: string, toUserId: string): Promise<void> {
  const cols = ['display_name', 'first_name', 'last_name', 'preferred_name', 'last_tz'] as const;
  const [from, to] = await Promise.all([
    trx.selectFrom('users').select(cols).where('id', '=', fromUserId).executeTakeFirstOrThrow(),
    trx.selectFrom('users').select(cols).where('id', '=', toUserId).executeTakeFirstOrThrow(),
  ]);
  const fromDisplay = from.display_name === APPLE_FALLBACK_NAME ? null : from.display_name;
  await trx
    .updateTable('users')
    .set({
      display_name: to.display_name ?? fromDisplay,
      first_name: to.first_name ?? from.first_name ?? null,
      last_name: to.last_name ?? from.last_name ?? null,
      preferred_name: to.preferred_name ?? from.preferred_name ?? null,
      last_tz: to.last_tz ?? from.last_tz ?? null,
    })
    .where('id', '=', toUserId)
    .execute();
}

/**
 * A verified number keeps its verification: the person who proved it is the
 * person the Google account belongs to. A user row holds one number, so when
 * the Google row already has its own, that one stays — and the Apple row's
 * is released rather than left verified on an account nobody can sign in to,
 * where contact discovery (ADR 0065) would keep resolving people to it.
 */
async function carryPhone(
  trx: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<FoldResult['phone']> {
  const cols = ['phone_number', 'phone_hash', 'phone_verified'] as const;
  const [from, to] = await Promise.all([
    trx.selectFrom('users').select(cols).where('id', '=', fromUserId).executeTakeFirstOrThrow(),
    trx.selectFrom('users').select(cols).where('id', '=', toUserId).executeTakeFirstOrThrow(),
  ]);
  if (!from.phone_number) return undefined;
  // Clear first: phone_number is partial-unique.
  await trx
    .updateTable('users')
    .set({ phone_number: null, phone_hash: null, phone_verified: 0 })
    .where('id', '=', fromUserId)
    .execute();
  if (to.phone_number) return 'kept_existing';
  await trx
    .updateTable('users')
    .set({
      phone_number: from.phone_number,
      phone_hash: from.phone_hash ?? null,
      phone_verified: from.phone_verified,
    })
    .where('id', '=', toUserId)
    .execute();
  return 'moved';
}

/**
 * Re-home every group the Apple row belongs to. Two kinds fold INTO a group
 * the Google row already has, rather than moving alongside it: the personal
 * group (one per user) and a pair group (ADR 0067) with a person the Google
 * row already has a pair with. Everything else moves its membership across.
 */
async function foldGroups(trx: Kysely<DB>, fromUserId: string, toUserId: string): Promise<number> {
  const memberships = await trx
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .selectAll('group_members')
    .select(['groups.kind', 'groups.pair_key', 'groups.created_by'])
    .where('group_members.user_id', '=', fromUserId)
    .execute();
  const targetPersonal = await trx
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', toUserId)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();

  for (const m of memberships) {
    let into: string | null = null;
    if (m.kind === 'personal') {
      into = targetPersonal?.id ?? null;
    } else if (m.pair_key) {
      const other = m.pair_key.split('|').find((id) => id !== fromUserId);
      if (!other || other === toUserId) continue;
      const pairKey = [toUserId, other].sort().join('|');
      const existing = await trx
        .selectFrom('groups')
        .select('id')
        .where('pair_key', '=', pairKey)
        .executeTakeFirst();
      if (existing) into = existing.id;
      else await trx.updateTable('groups').set({ pair_key: pairKey }).where('id', '=', m.group_id).execute();
    }

    if (into) {
      await consolidatePersonalGroupInto(trx, m.group_id, into);
      // Consolidation carries every member across, the Apple row included.
      await trx
        .deleteFrom('group_members')
        .where('group_id', '=', into)
        .where('user_id', '=', fromUserId)
        .execute();
      continue;
    }

    const already = await trx
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', m.group_id)
      .where('user_id', '=', toUserId)
      .executeTakeFirst();
    if (!already) {
      await trx
        .insertInto('group_members')
        .values({
          group_id: m.group_id,
          user_id: toUserId,
          role: m.role,
          tier: m.tier,
          joined_at: m.joined_at,
          last_read_at: m.last_read_at,
          muted: m.muted,
        })
        .execute();
    }
    await trx
      .deleteFrom('group_members')
      .where('group_id', '=', m.group_id)
      .where('user_id', '=', fromUserId)
      .execute();
    if (m.created_by === fromUserId) {
      await trx.updateTable('groups').set({ created_by: toUserId }).where('id', '=', m.group_id).execute();
    }
    await moveRosterPersona(trx, m.group_id, fromUserId, toUserId);
  }
  return memberships.length;
}

/**
 * The family roster has one persona per member. Hand the Apple row's to the
 * Google row — keeping its id, so facts filed against it stay attached —
 * unless the Google row already has its own, in which case the Apple row's
 * stays as a departed member's does.
 */
async function moveRosterPersona(
  trx: Kysely<DB>,
  groupId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  const [mine, theirs] = await Promise.all([
    trx
      .selectFrom('personas')
      .select(['id', 'name'])
      .where('group_id', '=', groupId)
      .where('member_user_id', '=', fromUserId)
      .executeTakeFirst(),
    trx
      .selectFrom('personas')
      .select('id')
      .where('group_id', '=', groupId)
      .where('member_user_id', '=', toUserId)
      .executeTakeFirst(),
  ]);
  if (!mine || theirs) return;
  const [from, to] = await Promise.all([
    trx.selectFrom('users').select(['display_name', 'username']).where('id', '=', fromUserId).executeTakeFirstOrThrow(),
    trx.selectFrom('users').select(['display_name', 'username']).where('id', '=', toUserId).executeTakeFirstOrThrow(),
  ]);
  // A name seeded from the Apple account is replaced; one the family edited stays.
  const seeded = mine.name === (from.display_name ?? from.username);
  await trx
    .updateTable('personas')
    .set({
      member_user_id: toUserId,
      ...(seeded ? { name: to.display_name ?? to.username } : {}),
    })
    .where('id', '=', mine.id)
    .execute();
}

/**
 * ADR 0040 gives every member their own copy of a group event, keyed by
 * `ical_uid`. Where both rows were in the same group the Google row already
 * holds its copy, and handing it the Apple row's as well would show the event
 * twice. Copies the Google row lacks are kept — they are its only view of the
 * events in groups the Apple row joined.
 */
async function dropDuplicateEventCopies(trx: Kysely<DB>, fromUserId: string, toUserId: string): Promise<void> {
  await trx
    .deleteFrom('events')
    .where('owner_user_id', '=', fromUserId)
    .where(
      'ical_uid',
      'in',
      trx.selectFrom('events').select('ical_uid').where('owner_user_id', '=', toUserId).where('ical_uid', 'is not', null),
    )
    .execute();
}

/**
 * Both directions of ADR 0065's resolved links: the Apple row's own address
 * book (unique per owner + number, so a number the Google row already links
 * is dropped) and other people's links that resolved to the Apple row.
 */
async function moveContactLinks(trx: Kysely<DB>, fromUserId: string, toUserId: string): Promise<void> {
  const held = await trx
    .selectFrom('contact_links')
    .select('phone_hash')
    .where('owner_user_id', '=', toUserId)
    .execute();
  if (held.length > 0) {
    await trx
      .deleteFrom('contact_links')
      .where('owner_user_id', '=', fromUserId)
      .where(
        'phone_hash',
        'in',
        held.map((r) => r.phone_hash),
      )
      .execute();
  }
  await trx.updateTable('contact_links').set({ owner_user_id: toUserId }).where('owner_user_id', '=', fromUserId).execute();
  await trx.updateTable('contact_links').set({ chord_user_id: toUserId }).where('chord_user_id', '=', fromUserId).execute();
  // One account linking to itself (the Apple row had saved the Google row's number).
  await trx
    .deleteFrom('contact_links')
    .where('owner_user_id', '=', toUserId)
    .where('chord_user_id', '=', toUserId)
    .execute();
}
