/**
 * ADR 0077 — user-declared email routing: "school email → family group".
 * Deterministic rules the magics group-router consults BEFORE the LLM
 * matcher; a rule hit routes without a model call and never mis-guesses.
 *
 * Rule kinds:
 *   - sender_domain: matches the sender's domain or any subdomain
 *     ("lcps.org" matches "teacher@mail.lcps.org").
 *   - category: case-insensitive SUBSTRING of the classifier category title
 *     ("school" matches "School notes") — forgiving on purpose, since users
 *     say "school", not the exact taxonomy label.
 *
 * Scope: a rule can only target a group the user is a member of — enforced
 * at write AND re-checked at match time (membership may have lapsed), so
 * rules can never become an ADR 0032 scope leak.
 */
import type { Kysely } from 'kysely';
import type { RouteSuggestion } from '@chord/kernel';

import type { DB, EmailRoutingRulesTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';

export type RoutingRuleKind = EmailRoutingRulesTable['kind'];

export interface RoutingRule {
  id: string;
  kind: RoutingRuleKind;
  pattern: string;
  targetGroupId: string;
  targetGroupName: string;
}

export async function listRoutingRules(db: Kysely<DB>, userId: string): Promise<RoutingRule[]> {
  const rows = await db
    .selectFrom('email_routing_rules')
    .innerJoin('groups', 'groups.id', 'email_routing_rules.target_group_id')
    .select([
      'email_routing_rules.id as id',
      'email_routing_rules.kind as kind',
      'email_routing_rules.pattern as pattern',
      'email_routing_rules.target_group_id as target_group_id',
      'groups.name as group_name',
    ])
    .where('email_routing_rules.user_id', '=', userId)
    .orderBy('email_routing_rules.created_at', 'asc')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    pattern: r.pattern,
    targetGroupId: r.target_group_id,
    targetGroupName: r.group_name,
  }));
}

/** Upsert (user, kind, pattern) → target group. Caller has already verified
 *  the user's membership in the target group. */
export async function setRoutingRule(
  db: Kysely<DB>,
  input: { userId: string; kind: RoutingRuleKind; pattern: string; targetGroupId: string },
): Promise<void> {
  const pattern = input.pattern.trim().toLowerCase();
  await db
    .insertInto('email_routing_rules')
    .values({
      id: newId('err'),
      user_id: input.userId,
      kind: input.kind,
      pattern,
      target_group_id: input.targetGroupId,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'kind', 'pattern']).doUpdateSet({
        target_group_id: input.targetGroupId,
      }),
    )
    .execute();
}

/** Remove a rule by (kind, pattern). Returns whether one existed. */
export async function deleteRoutingRule(
  db: Kysely<DB>,
  userId: string,
  kind: RoutingRuleKind,
  pattern: string,
): Promise<boolean> {
  const res = await db
    .deleteFrom('email_routing_rules')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .where('pattern', '=', pattern.trim().toLowerCase())
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

/**
 * Remove a rule by id. The Settings editor deletes the row it is showing,
 * where (kind, pattern) is a detail of the row rather than what was tapped.
 */
export async function deleteRoutingRuleById(
  db: Kysely<DB>,
  userId: string,
  id: string,
): Promise<boolean> {
  const res = await db
    .deleteFrom('email_routing_rules')
    .where('user_id', '=', userId)
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

/** A pattern with a dot and no spaces reads as a domain; else a category
 *  keyword. Shared by the bot tool so "lcps.org" and "school" both Just Work. */
export function inferRuleKind(pattern: string): RoutingRuleKind {
  const p = pattern.trim();
  return p.includes('.') && !/\s/.test(p) ? 'sender_domain' : 'category';
}

/**
 * First matching rule's target group for a thread, or null. Membership is
 * re-checked here so a rule whose group the user left silently stops firing.
 */
export async function matchRoutingRule(
  db: Kysely<DB>,
  userId: string,
  thread: { fromEmail: string | null; categoryTitle: string | null },
): Promise<string | null> {
  const rules = await db
    .selectFrom('email_routing_rules')
    .select(['kind', 'pattern', 'target_group_id'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
  if (rules.length === 0) return null;

  const domain = thread.fromEmail?.split('@')[1]?.toLowerCase().trim() ?? null;
  const category = thread.categoryTitle?.toLowerCase() ?? null;

  const hit = rules.find((r) =>
    r.kind === 'sender_domain'
      ? domain !== null && (domain === r.pattern || domain.endsWith(`.${r.pattern}`))
      : category !== null && category.includes(r.pattern),
  );
  if (!hit) return null;

  const member = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', hit.target_group_id)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return member ? hit.target_group_id : null;
}

/**
 * ADR 0150 — after a user routes an email-derived proposal into a shared group
 * by hand (the ADR 0097 chip), suggest a standing `sender_domain` rule so the
 * next proposal from that sender arrives pre-selected. Never auto-routes: the
 * rule only pre-selects, and every routed item is still one confirm tap.
 *
 * Deterministic and heavily gated — returns null unless the proposal came from
 * a Gmail thread with a parseable sender domain, the destination is a shared
 * group the user belongs to, and no `sender_domain` rule already sends that
 * domain there. A rule pointing the domain somewhere else yields a suggestion
 * with `replaces` set so the offer can read as "instead of <that group>".
 */
export async function suggestRuleFromRouting(
  db: Kysely<DB>,
  input: { userId: string; provenance: string | null; targetGroupId: string },
): Promise<RouteSuggestion | null> {
  if (!input.provenance?.startsWith('gmail:')) return null;
  const gmailThreadId = input.provenance.slice('gmail:'.length);
  if (!gmailThreadId) return null;

  const thread = await db
    .selectFrom('email_threads')
    .select('from_email')
    .where('user_id', '=', input.userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirst();
  const domain = thread?.from_email?.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;

  // The destination must be a shared group the user still belongs to. The
  // confirm path already enforced membership; this also filters out the
  // personal group (a "Just me" confirm carries no targetGroupId, but guard
  // anyway) and a group left since.
  const group = await db
    .selectFrom('groups')
    .innerJoin('group_members', 'group_members.group_id', 'groups.id')
    .select(['groups.id as id', 'groups.name as name', 'groups.kind as kind'])
    .where('groups.id', '=', input.targetGroupId)
    .where('group_members.user_id', '=', input.userId)
    .executeTakeFirst();
  if (!group || group.kind === 'personal') return null;

  const existing = await db
    .selectFrom('email_routing_rules')
    .innerJoin('groups', 'groups.id', 'email_routing_rules.target_group_id')
    .select([
      'email_routing_rules.target_group_id as target_group_id',
      'groups.name as group_name',
    ])
    .where('email_routing_rules.user_id', '=', input.userId)
    .where('email_routing_rules.kind', '=', 'sender_domain')
    .where('email_routing_rules.pattern', '=', domain)
    .executeTakeFirst();
  // Already routes there — no nag.
  if (existing?.target_group_id === input.targetGroupId) return null;

  return {
    pattern: domain,
    targetGroupId: group.id,
    targetGroupName: group.name,
    ...(existing ? { replaces: { targetGroupName: existing.group_name } } : {}),
  };
}
