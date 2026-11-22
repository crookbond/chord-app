/**
 * Who is going on a trip, said by the user (ADR 0289 addendum).
 *
 * Anyone can be a traveller. A member of the trip's group with a Chord account
 * is stored in `trip_participants` by user id, as before; everyone else - a
 * family member without an account (a persona of that group) or a friend Chord
 * knows nothing about - goes in `trip_named_travelers` by name, with the
 * persona linked when the name is one. Having an account, or being family,
 * makes no difference to whether someone can be on a trip; it only decides
 * which table holds them. Both are written on the trip itself, so a trip with
 * no tickets (a hotel stay, a drive) can still say who is going.
 */
import type { Kysely } from 'kysely';
import { fullName } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { isNameSubset, nameTokens, tokenSetKey } from './chain.js';

export interface ResolvedTraveler {
  /** Set when the person has a Chord account in the trip's group. */
  userId: string | null;
  /** Set for a family member without an account. */
  personaId: string | null;
  /** The name to show (and to put on a ticket). */
  name: string;
}

type Candidate = { userId: string | null; personaId: string | null; name: string; names: string[] };

function matches(asked: string[], names: string[]): 'exact' | 'part' | null {
  let part = false;
  for (const n of names) {
    const t = nameTokens(n);
    if (t.length === 0) continue;
    if (tokenSetKey(t) === tokenSetKey(asked)) return 'exact';
    if (isNameSubset(t, asked)) part = true;
  }
  return part ? 'part' : null;
}

/**
 * The member or family member of `groupId` called `name`: an exact name wins,
 * else the one person a shorter or longer spelling fits ("Ben" for "Ben
 * Doe"). Several fits, or none, resolve to nobody - the caller then keeps the
 * name as typed (`travelerByName`) rather than pinning it to the wrong person.
 */
export async function resolveTripTraveler(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<ResolvedTraveler | null> {
  const asked = nameTokens(name);
  if (asked.length === 0) return null;
  const [members, personas] = await Promise.all([
    db
      .selectFrom('group_members')
      .innerJoin('users', 'users.id', 'group_members.user_id')
      .where('group_members.group_id', '=', groupId)
      .select(['users.id', 'users.username', 'users.display_name', 'users.first_name', 'users.last_name'])
      .execute(),
    db
      .selectFrom('personas')
      .where('group_id', '=', groupId)
      .select(['id', 'name', 'member_user_id'])
      .execute(),
  ]);
  const byUser = new Map<string, Candidate>();
  for (const m of members) {
    const shown = fullName({
      username: m.username,
      displayName: m.display_name ?? undefined,
      firstName: m.first_name ?? undefined,
      lastName: m.last_name ?? undefined,
    });
    const names = [shown, m.display_name, m.username, [m.first_name, m.last_name].filter(Boolean).join(' ')]
      .filter((n): n is string => !!n);
    byUser.set(m.id, { userId: m.id, personaId: null, name: shown, names });
  }
  const candidates: Candidate[] = [...byUser.values()];
  for (const p of personas) {
    const member = p.member_user_id ? byUser.get(p.member_user_id) : undefined;
    if (member) {
      member.names.push(p.name);
      continue;
    }
    candidates.push({ userId: null, personaId: p.id, name: p.name, names: [p.name] });
  }
  const exact = candidates.filter((c) => matches(asked, c.names) === 'exact');
  const pick = exact.length > 0 ? exact : candidates.filter((c) => matches(asked, c.names) === 'part');
  if (pick.length !== 1) return null;
  const c = pick[0]!;
  return { userId: c.userId, personaId: c.personaId, name: c.name };
}

/** Someone Chord has no record of (a friend): just the name, as said. */
export function travelerByName(name: string): ResolvedTraveler | null {
  const shown = name.trim().replace(/\s+/g, ' ');
  return nameTokens(shown).length > 0 ? { userId: null, personaId: null, name: shown } : null;
}

/** Put people on the trip itself. Idempotent; one row per person by name. */
export async function addTripTravelers(
  db: Kysely<DB>,
  tripId: string,
  travelers: ReadonlyArray<ResolvedTraveler>,
): Promise<void> {
  const users = [...new Set(travelers.map((t) => t.userId).filter((id): id is string => !!id))];
  const named = new Map<string, { name: string; persona_id: string | null }>();
  for (const t of travelers) {
    if (t.userId) continue;
    const key = tokenSetKey(nameTokens(t.name));
    if (!key) continue;
    const prev = named.get(key);
    named.set(key, { name: t.name, persona_id: t.personaId ?? prev?.persona_id ?? null });
  }
  if (users.length > 0) {
    await db
      .insertInto('trip_participants')
      .values(users.map((persona_id) => ({ trip_id: tripId, persona_id })))
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  if (named.size > 0) {
    await db
      .insertInto('trip_named_travelers')
      .values([...named].map(([name_key, v]) => ({ trip_id: tripId, name_key, ...v })))
      // Said again with a family member now behind the name: link it.
      .onConflict((oc) =>
        oc.columns(['trip_id', 'name_key']).doUpdateSet((eb) => ({
          persona_id: eb.fn.coalesce(eb.ref('excluded.persona_id'), eb.ref('trip_named_travelers.persona_id')),
        })),
      )
      .execute();
  }
}

/** Everyone on each trip without an account in its group, by name. */
export async function loadTripNamedTravelers(
  db: Kysely<DB>,
  tripIds: readonly string[],
): Promise<Map<string, Array<{ personaId: string | null; name: string }>>> {
  const out = new Map<string, Array<{ personaId: string | null; name: string }>>();
  if (tripIds.length === 0) return out;
  const rows = await db
    .selectFrom('trip_named_travelers')
    .leftJoin('personas', 'personas.id', 'trip_named_travelers.persona_id')
    .where('trip_named_travelers.trip_id', 'in', [...tripIds])
    .select([
      'trip_named_travelers.trip_id',
      'trip_named_travelers.persona_id',
      'trip_named_travelers.name',
      'personas.name as personaName',
    ])
    .orderBy('trip_named_travelers.name')
    .execute();
  for (const r of rows) {
    const list = out.get(r.trip_id) ?? [];
    list.push({ personaId: r.persona_id, name: r.personaName ?? r.name });
    out.set(r.trip_id, list);
  }
  return out;
}

/** Copy one trip's named travellers onto another (merging, regrouping). */
export async function copyTripNamedTravelers(
  db: Kysely<DB>,
  fromTripId: string,
  intoTripId: string,
): Promise<void> {
  const rows = await db
    .selectFrom('trip_named_travelers')
    .select(['name_key', 'name', 'persona_id'])
    .where('trip_id', '=', fromTripId)
    .execute();
  if (rows.length === 0) return;
  await db
    .insertInto('trip_named_travelers')
    .values(rows.map((r) => ({ trip_id: intoTripId, ...r })))
    .onConflict((oc) => oc.doNothing())
    .execute();
}
