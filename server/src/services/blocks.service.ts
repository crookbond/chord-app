/**
 * ADR 0067 — cross-user messaging consent. Sender-initiated, recipient opt-out:
 * a message_user send is allowed unless the recipient has blocked the sender.
 *
 * ADR 0298 — the same row is the user-level block (App Store guideline 1.2):
 * the blocker stops seeing the blocked person's messages in every shared chat
 * (`inViewOf`), gets no pushes for them, and neither side can start a direct
 * chat with the other through `message_user`. Nothing is shown to the person
 * blocked.
 */
import type { Kysely } from 'kysely';

import { fullName, type BlockedUser } from '@chord/kernel';
import type { DB } from '../db/schema.js';

/** True when `blocker` has blocked `blocked` (i.e. `blocked` may not message `blocker`). */
export async function isBlocked(
  db: Kysely<DB>,
  blocker: string,
  blocked: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('blocks')
    .select('blocker_user_id')
    .where('blocker_user_id', '=', blocker)
    .where('blocked_user_id', '=', blocked)
    .executeTakeFirst();
  return !!row;
}

export async function blockUser(db: Kysely<DB>, blocker: string, blocked: string): Promise<void> {
  await db
    .insertInto('blocks')
    .values({ blocker_user_id: blocker, blocked_user_id: blocked, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(['blocker_user_id', 'blocked_user_id']).doNothing())
    .execute();
}

export async function unblockUser(db: Kysely<DB>, blocker: string, blocked: string): Promise<void> {
  await db
    .deleteFrom('blocks')
    .where('blocker_user_id', '=', blocker)
    .where('blocked_user_id', '=', blocked)
    .execute();
}

/** True when the two users are in at least one chat together. */
async function shareAGroup(db: Kysely<DB>, a: string, b: string): Promise<boolean> {
  const row = await db
    .selectFrom('group_members as x')
    .innerJoin('group_members as y', 'y.group_id', 'x.group_id')
    .select('x.group_id')
    .where('x.user_id', '=', a)
    .where('y.user_id', '=', b)
    .executeTakeFirst();
  return !!row;
}

export type BlockResult =
  | { ok: true; user: BlockedUser; already: boolean }
  | { ok: false; reason: 'self' | 'not_found' };

/**
 * Block from the app or the bot. Only someone the blocker shares a chat with
 * can be blocked, so the route cannot be used to probe whether an id exists;
 * a stranger (and an unknown id) both answer `not_found`.
 */
export async function blockMember(db: Kysely<DB>, blocker: string, target: string): Promise<BlockResult> {
  if (blocker === target) return { ok: false, reason: 'self' };
  const already = await isBlocked(db, blocker, target);
  if (!already && !(await shareAGroup(db, blocker, target))) return { ok: false, reason: 'not_found' };
  await blockUser(db, blocker, target);
  const [user] = await listBlockedUsers(db, blocker, target);
  if (!user) return { ok: false, reason: 'not_found' };
  return { ok: true, user, already };
}

/** Everyone `blocker` has blocked, newest first. `only` narrows to one id. */
export async function listBlockedUsers(
  db: Kysely<DB>,
  blocker: string,
  only?: string,
): Promise<BlockedUser[]> {
  let q = db
    .selectFrom('blocks')
    .innerJoin('users', 'users.id', 'blocks.blocked_user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.first_name',
      'users.last_name',
      'blocks.created_at',
    ])
    .where('blocks.blocker_user_id', '=', blocker)
    .orderBy('blocks.created_at', 'desc');
  if (only) q = q.where('blocks.blocked_user_id', '=', only);
  const rows = await q.execute();
  return rows.map((r) => ({
    userId: r.id,
    name: fullName({
      username: r.username,
      displayName: r.display_name ?? undefined,
      firstName: r.first_name ?? undefined,
      lastName: r.last_name ?? undefined,
    }),
    blockedAt: r.created_at,
  }));
}

export interface PersonCandidate {
  userId: string;
  name: string;
}

export type ResolvePersonResult =
  | { kind: 'one'; person: PersonCandidate }
  | { kind: 'ambiguous'; candidates: PersonCandidate[] }
  | { kind: 'none'; candidates: PersonCandidate[] };

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Exact-name-or-ask (ADR 0077/0094): the bot names a person, and only an
 * exact match on full name, first name, preferred name or username acts.
 * Two exact matches ask; no exact match returns near misses (a word of the
 * name starting with what was asked) so the bot can offer them.
 */
function pickByName(people: Array<PersonCandidate & { names: string[] }>, asked: string): ResolvePersonResult {
  const q = norm(asked);
  const exact = people.filter((p) => p.names.some((n) => norm(n) === q));
  const strip = (p: PersonCandidate & { names: string[] }): PersonCandidate => ({ userId: p.userId, name: p.name });
  if (exact.length === 1) return { kind: 'one', person: strip(exact[0]) };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.map(strip) };
  const near = q
    ? people.filter((p) => p.names.some((n) => norm(n).split(' ').some((w) => w.startsWith(q) || q.startsWith(w))))
    : [];
  return { kind: 'none', candidates: near.slice(0, 5).map(strip) };
}

/**
 * A person the user shares a chat with, by name, for `block_user`, or (with
 * `groupId`) a member of that one chat, for `report_message`.
 */
export async function resolveBlockablePerson(
  db: Kysely<DB>,
  userId: string,
  asked: string,
  groupId?: string,
): Promise<ResolvePersonResult> {
  let q = db
    .selectFrom('group_members as me')
    .innerJoin('group_members as them', 'them.group_id', 'me.group_id')
    .innerJoin('users', 'users.id', 'them.user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.first_name',
      'users.last_name',
      'users.preferred_name',
    ])
    .where('me.user_id', '=', userId)
    .where('them.user_id', '!=', userId)
    .distinct();
  if (groupId) q = q.where('me.group_id', '=', groupId);
  const rows = await q.execute();
  const people = rows.map((r) => {
    const name = fullName({
      username: r.username,
      displayName: r.display_name ?? undefined,
      firstName: r.first_name ?? undefined,
      lastName: r.last_name ?? undefined,
    });
    return {
      userId: r.id,
      name,
      names: [name, r.first_name, r.preferred_name, r.username].filter((n): n is string => !!n && !!n.trim()),
    };
  });
  return pickByName(people, asked);
}

/** Someone already blocked, by name, for `unblock_user`. */
export async function resolveBlockedPerson(
  db: Kysely<DB>,
  userId: string,
  asked: string,
): Promise<ResolvePersonResult> {
  const blocked = await listBlockedUsers(db, userId);
  if (blocked.length === 0) return { kind: 'none', candidates: [] };
  const extra = await db
    .selectFrom('users')
    .select(['id', 'username', 'first_name', 'preferred_name'])
    .where(
      'id',
      'in',
      blocked.map((b) => b.userId),
    )
    .execute();
  const byId = new Map(extra.map((r) => [r.id, r]));
  const people = blocked.map((b) => {
    const r = byId.get(b.userId);
    return {
      userId: b.userId,
      name: b.name,
      names: [b.name, r?.first_name, r?.preferred_name, r?.username].filter(
        (n): n is string => !!n && !!n.trim(),
      ),
    };
  });
  return pickByName(people, asked);
}
