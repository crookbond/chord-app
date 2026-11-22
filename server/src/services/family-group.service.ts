/**
 * ADR 0234 — the family plan's shared chat. The roster (family-plan.service)
 * is a billing fact; this is where the people on it actually meet. The first
 * person to accept an invite finds a group already waiting with the plan's
 * owner in it, and every later one is added to that same group.
 *
 * It is an ordinary `kind='group'` chat, marked only by
 * `groups.family_owner_id`, so everything groups already do (events that fan
 * out, trips that can be shared into them, the bot, per-member mute) works
 * without a special case. Nothing here decides who is covered by the plan —
 * leaving the chat does not end a seat, and ending a seat does take someone
 * out of the chat.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { createGroup, deleteGroup, isMember, leaveGroup, type GroupRow } from './groups.service.js';
import { SSE } from '@chord/kernel';

import type { PersonasTable } from '../db/schema.js';
import { postMessage } from './messages.service.js';
import { createPersona, ensurePersonaForMember } from './personas.service.js';
import { sseHub } from './sse.hub.js';

const WELCOME =
  'This is your family chat. Share a trip, an event or an email here and everyone in the family sees it. ' +
  'Mention @Chord to ask for anything, like adding a task for someone.';

async function findFamilyGroup(db: Kysely<DB>, ownerId: string): Promise<GroupRow | null> {
  const row = await db
    .selectFrom('groups')
    .selectAll()
    .where('family_owner_id', '=', ownerId)
    .executeTakeFirst();
  return row ?? null;
}

async function familyGroupName(db: Kysely<DB>, ownerId: string): Promise<string> {
  const u = await db
    .selectFrom('users')
    .select(['first_name', 'last_name', 'display_name'])
    .where('id', '=', ownerId)
    .executeTakeFirst();
  const last = u?.last_name?.trim();
  if (last) return `${last} Family`;
  const first = u?.first_name?.trim() || u?.display_name?.trim().split(/\s+/)[0];
  return first ? `${first}'s Family` : 'Family';
}

/** The roster's free-text relationship ("son", "grandma") as a household role. */
export function householdRoleFor(relationship: string | null | undefined): PersonasTable['household_role'] {
  const r = (relationship ?? '').toLowerCase();
  if (/\b(son|daughter|child|kid|baby|boy|girl|stepson|stepdaughter)s?\b/.test(r)) return 'child';
  if (/\b(grand(ma|pa|mother|father|parent)|nana|nani|dada|dadi|granny)\b/.test(r)) return 'grandparent';
  if (/\b(nanny|caregiver|babysitter|au pair|carer)\b/.test(r)) return 'caregiver';
  if (/\b(wife|husband|partner|spouse|mom|mum|mother|dad|father|parent)\b/.test(r)) return 'parent';
  return 'other';
}

/**
 * ADR 0299 addendum — someone on the roster with no account (a young child,
 * a grandparent who will never sign in) is in the family chat too, as a
 * managed persona the owner looks after (ADR 0151), so tasks and events can
 * be for them there. Linked by the People row, so it is made once and handed
 * over when they get an account. A no-op without a family chat.
 */
export async function placeRosterProfilesInFamilyGroup(db: Kysely<DB>, ownerId: string): Promise<void> {
  const group = await findFamilyGroup(db, ownerId);
  if (!group) return;
  const profiles = await db
    .selectFrom('family_members')
    .select(['name', 'relationship', 'person_id'])
    .where('owner_user_id', '=', ownerId)
    .where('user_id', 'is', null)
    .execute();
  for (const p of profiles) {
    if (!p.person_id) continue;
    const existing = await db
      .selectFrom('personas')
      .select('id')
      .where('group_id', '=', group.id)
      .where('linked_person_id', '=', p.person_id)
      .executeTakeFirst();
    if (existing) continue;
    const persona = await createPersona(db, {
      groupId: group.id,
      name: p.name,
      householdRole: householdRoleFor(p.relationship),
      managedBy: ownerId,
      linkedPersonId: p.person_id,
    });
    sseHub.broadcast(group.id, SSE.personaCreated, persona);
  }
}

/** A roster entry that is gone takes its managed persona out of the family
 *  chat. A persona already handed to an account is left alone. */
