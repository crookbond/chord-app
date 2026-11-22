/**
 * ADR 0267 — the user's own sorting rules for email categories, set in the
 * 1:1 chat: "always put mail from chase.com in Finance", "never put the PTA
 * newsletter in Newsletters", "make a category for Kids' sports". Applied by
 * the LLM classifier (llm-classifier.ts) on every pass; adding one re-queues
 * the mail it covers so existing threads are re-sorted, not just new ones.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { categoryKey } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { defineUserDefault } from '../user-defaults.service.js';

export const SortRule = z.object({
  /** Sender: a full address, or a domain (matches its subdomains too). */
  from: z.string().trim().toLowerCase().max(200).optional(),
  /** Words that must appear in the subject (case ignored). */
  subject: z.string().trim().max(120).optional(),
  category: z.string().trim().min(1).max(120),
  rule: z.enum(['always', 'never']),
  createdAt: z.string(),
});
export type SortRule = z.infer<typeof SortRule>;

export const UserCategory = z.object({
  title: z.string().trim().min(1).max(60),
  /** What belongs in it, in the user's words; told to the classifier. */
  about: z.string().trim().max(300),
  createdAt: z.string(),
});
export type UserCategory = z.infer<typeof UserCategory>;

export const MAX_SORT_RULES = 100;
export const MAX_USER_CATEGORIES = 30;

export const emailSortRules = defineUserDefault('email_sort_rules', z.array(SortRule).max(MAX_SORT_RULES));
export const emailUserCategories = defineUserDefault(
  'email_user_categories',
  z.array(UserCategory).max(MAX_USER_CATEGORIES),
);

export interface RuleThread {
  fromEmail: string | null;
  subject: string | null;
}

/** Does `rule`'s sender and subject both match (an absent one matches all)? */
export function ruleMatches(rule: Pick<SortRule, 'from' | 'subject'>, t: RuleThread): boolean {
  if (!rule.from && !rule.subject) return false;
  if (rule.from) {
    const from = (t.fromEmail ?? '').trim().toLowerCase();
    if (!from) return false;
    if (rule.from.includes('@')) {
      if (from !== rule.from) return false;
    } else {
      const domain = from.split('@')[1] ?? '';
      const want = rule.from.replace(/^@/, '');
      if (domain !== want && !domain.endsWith(`.${want}`)) return false;
    }
  }
  if (rule.subject) {
    if (!(t.subject ?? '').toLowerCase().includes(rule.subject.toLowerCase())) return false;
  }
  return true;
}

/**
 * The category path the rules give one thread. "always" rules set it (the
 * newest matching rule wins); "never" rules then cut off the named category
 * and everything below it. `null` means no category at all (Unsorted).
 * `resolve` turns a category title into its full path in the user's tree.
 */
export function applySortRules(
  path: string[] | null,
  t: RuleThread,
  rules: SortRule[],
  resolve: (title: string) => string[],
): string[] | null {
  let out = path;
  const always = rules.filter((r) => r.rule === 'always' && ruleMatches(r, t));
  if (always.length > 0) out = resolve(always[always.length - 1]!.category);
  for (const r of rules) {
    if (r.rule !== 'never' || !out || !ruleMatches(r, t)) continue;
    const at = out.findIndex((seg) => categoryKey(seg) === categoryKey(r.category));
    if (at >= 0) out = at === 0 ? null : out.slice(0, at);
  }
  return out;
}

/** Title → full path, from the user's current tree; a new title is top-level. */
export async function categoryPathResolver(
  db: Kysely<DB>,
  userId: string,
): Promise<(title: string) => string[]> {
  const rows = await db
    .selectFrom('email_categories')
    .select(['id', 'parent_id', 'title'])
    .where('user_id', '=', userId)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const path: string[] = [];
    let cur: typeof r | undefined = r;
    let guard = 0;
    while (cur && guard++ < 10) {
      path.unshift(cur.title);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    const k = categoryKey(r.title);
    // The shallowest match wins when two branches share a title.
    if (!byKey.has(k) || byKey.get(k)!.length > path.length) byKey.set(k, path);
  }
  return (title) => byKey.get(categoryKey(title)) ?? [title.trim()];
}

/**
 * Put the threads a rule covers back in the classifier's queue
 * (`classifier_version = 0`), so the rule reaches mail that is already
 * sorted. A rule with no sender or subject (a new category) re-queues the
 * last 30 days, since the model has to read them to know what fits.
 */
