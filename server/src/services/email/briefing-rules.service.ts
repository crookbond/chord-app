/**
 * ADR 0161 — per-user "leave this out of my briefing" rules. Modeled on
 * `email_routing_rules` (ADR 0077/0150), but there is no target: a rule hit
 * just means `digest.service.ts` skips the thread when rendering the
 * briefing's email section. Classification and the extraction passes
 * (magics/person-extraction/attachment-import) are untouched — a rule here
 * only changes what's SHOWN, never what's mined.
 *
 * Rule kinds:
 *   - sender_domain: matches the sender's domain or any subdomain.
 *   - sender_email: exact address — finer than domain.
 *   - category: case-insensitive SUBSTRING of the classifier's category
 *     title chain, same forgiving match as email_routing_rules's `category`.
 *   - subject_keyword: case-insensitive substring of the thread subject, for
 *     a topic that isn't sender- or category-shaped.
 */
import type { Kysely } from 'kysely';

import type { DB, EmailBriefingRulesTable } from '../../db/schema.js';
import { newId } from '../../utils/ids.js';
import { resolveCategoryMatch } from './classification.service.js';
import { findEmailThreads } from './email-search.js';

export type BriefingRuleKind = EmailBriefingRulesTable['kind'];

export interface BriefingRule {
  id: string;
  kind: BriefingRuleKind;
  pattern: string;
}

export async function listBriefingRules(db: Kysely<DB>, userId: string): Promise<BriefingRule[]> {
  const rows = await db
    .selectFrom('email_briefing_rules')
    .select(['id', 'kind', 'pattern'])
    .where('user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows;
}

/** Upsert (user, kind, pattern). Idempotent — re-adding an existing rule is a no-op. */
export async function setBriefingRule(
  db: Kysely<DB>,
  input: { userId: string; kind: BriefingRuleKind; pattern: string },
): Promise<void> {
  const pattern = input.pattern.trim().toLowerCase();
  await db
    .insertInto('email_briefing_rules')
    .values({
      id: newId('ebr'),
      user_id: input.userId,
      kind: input.kind,
      pattern,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.columns(['user_id', 'kind', 'pattern']).doNothing())
    .execute();
}

/** Remove a rule by (kind, pattern). Returns whether one existed. */
export async function deleteBriefingRule(
  db: Kysely<DB>,
  userId: string,
  kind: BriefingRuleKind,
  pattern: string,
): Promise<boolean> {
  const res = await db
    .deleteFrom('email_briefing_rules')
    .where('user_id', '=', userId)
    .where('kind', '=', kind)
    .where('pattern', '=', pattern.trim().toLowerCase())
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0) > 0;
}

/**
 * Does any rule match this thread? Pure function so the matching logic is
 * pinned by a table of cases independent of the DB (mirrors bulk-gate.ts's
 * `isMinable`/`minablePredicate` split).
 */
export function matchBriefingRule(
  rules: readonly BriefingRule[],
  thread: { fromEmail: string | null; categoryTitle: string | null; subject: string | null },
): boolean {
  if (rules.length === 0) return false;
  const domain = thread.fromEmail?.split('@')[1]?.toLowerCase().trim() ?? null;
  const email = thread.fromEmail?.toLowerCase().trim() ?? null;
  const category = thread.categoryTitle?.toLowerCase() ?? null;
  const subject = thread.subject?.toLowerCase() ?? null;

  return rules.some((r) => {
    switch (r.kind) {
      case 'sender_domain':
        return domain !== null && (domain === r.pattern || domain.endsWith(`.${r.pattern}`));
      case 'sender_email':
        return email !== null && email === r.pattern;
      case 'category':
        return category !== null && category.includes(r.pattern);
      case 'subject_keyword':
        return subject !== null && subject.includes(r.pattern);
      default:
        return false;
    }
  });
}

export interface ResolvedBriefingPattern {
  ok: true;
  kind: BriefingRuleKind;
  pattern: string;
}
export interface AmbiguousBriefingPattern {
  ok: false;
  reason: 'ambiguous';
  candidates: string[];
}
export interface UnresolvedBriefingPattern {
  ok: false;
  reason: 'not_found';
}

/**
 * Turn free text ("Rippling", "notifications@rippling.com", "the PTA
 * fundraiser") into a rule kind+pattern, deterministically — no LLM. Mirrors
 * `inferRuleKind` (routing-rules.service.ts) for the email/domain-shaped
 * cases, and extends it with a category check (ADR 0152's
 * `resolveCategoryMatch`, already built) and a sender-name search over the
 * user's OWN mail (ADR 0065/0114's sender-scoped-only discipline) before
 * falling back to a subject keyword.
 */
export async function resolveBriefingPattern(
  db: Kysely<DB>,
  userId: string,
  text: string,
): Promise<ResolvedBriefingPattern | AmbiguousBriefingPattern> {
  const p = text.trim();
  const lower = p.toLowerCase();

  if (p.includes('@')) {
    return { ok: true, kind: 'sender_email', pattern: lower };
  }
  if (p.includes('.') && !/\s/.test(p)) {
    return { ok: true, kind: 'sender_domain', pattern: lower };
  }

  const categoryHit = await resolveCategoryMatch(db, userId, p);
  if (categoryHit) {
    return { ok: true, kind: 'category', pattern: lower };
  }

  // The sender's name is sealed (ADR 0201), so this is the same `from:` lookup
  // the search box uses rather than a LIKE of its own. It only ever needs to
  // know whether the match is unique or ambiguous (`candidates` for the bot to
  // pick from), never an exhaustive list.
  const senderRows = await findEmailThreads(db, {
    userId,
    text: '',
    from: p,
    limit: 20,
    order: 'recent',
  });
  const domains = [
    ...new Set(
      senderRows
        .map((r) => r.fromEmail?.split('@')[1]?.toLowerCase().trim())
        .filter((d): d is string => !!d),
    ),
  ];
  if (domains.length === 1) {
    return { ok: true, kind: 'sender_domain', pattern: domains[0]! };
  }
  if (domains.length > 1) {
    return { ok: false, reason: 'ambiguous', candidates: domains };
  }

  return { ok: true, kind: 'subject_keyword', pattern: lower };
}
