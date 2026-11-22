/**
 * Family personas — the roster for the per-group family-profile surface
 * (design doc `docs/tasks/family-profile-design.md`, Phase 1).
 *
 * `group_members` stays the auth truth. A persona is created for every
 * account-member by the migration backfill (`seedGroupPersonas`) and can also
 * be created here for a managed non-user (a kid, a grandparent, the nanny).
 */
import type { Kysely } from 'kysely';

import { categoryForKey, type Persona, type PromotePersonResult } from '@chord/kernel';

import type { DB, PersonasTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { upsertMemory } from './memory.service.js';

function rowToPersona(r: {
  id: string;
  group_id: string;
  member_user_id: string | null;
  name: string;
  household_role: PersonasTable['household_role'];
  is_managed: number;
  managed_by: string | null;
  birthdate: string | null;
  linked_person_id: string | null;
  created_at: string;
}): Persona {
  return {
    id: r.id,
    groupId: r.group_id,
    memberUserId: r.member_user_id,
    name: r.name,
    householdRole: r.household_role,
    isManaged: r.is_managed === 1,
    managedBy: r.managed_by,
    birthdate: r.birthdate,
    linkedPersonId: r.linked_person_id,
    createdAt: r.created_at,
  };
}

export async function listPersonas(db: Kysely<DB>, groupId: string): Promise<Persona[]> {
  const rows = await db
    .selectFrom('personas')
    .selectAll()
    .where('group_id', '=', groupId)
    // Account members first (they anchor the roster), then by creation.
    .orderBy((eb) => eb.case().when('member_user_id', 'is not', null).then(0).else(1).end())
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(rowToPersona);
}

export async function getPersona(db: Kysely<DB>, id: string): Promise<Persona | null> {
  const row = await db.selectFrom('personas').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToPersona(row) : null;
}

/**
 * ADR 0151 — resolve a free-text name to a *managed* persona in this group
 * (case-insensitive exact match on `name`). Account members are resolved
 * elsewhere and win a name collision; this is the fallback arm. Returns the
 * first match — a roster with two managed "Sam"s is a naming problem the user
 * fixes, not something to disambiguate here.
 */
export async function resolveManagedPersonaByName(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<Persona | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const rows = await db
    .selectFrom('personas')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('is_managed', '=', 1)
    .orderBy('created_at', 'asc')
    .execute();
  const hit = rows.find((r) => r.name.trim().toLowerCase() === needle);
  return hit ? rowToPersona(hit) : null;
}

/**
 * Ensure an account member has a persona in a shared group — called when a
 * group is created and when someone joins, so the roster stays complete
 * without a re-run of the backfill. No-op for personal groups and for members
 * who already have one.
 */
export async function ensurePersonaForMember(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
): Promise<void> {
  const group = await db
    .selectFrom('groups')
    .select('kind')
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (!group || group.kind !== 'group') return;

  const existing = await db
    .selectFrom('personas')
    .select('id')
    .where('group_id', '=', groupId)
    .where('member_user_id', '=', userId)
    .executeTakeFirst();
  if (existing) return;

  const user = await db
    .selectFrom('users')
    .select(['display_name', 'username'])
    .where('id', '=', userId)
    .executeTakeFirst();

  await db
    .insertInto('personas')
    .values({
      id: newId('pers'),
      group_id: groupId,
      member_user_id: userId,
      name: (user?.display_name ?? user?.username ?? 'Member').trim() || 'Member',
      household_role: 'other',
      is_managed: 0,
      managed_by: null,
      birthdate: null,
      linked_person_id: null,
      created_at: new Date().toISOString(),
    })
    .execute();
}

/** Create a managed non-user persona (a kid, a grandparent, a caregiver). */
export async function createPersona(
  db: Kysely<DB>,
  input: {
    groupId: string;
    name: string;
    householdRole: PersonasTable['household_role'];
    birthdate?: string | null;
    managedBy: string;
    /** The owner's private People row this persona stands for, if any. */
    linkedPersonId?: string | null;
  },
): Promise<Persona> {
  const id = newId('pers');
  const row: PersonasTable = {
    id,
    group_id: input.groupId,
    member_user_id: null,
    name: input.name.trim(),
    household_role: input.householdRole,
    is_managed: 1,
    managed_by: input.managedBy,
    birthdate: input.birthdate ?? null,
    linked_person_id: input.linkedPersonId ?? null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('personas').values(row).execute();
  return rowToPersona(row);
}

export async function updatePersona(
  db: Kysely<DB>,
  id: string,
  patch: {
    name?: string;
    householdRole?: PersonasTable['household_role'];
    birthdate?: string | null;
  },
): Promise<Persona | null> {
  const values: Partial<PersonasTable> = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.householdRole !== undefined) values.household_role = patch.householdRole;
  if (patch.birthdate !== undefined) values.birthdate = patch.birthdate;
  if (Object.keys(values).length > 0) {
    await db.updateTable('personas').set(values).where('id', '=', id).execute();
  }
  return getPersona(db, id);
}

export type PromotePersonOutcome =
  | { ok: true; result: PromotePersonResult }
  | { ok: false; reason: 'not_found' | 'not_owner' };

/**
 * Promote a person from the caller's private People roster into a shared
 * group: create (or reuse) a managed persona there and copy the person's
 * important dates, note, and email across as facts. One-directional — the
 * private original and the group copy diverge after. Same consent shape as
 * ADR 0097's per-item group chip: an explicit user action, never automatic.
 */
export async function promotePersonToGroup(
  db: Kysely<DB>,
  input: { userId: string; groupId: string; personId: string },
): Promise<PromotePersonOutcome> {
  const person = await db
    .selectFrom('people')
    .selectAll()
    .where('id', '=', input.personId)
    .executeTakeFirst();
  if (!person) return { ok: false, reason: 'not_found' };
  if (person.owner_user_id !== input.userId) return { ok: false, reason: 'not_owner' };

  const dates = await db
    .selectFrom('important_dates')
    .selectAll()
    .where('person_id', '=', input.personId)
    .execute();
  const birthdate =
    dates.find((d) => d.kind === 'birthday' && !d.date.startsWith('0000'))?.date ?? null;

  const needle = person.display_name.trim().toLowerCase();
  const existing = (await listPersonas(db, input.groupId)).find(
    (p) => p.isManaged && p.name.trim().toLowerCase() === needle,
  );
  const persona = existing
    ? existing
    : await createPersona(db, {
        groupId: input.groupId,
        name: person.display_name,
        householdRole: 'other',
        birthdate,
        managedBy: input.userId,
      });

  const provenance = `promoted:person:${input.personId}`;
  const write = (key: string, value: string, opts: { datedAt?: string } = {}) =>
    upsertMemory(db, {
      groupId: input.groupId,
      scope: 'group',
      key,
      value,
      source: 'explicit',
      status: 'confirmed',
      subjectType: 'persona',
      subjectId: persona.id,
      category: categoryForKey(key),
      provenance,
      ...(opts.datedAt ? { datedAt: opts.datedAt } : {}),
    });

  let facts = 0;
  if (person.notes?.trim()) {
    await write('note', person.notes.trim());
    facts += 1;
  }
  if (person.email) {
    await write('email', person.email);
    facts += 1;
  }
  for (const d of dates) {
    await write(d.kind, d.date, d.date.startsWith('0000') ? {} : { datedAt: d.date });
    facts += 1;
  }

  return { ok: true, result: { persona, facts, reused: Boolean(existing) } };
}

export type DeletePersonaResult = 'deleted' | 'not_found' | 'linked';

/**
 * Only a managed persona can be deleted. An account-linked one follows its
 * `group_members` row — leaving the group is how it goes away.
 */
export async function deletePersona(db: Kysely<DB>, id: string): Promise<DeletePersonaResult> {
  const row = await db
    .selectFrom('personas')
    .select(['id', 'member_user_id'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!row) return 'not_found';
  if (row.member_user_id !== null) return 'linked';
  await db.deleteFrom('personas').where('id', '=', id).execute();
  return 'deleted';
}