export async function requeueForRule(
  db: Kysely<DB>,
  userId: string,
  match: Pick<SortRule, 'from' | 'subject'>,
): Promise<number> {
  const rows = await db
    .selectFrom('email_threads')
    .select(['id', 'from_email', 'subject', 'last_message_at'])
    .where('user_id', '=', userId)
    .where('is_archived', '=', 0)
    .execute();
  const since = Date.now() - 30 * 86_400_000;
  const ids = rows
    .filter((r) =>
      match.from || match.subject
        ? ruleMatches(match, { fromEmail: r.from_email, subject: r.subject })
        : Date.parse(r.last_message_at) >= since,
    )
    .map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    await db
      .updateTable('email_threads')
      .set({ classifier_version: 0 })
      .where('user_id', '=', userId)
      .where('id', 'in', ids.slice(i, i + 500))
      .execute();
  }
  return ids.length;
}

async function knownTitles(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db.selectFrom('email_categories').select('title').where('user_id', '=', userId).execute();
  const own = (await emailUserCategories.get(db, userId)) ?? [];
  const seen = new Map<string, string>();
  for (const t of [...rows.map((r) => r.title), ...own.map((c) => c.title)]) {
    const k = categoryKey(t);
    if (k && !seen.has(k)) seen.set(k, t.trim());
  }
  return [...seen.values()];
}

export type AddSortRuleResult =
  | { ok: true; rule: SortRule; requeued: number; newCategory: boolean }
  | { ok: false; reason: 'needs_match' | 'too_many' }
  | { ok: false; reason: 'not_found'; category: string; candidates: string[]; categories: string[] };

/**
 * "never" needs a category that exists (there is nothing to keep mail out of
 * otherwise, and a typo would silently do nothing); "always" may name a new
 * one, which is then created as the user's own category.
 */
export async function addSortRule(
  db: Kysely<DB>,
  userId: string,
  input: { from?: string; subject?: string; category: string; rule: 'always' | 'never' },
  nowIso = new Date().toISOString(),
): Promise<AddSortRuleResult> {
  const from = input.from?.trim().toLowerCase().replace(/^@/, '') || undefined;
  const subject = input.subject?.trim() || undefined;
  if (!from && !subject) return { ok: false, reason: 'needs_match' };
  const titles = await knownTitles(db, userId);
  const hit = titles.find((t) => categoryKey(t) === categoryKey(input.category));
  let newCategory = false;
  if (!hit) {
    if (input.rule === 'never') {
      const want = categoryKey(input.category);
      return {
        ok: false,
        reason: 'not_found',
        category: input.category,
        candidates: titles.filter((t) => {
          const k = categoryKey(t);
          return k.includes(want) || want.includes(k);
        }),
        categories: titles,
      };
    }
    // Under a row lock, like every write below: two changes at once both land.
    const made = await emailUserCategories.update(db, userId, (stored) => {
      const own = stored ?? [];
      if (own.some((c) => categoryKey(c.title) === categoryKey(input.category))) {
        return { value: undefined, result: true };
      }
      if (own.length >= MAX_USER_CATEGORIES) return { value: undefined, result: false };
      return { value: [...own, { title: input.category.trim(), about: '', createdAt: nowIso }], result: true };
    });
    if (!made) return { ok: false, reason: 'too_many' };
    newCategory = true;
  }
  const rule: SortRule = {
    ...(from ? { from } : {}),
    ...(subject ? { subject } : {}),
    category: hit ?? input.category.trim(),
    rule: input.rule,
    createdAt: nowIso,
  };
  // The same sender/subject/category said again replaces the old rule.
  const same = (r: SortRule) =>
    (r.from ?? '') === (rule.from ?? '') &&
    (r.subject ?? '').toLowerCase() === (rule.subject ?? '').toLowerCase() &&
    categoryKey(r.category) === categoryKey(rule.category);
  // The cap counts other rules only: saying the same rule again replaces it.
  const added = await emailSortRules.update(db, userId, (stored) => {
    const others = (stored ?? []).filter((r) => !same(r));
    if (others.length >= MAX_SORT_RULES) return { value: undefined, result: false };
    return { value: [...others, rule], result: true };
  });
  if (!added) return { ok: false, reason: 'too_many' };
  const requeued = await requeueForRule(db, userId, rule);
  return { ok: true, rule, requeued, newCategory };
}