export async function removeRosterProfileFromFamilyGroup(
  db: Kysely<DB>,
  ownerId: string,
  personId: string | null,
): Promise<void> {
  const group = await findFamilyGroup(db, ownerId);
  if (!group || !personId) return;
  const gone = await db
    .deleteFrom('personas')
    .where('group_id', '=', group.id)
    .where('linked_person_id', '=', personId)
    .where('member_user_id', 'is', null)
    .returning('id')
    .execute();
  for (const g of gone) sseHub.broadcast(group.id, SSE.personaDeleted, { id: g.id, groupId: group.id });
}

async function addMemberRow(db: Kysely<DB>, groupId: string, userId: string, personId?: string | null): Promise<void> {
  if (await isMember(db, groupId, userId)) return;
  // The managed persona that stood for them becomes theirs, so what was
  // said about them (their facts, their tasks) stays with them.
  // Someone coming back after leaving still has their own persona there; the
  // stand-in made while they were off the roster is then the duplicate.
  if (personId) {
    const own = await db
      .selectFrom('personas')
      .select('id')
      .where('group_id', '=', groupId)
      .where('member_user_id', '=', userId)
      .executeTakeFirst();
    const standIn = db
      .selectFrom('personas')
      .select('id')
      .where('group_id', '=', groupId)
      .where('linked_person_id', '=', personId)
      .where('member_user_id', 'is', null);
    if (own) {
      const gone = await db.deleteFrom('personas').where('id', 'in', standIn).returning('id').execute();
      for (const g of gone) sseHub.broadcast(groupId, SSE.personaDeleted, { id: g.id, groupId });
    } else {
      await db
        .updateTable('personas')
        .set({ member_user_id: userId, is_managed: 0, managed_by: null })
        .where('id', 'in', standIn)
        .execute();
    }
  }
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'member',
      tier: 'trusted',
      joined_at: new Date().toISOString(),
    })
    .execute();
  await ensurePersonaForMember(db, groupId, userId);
}

/** The owner's family chat, created (with the owner in it) the first time it is
 *  needed. Safe to call from two requests at once: the unique index on
 *  `family_owner_id` picks one winner and the loser's group is dropped. */
export async function ensureFamilyGroup(db: Kysely<DB>, ownerId: string): Promise<GroupRow> {
  const existing = await findFamilyGroup(db, ownerId);
  if (existing) return existing;
  const group = await createGroup(db, {
    name: await familyGroupName(db, ownerId),
    kind: 'group',
    createdBy: ownerId,
    nameIsCustom: true,
  });
  try {
    await db.updateTable('groups').set({ family_owner_id: ownerId }).where('id', '=', group.id).execute();
  } catch (err) {
    await deleteGroup(db, group.id);
    const winner = await findFamilyGroup(db, ownerId);
    if (winner) return winner;
    throw err;
  }
  await postMessage(db, { groupId: group.id, senderId: null, body: WELCOME, mentionsBot: false });
  await placeRosterProfilesInFamilyGroup(db, ownerId);
  return group;
}

/** Put a newly seated member in the owner's family chat (creating it first when
 *  they are the first). Idempotent. Returns the chat's id. */
export async function seatInFamilyGroup(
  db: Kysely<DB>,
  ownerId: string,
  userId: string,
  personId?: string | null,
): Promise<string> {
  const group = await ensureFamilyGroup(db, ownerId);
  await addMemberRow(db, group.id, userId, personId);
  return group.id;
}

/** Take a member out of the owner's family chat. A no-op when there is none or
 *  they were never in it. */
export async function unseatFromFamilyGroup(
  db: Kysely<DB>,
  ownerId: string,
  userId: string,
): Promise<void> {
  const group = await findFamilyGroup(db, ownerId);
  if (!group || userId === ownerId) return;
  await leaveGroup(db, group.id, userId);
}

/** The family chat this user is in — their own, else the one they were seated
 *  into — or null. */
export async function familyGroupIdFor(db: Kysely<DB>, userId: string): Promise<string | null> {
  const rows = await db
    .selectFrom('groups as g')
    .innerJoin('group_members as gm', 'gm.group_id', 'g.id')
    .select(['g.id as id', 'g.family_owner_id as ownerId'])
    .where('gm.user_id', '=', userId)
    .where('g.family_owner_id', 'is not', null)
    .execute();
  if (rows.length === 0) return null;
  return (rows.find((r) => r.ownerId === userId) ?? rows[0]!).id;
}
