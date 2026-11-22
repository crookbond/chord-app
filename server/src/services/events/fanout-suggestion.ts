/**
 * ADR 0232 — which shared group, if any, a personal event looks like it
 * belongs to.
 *
 * An event made in the 1:1 chat is personal by default (one copy, the asker's
 * own calendar). The product is a family assistant, though, and "dinner with
 * Priya on Friday" is one Priya would want on her calendar too. So when the
 * title names someone who is in one of the asker's shared groups, the bot
 * OFFERS to put the event there (where it fans out to every member). Nothing
 * happens unless the user says yes: a wrong offer costs a sentence, a wrong
 * silent share puts a private event on other people's calendars.
 *
 * Deterministic on purpose — a name match, no model call. The signal is a
 * person NAMED in the title: a group member's full name or first name, or a
 * managed family member (a child on the roster, ADR 0151). A match against
 * the asker themselves is no signal at all, and a name too short to be
 * distinctive is ignored.
 *
 * ADR 0032: only the asker's own groups are consulted, and only group NAMES
 * leave this function (the caller must not hand ids to the model).
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { counterpartNames } from '../groups.service.js';

const MIN_NAME_LEN = 3;

export interface FanoutCandidate {
  id: string;
  name: string;
}

function normalize(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim()} `;
}

/** A name matches when it appears as whole words in the text. */
function namedIn(text: string, name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (n.length < MIN_NAME_LEN) return false;
  return text.includes(normalize(n));
}

export async function suggestFanoutGroups(
  db: Kysely<DB>,
  userId: string,
  title: string,
): Promise<FanoutCandidate[]> {
  const text = normalize(title);
  if (text.trim().length === 0) return [];

  const groups = await db
    .selectFrom('group_members as gm')
    .innerJoin('groups as g', 'g.id', 'gm.group_id')
    .select(['g.id as id', 'g.kind as kind', 'g.name as name', 'g.name_is_custom as name_is_custom'])
    .where('gm.user_id', '=', userId)
    .where('g.kind', '=', 'group')
    .execute();
  if (groups.length === 0) return [];
  const groupIds = groups.map((g) => g.id);

  const me = await db
    .selectFrom('users')
    .select(['display_name', 'first_name', 'preferred_name', 'username'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const mine = new Set(
    [me?.display_name, me?.first_name, me?.preferred_name, me?.username]
      .map((n) => (n ?? '').trim().toLowerCase())
      .filter(Boolean),
  );
  // A name the asker also answers to is never evidence about someone else.
  const isMine = (n: string | null | undefined) => mine.has((n ?? '').trim().toLowerCase());

  const members = await db
    .selectFrom('group_members as gm')
    .innerJoin('users as u', 'u.id', 'gm.user_id')
    .select(['gm.group_id as groupId', 'u.display_name', 'u.first_name', 'u.preferred_name'])
    .where('gm.group_id', 'in', groupIds)
    .where('gm.user_id', '!=', userId)
    .execute();
  const personas = await db
    .selectFrom('personas')
    .select(['group_id as groupId', 'name'])
    .where('group_id', 'in', groupIds)
    .where('is_managed', '=', 1)
    .execute();

  const hit = new Set<string>();
  for (const m of members) {
    for (const n of [m.display_name, m.first_name, m.preferred_name]) {
      if (!isMine(n) && namedIn(text, n)) hit.add(m.groupId);
    }
  }
  for (const p of personas) {
    if (!isMine(p.name) && namedIn(text, p.name)) hit.add(p.groupId);
  }
  // The name the USER sees and the resolver accepts: a two-person chat nobody
  // named shows as the other person (ADR 0101), so offering "Direct message"
  // would be a name the user has never seen and `share_event` cannot resolve.
  const shown = await counterpartNames(db, userId, groups);
  return groups.filter((g) => hit.has(g.id)).map((g) => ({ id: g.id, name: shown.get(g.id) ?? g.name }));
}
