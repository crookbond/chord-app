/**
 * Email section of the daily briefing (ADR 0063 → 0072). Deterministic — no
 * LLM — and attention-first: pending magic suggestions and mail worth a reply
 * lead; category counts are one closing line, not the story. Appended to the
 * morning briefing message in proactive.service.ts (one message, not two).
 */
import { sql, type Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { keepDistinct, type EmbedTexts } from '../briefing/near-duplicates.js';
import { recordTokenUsage } from '../tokens.service.js';
import { listBriefingRules, matchBriefingRule, type BriefingRule } from './briefing-rules.service.js';
import { getTiles } from './classification.service.js';
import { pendingSuggestionsForUser } from './magics.service.js';

/** Root tiles whose unread mail rarely needs a reply — kept to the count line. */
const LOW_SIGNAL_ROOTS = new Set(['newsletters', 'coupons', 'deliveries', 'receipts']);

/** Count of unread, non-archived threads. */
async function unreadCount(db: Kysely<DB>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('email_threads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** category id → its ROOT category title (lowercased), for low-signal filtering. */
async function rootTitleByCategory(db: Kysely<DB>, userId: string): Promise<Map<string, string>> {
  const cats = await db
    .selectFrom('email_categories')
    .select(['id', 'parent_id', 'title'])
    .where('user_id', '=', userId)
    .execute();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const out = new Map<string, string>();
  for (const c of cats) {
    let node = c;
    while (node.parent_id) {
      const parent = byId.get(node.parent_id);
      if (!parent) break;
      node = parent;
    }
    out.set(c.id, node.title.toLowerCase());
  }
  return out;
}

/** category id → its OWN title (lowercased) — for ADR 0161's `category`
 *  kind, which (like email_routing_rules) matches the thread's actual
 *  assigned category, not the root it rolls up to. */
async function leafCategoryTitles(db: Kysely<DB>, userId: string): Promise<Map<string, string>> {
  const cats = await db
    .selectFrom('email_categories')
    .select(['id', 'title'])
    .where('user_id', '=', userId)
    .execute();
  return new Map(cats.map((c) => [c.id, c.title.toLowerCase()]));
}

/**
 * Which of these pending-suggestion proposal ids are excluded by a briefing
 * rule. A suggestion carries no thread info of its own (EmailMagicSuggestion
 * is a wire type shared with the client), so this resolves each proposal's
 * `gmail:<threadId>` provenance back to the thread locally rather than
 * widening that shared type for one caller.
 */
async function excludedProposalIds(
  db: Kysely<DB>,
  userId: string,
  proposalIds: string[],
  rules: BriefingRule[],
  leafTitles: Map<string, string>,
): Promise<Set<string>> {
  if (proposalIds.length === 0 || rules.length === 0) return new Set();
  const proposals = await db
    .selectFrom('proposals')
    .select(['id', 'provenance'])
    .where('id', 'in', proposalIds)
    .execute();
  const gidToProposalId = new Map<string, string>();
  for (const p of proposals) {
    if (p.provenance?.startsWith('gmail:')) gidToProposalId.set(p.provenance.slice('gmail:'.length), p.id);
  }
  if (gidToProposalId.size === 0) return new Set();

  const threads = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'from_email', 'category_id', 'subject'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', 'in', [...gidToProposalId.keys()])
    .execute();

  const out = new Set<string>();
  for (const t of threads) {
    const proposalId = gidToProposalId.get(t.gmail_thread_id);
    if (!proposalId) continue;
    const categoryTitle = t.category_id ? (leafTitles.get(t.category_id) ?? null) : null;
    if (matchBriefingRule(rules, { fromEmail: t.from_email, categoryTitle, subject: t.subject })) {
      out.add(proposalId);
    }
  }
  return out;
}

/** Escape a fragment for a LIKE/ILIKE pattern, mirroring the convention used
 *  throughout this file's siblings (e.g. recipients.service.ts). */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

/**
 * A `sender_domain` / `sender_email` / `subject_keyword` rule translated into
 * a SQL predicate that is true when the rule MATCHES a thread — the same test
 * `matchBriefingRule` runs in JS, mirrored field-for-field (domain via
 * `split_part` on `@`, same as `fromEmail.split('@')[1]`; exact/`LIKE`
 * matches on the same lowercased columns). Returns null for `category`, which
 * needs the classifier's leaf-title lookup — that one stays in JS rather than
 * becoming a second copy of the same match (ADR 0085/0152's "two copies of a
 * predicate" trap).
 */
function ruleSqlPredicate(rule: BriefingRule) {
  const pattern = rule.pattern;
  switch (rule.kind) {
    case 'sender_domain':
      return sql<boolean>`(
        lower(split_part(coalesce(from_email, ''), '@', 2)) = ${pattern}
        or lower(split_part(coalesce(from_email, ''), '@', 2)) like ${'%.' + likeEscape(pattern)} escape '\\'
      )`;
    case 'sender_email':
      return sql<boolean>`lower(coalesce(from_email, '')) = ${pattern}`;
    // `subject_keyword` is not here: the subject is sealed (ADR 0201), so the
    // database cannot look inside it. It is matched in JS, like a category.
    default:
      return null;
  }
}

/** Unread count with ADR 0161 rules applied — kept separate from the plain
 *  `unreadCount` (which the rest of the app's badges/tiles still use
 *  unfiltered) so the briefing's own closing line doesn't contradict what it
 *  just hid. Zero rules is the common case and costs nothing extra.
 *
 *  Sender/subject rules are excluded in SQL (`ruleSqlPredicate`) so most
 *  mailboxes never pull a single unread row into JS just to count them; a
 *  `category` rule still needs each remaining row's `category_id` resolved
 *  through `leafTitles`, exactly as `matchBriefingRule` does everywhere
 *  else in this file. */
async function unreadCountExcluding(
  db: Kysely<DB>,
  userId: string,
  rules: BriefingRule[],
  leafTitles: Map<string, string>,
): Promise<number> {
  if (rules.length === 0) return unreadCount(db, userId);

  // Rules the database cannot evaluate: a category needs the classifier's leaf
  // lookup, and a subject keyword needs the subject, which is sealed.
  const jsRules = rules.filter((r) => r.kind === 'category' || r.kind === 'subject_keyword');
  const sqlRules = rules.filter((r) => r.kind !== 'category' && r.kind !== 'subject_keyword');

  let query = db
    .selectFrom('email_threads')
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0);
  for (const rule of sqlRules) {
    const predicate = ruleSqlPredicate(rule);
    if (predicate) query = query.where((eb) => eb.not(predicate));
  }

  if (jsRules.length === 0) {
    const row = await query.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  const rows = await query.select(['category_id', 'subject']).execute();
  let n = 0;
  for (const r of rows) {
    const categoryTitle = r.category_id ? (leafTitles.get(r.category_id) ?? null) : null;
    if (!matchBriefingRule(jsRules, { fromEmail: null, categoryTitle, subject: r.subject })) n++;
  }
  return n;
}

/** Render in the recipient's timezone — never the server's. A floating
 *  (offset-less) string is already the user's wall clock: pin it to UTC for
 *  parsing AND rendering so it displays literally instead of being
 *  reinterpreted in the server zone. */
function fmtWhen(iso: string, tz: string | null): string {
  const floating = !/(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = floating ? new Date(`${iso}Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  } as const;
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone: floating ? 'UTC' : (tz ?? 'UTC') });
  } catch {
    return d.toLocaleString('en-US', { ...opts, timeZone: 'UTC' });
  }
}

/** "Tue, Oct 27" for a due date, in the recipient's zone. */
function fmtDay(iso: string, tz: string | null): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso = `${iso}T00:00:00`;
  const floating = !/(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = floating ? new Date(`${iso}Z`) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts = { weekday: 'short', month: 'short', day: 'numeric' } as const;
  try {
    return d.toLocaleDateString('en-US', { ...opts, timeZone: floating ? 'UTC' : (tz ?? 'UTC') });
  } catch {
    return d.toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' });
  }
}

/** The user's embedder as a plain "texts to vectors" function, metered like
 *  search; undefined when meaning search is off or not consented to. */
async function embedTextsFor(db: Kysely<DB>, userId: string): Promise<EmbedTexts | undefined> {
  // Loaded when used: llm/embeddings imports llm/factory, which reaches this
  // module through its own imports, and a top-level import here closes that
  // loop at startup.
  const { getEmbedderForUser } = await import('../llm/embeddings.js');
  const embedder = await getEmbedderForUser(db, userId).catch(() => null);
  if (!embedder) return undefined;
  return async (texts) => {
    const { vectors, tokens, costUsd } = await embedder.embed(texts, 'document');
    if (embedder.metered && tokens > 0) {
      await recordTokenUsage(db, {
        userId,
        source: 'embedding',
        ref: 'briefing_dedup',
        model: embedder.id,
        promptTokens: tokens,
        completionTokens: 0,
        costUsd,
      }).catch(() => undefined);
    }
    return vectors;
  };
}

/**
 * Build the email section of the briefing, or null when there is nothing worth
 * saying (no pending suggestions, nothing reply-worthy, nothing unread).
 */
export async function buildEmailDigestBody(db: Kysely<DB>, userId: string): Promise<string | null> {
  const totalRow = await db
    .selectFrom('email_threads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (Number(totalRow?.n ?? 0) === 0) return null;

  const rules = await listBriefingRules(db, userId);
  const rootTitles = await rootTitleByCategory(db, userId);
  const leafTitles = rules.length > 0 ? await leafCategoryTitles(db, userId) : new Map<string, string>();
  const recipient = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const tz = recipient?.last_tz ?? null;

  // Over-fetch past the eventual cap of 5 (like unreadRows below) so a rule
  // hiding one of the top suggestions doesn't quietly shrink the list.
  const suggestionCandidates = await pendingSuggestionsForUser(db, userId, 20);
  const excludedSuggestionIds =
    rules.length > 0
      ? await excludedProposalIds(
          db,
          userId,
          suggestionCandidates.map((s) => s.proposalId),
          rules,
          leafTitles,
        )
      : new Set<string>();
  const visibleSuggestions = suggestionCandidates.filter((s) => !excludedSuggestionIds.has(s.proposalId));
  // Which email each suggestion came from: two suggestions from one email that
  // mean the same thing are one line, and that email is not also listed below.
  const sourceRows = visibleSuggestions.length
    ? await db
        .selectFrom('proposals')
        .select(['id', 'provenance'])
        .where('id', 'in', visibleSuggestions.map((s) => s.proposalId))
        .execute()
    : [];
  const threadOfProposal = new Map(
    sourceRows.map((r) => [r.id, r.provenance?.startsWith('gmail:') ? r.provenance.slice('gmail:'.length) : null]),
  );
  const embed = await embedTextsFor(db, userId);
  const suggestions = (
    await keepDistinct(
      visibleSuggestions,
      (s) => s.title,
      (s) => threadOfProposal.get(s.proposalId) ?? null,
      embed,
    )
  ).slice(0, 5);
  const suggestedThreads = new Set(
    suggestions.map((s) => threadOfProposal.get(s.proposalId)).filter((t): t is string => !!t),
  );

  const unreadRows = await db
    .selectFrom('email_threads')
    .select(['gmail_thread_id', 'subject', 'from_name', 'from_email', 'category_id'])
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0)
    .orderBy('last_message_at', 'desc')
    .limit(30)
    .execute();
  const replyCandidates = unreadRows.filter((r) => {
    if (suggestedThreads.has(r.gmail_thread_id)) return false;
    const root = r.category_id ? rootTitles.get(r.category_id) : undefined;
    if (root && LOW_SIGNAL_ROOTS.has(root)) return false;
    // ADR 0161 — the user's own "leave this out" rules.
    const categoryTitle = r.category_id ? (leafTitles.get(r.category_id) ?? null) : null;
    return !matchBriefingRule(rules, { fromEmail: r.from_email, categoryTitle, subject: r.subject });
  });
  // The same notice arriving in two mailboxes, or twice, is one line.
  const replyWorthy = (
    await keepDistinct(
      replyCandidates,
      (r) => `${r.from_name ?? r.from_email ?? ''}: ${r.subject ?? ''}`,
      (r) => r.gmail_thread_id,
      embed,
    )
  ).slice(0, 5);

  const unread = await unreadCountExcluding(db, userId, rules, leafTitles);
  if (suggestions.length === 0 && replyWorthy.length === 0 && unread === 0) return null;

  const lines: string[] = ['📬 Email'];

  if (suggestions.length > 0) {
    lines.push('Waiting on you:');
    for (const s of suggestions) {
      const detail =
        s.kind === 'event'
          ? s.detail
            ? ` — ${fmtWhen(s.detail, tz)}`
            : ''
          : s.kind === 'task'
            ? s.detail
              ? ` → due ${fmtDay(s.detail, tz)}`
              : ''
            : s.detail
              ? ` → ${s.detail}`
              : '';
      const dest = s.targetGroupName ? ` (→ ${s.targetGroupName})` : '';
      lines.push(`  ✨ ${s.title}${detail}${dest}`);
    }
  }

  if (replyWorthy.length > 0) {
    lines.push('Worth a look:');
    for (const r of replyWorthy) {
      const from = r.from_name ?? r.from_email ?? 'Unknown';
      lines.push(`  • ${from}: ${r.subject || '(no subject)'}`);
    }
  }

  const root = await getTiles(db, userId, null);
  // Where the unread mail is: each category's UNREAD count, never its total.
  const top = root.tiles
    .map((t) => ({ title: t.title, unread: t.unread ?? 0 }))
    .filter((t) => t.unread > 0)
    .sort((a, b) => b.unread - a.unread)
    .slice(0, 4);
  const countLine =
    unread > 0
      ? `${unread} unread${top.length ? ` — ${top.map((t) => `${t.title} ${t.unread}`).join(' · ')}` : ''}.`
      : "You're all caught up.";
  lines.push(countLine);

  return lines.join('\n');
}