export type CreateCategoryResult =
  | { ok: true; category: UserCategory; requeued: number; existed: boolean }
  | { ok: false; reason: 'too_many' };

/** A category the user asked for, with what belongs in it. */
export async function createUserCategory(
  db: Kysely<DB>,
  userId: string,
  input: { title: string; about?: string },
  nowIso = new Date().toISOString(),
): Promise<CreateCategoryResult> {
  const k = categoryKey(input.title);
  const saved = await emailUserCategories.update(db, userId, (stored) => {
    const own = stored ?? [];
    const prior = own.find((c) => categoryKey(c.title) === k);
    if (!prior && own.length >= MAX_USER_CATEGORIES) return { value: undefined, result: null };
    const category: UserCategory = {
      title: prior?.title ?? input.title.trim(),
      about: input.about?.trim() ?? prior?.about ?? '',
      createdAt: prior?.createdAt ?? nowIso,
    };
    return {
      value: [...own.filter((c) => categoryKey(c.title) !== k), category],
      result: { category, existed: !!prior },
    };
  });
  if (!saved) return { ok: false, reason: 'too_many' };
  const { category, existed } = saved;
  const requeued = await requeueForRule(db, userId, {});
  return { ok: true, category, requeued, existed };
}

export type RemoveSortRuleResult = { ok: true; removedRules: number; removedCategory: boolean };

/**
 * Removes every rule that matches all the fields given; `category` alone
 * removes that category's rules and, when it is one the user created, the
 * category itself. The mail those rules covered is re-queued so it is sorted
 * the ordinary way again.
 */
export async function removeSortRules(
  db: Kysely<DB>,
  userId: string,
  input: { from?: string; subject?: string; category?: string },
): Promise<RemoveSortRuleResult> {
  const from = input.from?.trim().toLowerCase().replace(/^@/, '') || undefined;
  const subject = input.subject?.trim().toLowerCase() || undefined;
  const cat = input.category ? categoryKey(input.category) : undefined;
  const goes = (r: SortRule) =>
    (from === undefined || r.from === from) &&
    (subject === undefined || (r.subject ?? '').toLowerCase() === subject) &&
    (cat === undefined || categoryKey(r.category) === cat) &&
    (from !== undefined || subject !== undefined || cat !== undefined);
  const removed = await emailSortRules.update(db, userId, (stored) => {
    const rules = stored ?? [];
    return { value: rules.filter((r) => !goes(r)), result: rules.filter(goes) };
  });
  let removedCategory = false;
  if (cat !== undefined && from === undefined && subject === undefined) {
    removedCategory = await emailUserCategories.update(db, userId, (stored) => {
      const own = stored ?? [];
      const kept = own.filter((c) => categoryKey(c.title) !== cat);
      return kept.length !== own.length ? { value: kept, result: true } : { value: undefined, result: false };
    });
  }
  for (const r of removed) await requeueForRule(db, userId, r);
  if (removedCategory) await requeueForRule(db, userId, {});
  return { ok: true, removedRules: removed.length, removedCategory };
}

export async function listSortRules(
  db: Kysely<DB>,
  userId: string,
): Promise<{ rules: SortRule[]; categories: UserCategory[] }> {
  return {
    rules: (await emailSortRules.get(db, userId)) ?? [],
    categories: (await emailUserCategories.get(db, userId)) ?? [],
  };
}

/** What the classifier's system prompt is told about the user's own setup. */
export function sortRulesPromptBlock(rules: SortRule[], categories: UserCategory[]): string {
  if (rules.length === 0 && categories.length === 0) return '';
  const lines: string[] = ['', 'The user\'s own categories and rules (they override the vocabulary above):'];
  for (const c of categories) {
    lines.push(`- Category "${c.title}" (top-level)${c.about ? `: ${c.about}` : ''}. Use it for mail that fits.`);
  }
  for (const r of rules) {
    const who = [r.from ? `from ${r.from}` : '', r.subject ? `with "${r.subject}" in the subject` : '']
      .filter(Boolean)
      .join(' and ');
    lines.push(
      r.rule === 'always'
        ? `- Mail ${who} always goes in "${r.category}".`
        : `- Mail ${who} never goes in "${r.category}".`,
    );
  }
  return lines.join('\n');
}
