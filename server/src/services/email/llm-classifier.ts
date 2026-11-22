/**
 * In-repo LLM email classifier (ADR 0066). Batches new/changed threads, asks
 * the user's LLM for category paths, merges into the existing tree, and
 * snapshot-replaces via ingestClassification. Gated by EMAIL_CLASSIFIER=llm.
 * Fail-closed: LLM/parse errors leave the previous classification intact.
 */
import { sql, type Kysely } from 'kysely';

import { EmailAction, type EmailClassificationSnapshot } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { trackPassCost } from './pass-cost.js';
import { BODY_EXCERPT_CHARS, bodyForModel, cleanSnippet } from '../../utils/email-text.js';
import { getLlmForUser } from '../llm/factory.js';
import {
  buildTreeFromPaths,
  type PathAssignment,
} from './classifier-tree.js';
import { ingestClassification } from './classification.service.js';
import { ownAddresses } from './sender-stats.service.js';
import {
  applySortRules,
  categoryPathResolver,
  listSortRules,
  sortRulesPromptBlock,
} from './sort-rules.service.js';

/** Marker in the system prompt so MockLlmService (and tests) can detect this call. */
export const EMAIL_LLM_CLASSIFIER_MARKER = 'EMAIL_LLM_CLASSIFIER_V1';

function classifySystemPrompt(maxDepth: number): string {
  return `${EMAIL_LLM_CLASSIFIER_MARKER}

You classify personal email threads for a family assistant on TWO INDEPENDENT
axes: a recursive category tree (what the thread is ABOUT) and a single action
(what the thread WANTS FROM THE USER). Reply with STRICT JSON only:

{"assignments":[{"gmailThreadId":"...","path":["Travel","Flights"],"action":"to_do","bulk":false,"confidence":0.0-1.0}]}

action is exactly one of:
- "to_do"         something concrete for the user to do or schedule: a form to
                  return, a payment due, an appointment to book, an event to put
                  on the calendar, an RSVP. A coupon, a sale, or a broadcast of
                  events the user has not registered for is NOT a to_do — there
                  is nothing they must do — mark it "informational".
- "reply_needed"  a human is waiting on a written reply from the user.
                  "cc": true on a thread means the user was only copied on
                  its newest message. A question put to the person it was
                  sent To ("Hi Tom, when are you free?") is not waiting on
                  the user: mark it "informational", unless the email names
                  the user or plainly asks them too.
- "informational" worth reading, nothing to do: statements, receipts, shipping
                  updates, newsletters, confirmations of things already handled.
- "other"         genuinely none of the above.

The two axes are independent - judge them separately. One school email can be
"reply_needed" and the next "informational"; both still sit under
Friends & family. Never let the category decide the action, or the reverse.

Illustrative top-level tiles (use these titles when they fit; invent a short
leaf title only when confidence is high):
- Friends & family → Forms to fill | School notes | Playdates & invites
- Travel → Flights | Hotels | Ground transport | Car rentals | Itineraries & confirmations
- Finance → Credit card statements | Bank alerts | Paystubs | Investments
- Social & professional → LinkedIn | Job alerts | Social updates
- Events & invites → Invitations | Tickets
- Deliveries → Shipping updates | Order confirmations | Returns
- Newsletters → Finance | Sports | Tech | Recipes & food | Local | Junk
- Coupons → Retail | Grocery & dining | Travel | Home & services
- Receipts | Recipes / forwards

Rules:
- path is top → leaf (1–${maxDepth} segments). Prefer the illustrative vocabulary.
- The optional gmailCategory field is Gmail's own tab for the thread — a hint
  about the SENDER, not the subject: "social" → "Social & professional";
  "updates" that are shipping/receipt-shaped → "Deliveries" / "Receipts". A
  clearly personal note overrides the hint.
- Each thread carries subject, sender, snippet and (when we have it) the first
  part of the message body. Read the body when it is there — the snippet is
  often just a marketing preheader.
- ALWAYS return "bulk": true when the thread was SENT as a blast (a mailing
  list, a marketing send, an automated broadcast), false when a person or a
  system wrote to this user specifically. This is about HOW it was sent, not
  what it is worth: a school announcement, an invitation and a billing notice
  can all be bulk. It never changes the path — a retailer's sale on ski gear
  is ["Coupons","Retail"], never a Newsletters topic.
- The optional bulk field ON THE INPUT is what the sender's own headers
  declared, when they declared anything. Trust it over your own reading.
- "Newsletters" is for EDITORIAL writing someone subscribed to: a column, a
  digest, a briefing. A retailer selling something is "Coupons" however
  newsletter-shaped it looks, and platform notifications (LinkedIn, Facebook,
  Nextdoor) are "Social & professional".
- Always give a Newsletter a TOPIC leaf (["Newsletters","Finance"], never bare
  ["Newsletters"]); use the listed topics when they fit, invent a short topic
  when they don't, and use ["Newsletters","Junk"] for a subscription that turned
  out to be pure noise.
- Never invent a catch-all leaf ("Personal notes", "Misc", "Other", "General").
  A thread that fits the parent but no listed leaf gets the PARENT path alone.
- Only include threads from the user message. Omit threads you cannot classify.
- Never invent gmailThreadId values. Output JSON only.`;
}

interface BatchThread {
  gmailThreadId: string;
  fromEmail: string | null;
  subject: string;
  snippet: string;
  labelIds: string[];
  /** ADR 0109 — how it was sent, which the model must not read as a topic. */
  bulk: boolean;
  /** ADR 0110 — the first slice of the message, when sync captured one. */
  body: string | null;
  /** The user is on the newest message's Cc and not its To. */
  ccOnly: boolean;
}

/**
 * Deterministic sender → path routing for unmistakable bulk senders. Skips the
 * LLM entirely for these threads: cheaper, and immune to batch-to-batch drift
 * ("LinkedIn" one week, "Social" the next). Matched on the sender's domain
 * suffix so subdomains (e.g. jobs-noreply@linkedin.com) route too.
 */
const SENDER_PATHS: Array<[domain: string, path: string[]]> = [
  ['linkedin.com', ['Social & professional', 'LinkedIn']],
  ['indeed.com', ['Social & professional', 'Job alerts']],
  ['glassdoor.com', ['Social & professional', 'Job alerts']],
  ['ziprecruiter.com', ['Social & professional', 'Job alerts']],
  ['facebookmail.com', ['Social & professional', 'Social updates']],
  ['instagram.com', ['Social & professional', 'Social updates']],
  ['nextdoor.com', ['Social & professional', 'Social updates']],
  ['redditmail.com', ['Social & professional', 'Social updates']],
  ['pinterest.com', ['Social & professional', 'Social updates']],
  ['x.com', ['Social & professional', 'Social updates']],
  ['evite.com', ['Events & invites', 'Invitations']],
  ['paperlesspost.com', ['Events & invites', 'Invitations']],
  ['punchbowl.com', ['Events & invites', 'Invitations']],
  ['eventbrite.com', ['Events & invites', 'Tickets']],
  ['meetup.com', ['Events & invites', 'Invitations']],
];

export function deterministicPathFor(fromEmail: string | null): string[] | null {
  const domain = fromEmail?.split('@')[1]?.toLowerCase().trim();
  if (!domain) return null;
  for (const [suffix, path] of SENDER_PATHS) {
    if (domain === suffix || domain.endsWith(`.${suffix}`)) return path;
  }
  return null;
}

/** Gmail's own inbox tab for the thread ('social' | 'promotions' | …), if any. */
export function gmailCategoryOf(labelIds: string[]): string | null {
  const label = labelIds.find((l) => l.startsWith('CATEGORY_'));
  if (!label) return null;
  const cat = label.slice('CATEGORY_'.length).toLowerCase();
  return cat === 'personal' ? null : cat;
}

/** Pure: merge baseline paths with a batch of LLM path results (batch wins). */
function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

export function mergePathAssignments(
  baseline: PathAssignment[],
  batch: PathAssignment[],
): PathAssignment[] {
  const byId = new Map<string, PathAssignment>();
  for (const a of baseline) byId.set(a.gmailThreadId, a);
  for (const a of batch) {
    if (a.path.length === 0) continue;
    byId.set(a.gmailThreadId, a);
  }
  return [...byId.values()];
}

/** Pure: parse LLM JSON into path assignments; clamp path depth. */
export function parseClassifierResponse(
  raw: string,
  allowedThreadIds: Set<string>,
  maxDepth: number,
): PathAssignment[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof obj !== 'object' || obj === null) return [];
  const assignments = (obj as { assignments?: unknown }).assignments;
  if (!Array.isArray(assignments)) return [];

  const out: PathAssignment[] = [];
  for (const item of assignments) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const gmailThreadId = typeof row.gmailThreadId === 'string' ? row.gmailThreadId : '';
    if (!gmailThreadId || !allowedThreadIds.has(gmailThreadId)) continue;
    if (!Array.isArray(row.path)) continue;
    const path = row.path
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim().slice(0, 120))
      .slice(0, Math.max(1, maxDepth));
    if (path.length === 0) continue;
    const confidence =
      typeof row.confidence === 'number' && row.confidence >= 0 && row.confidence <= 1
        ? row.confidence
        : undefined;
    const parsedAction = EmailAction.safeParse(row.action);
    out.push({
      gmailThreadId,
      path,
      confidence,
      action: parsedAction.success ? parsedAction.data : undefined,
      // Anything but a real boolean is no answer at all — left undefined so
      // a malformed reply cannot be read as "not bulk".
      bulk: typeof row.bulk === 'boolean' ? row.bulk : undefined,
    });
  }
  return out;
}

/** Walk category rows into title paths keyed by category id. */
function pathByCategoryId(
  cats: { id: string; parent_id: string | null; title: string }[],
): Map<string, string[]> {
  const byId = new Map(cats.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();
  const pathOf = (id: string): string[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) return [];
    const parentPath = node.parent_id ? pathOf(node.parent_id) : [];
    const path = [...parentPath, node.title];
    memo.set(id, path);
    return path;
  };
  for (const c of cats) pathOf(c.id);
  return memo;
}

async function loadBaselinePaths(db: Kysely<DB>, userId: string): Promise<PathAssignment[]> {
  const cats = await db
    .selectFrom('email_categories')
    .select(['id', 'parent_id', 'title'])
    .where('user_id', '=', userId)
    .execute();
  const paths = pathByCategoryId(cats);
  const rows = await db
    .selectFrom('email_message_categories')
    .innerJoin('email_threads', 'email_threads.id', 'email_message_categories.thread_id')
    .select([
      'email_threads.gmail_thread_id as gmailThreadId',
      'email_threads.action as action',
      'email_message_categories.category_id as categoryId',
      'email_message_categories.confidence as confidence',
    ])
    .where('email_message_categories.user_id', '=', userId)
    .execute();
  const out: PathAssignment[] = [];
  for (const r of rows) {
    const path = paths.get(r.categoryId);
    if (!path || path.length === 0) continue;
    out.push({
      gmailThreadId: r.gmailThreadId,
      path,
      confidence: r.confidence ?? undefined,
      // Carry the previous action: ingest is snapshot-replace, so a thread
      // absent from this batch would otherwise be reset to 'other'.
      action: r.action ?? undefined,
    });
  }
  return out;
}

/**
 * ADR 0110 — the generation of prompt + inputs behind a stored classification.
 * Bump it when either changes materially and the mailbox re-runs itself; a
 * prompt change no longer needs a migration to take effect on old mail.
 */
export const CLASSIFIER_VERSION = 1;

async function selectBatch(db: Kysely<DB>, userId: string, limit: number): Promise<BatchThread[]> {
  // New mail first (never classified, priority 0), then stale vs
  // thread.updated_at (priority 1), then anything left on an old
  // classifier_version — the re-run queue (priority 2), so a prompt change
  // drains the mailbox without ever starving new arrivals, and no second
  // rate knob to keep in step with the batch size. Pushed into SQL with a
  // LIMIT instead of loading the whole mailbox into JS to sort+slice —
  // a mailbox with thousands of threads otherwise full-scans every tick.
  const picked = await db
    .selectFrom('email_threads')
    .select([
      'gmail_thread_id',
      'from_email',
      'subject',
      'snippet',
      'gmail_label_ids',
      'bulk',
      'classifier_version',
      'classified_at',
      'updated_at',
    ])
    .where('user_id', '=', userId)
    .where('is_archived', '=', 0)
    .where((eb) =>
      eb.or([
        eb('classified_at', 'is', null),
        eb.and([eb('updated_at', 'is not', null), eb('updated_at', '>', eb.ref('classified_at'))]),
        eb('classifier_version', '<', CLASSIFIER_VERSION),
      ]),
    )
    .orderBy(
      sql`case
        when classified_at is null then 0
        when updated_at is not null and updated_at > classified_at then 1
        else 2
      end`,
    )
    .orderBy('updated_at', 'desc')
    .limit(limit)
    .execute();

  const ids = picked.map((r) => r.gmail_thread_id);
  const [bodies, ccOnly] = await Promise.all([newestBodies(db, userId, ids), ccOnlyThreads(db, userId, ids)]);
  return picked.map((r) => ({
    gmailThreadId: r.gmail_thread_id,
    fromEmail: r.from_email,
    subject: r.subject,
    snippet: r.snippet,
    labelIds: r.gmail_label_ids ?? [],
    bulk: r.bulk === 1,
    body: bodies.get(r.gmail_thread_id) ?? null,
    ccOnly: ccOnly.has(r.gmail_thread_id),
  }));
}

/** Threads whose newest message has the user on Cc and not on To. */
async function ccOnlyThreads(db: Kysely<DB>, userId: string, gmailThreadIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (gmailThreadIds.length === 0) return out;
  const mine = new Set(await ownAddresses(db, userId));
  if (mine.size === 0) return out;
  const rows = await db
    .selectFrom('email_messages')
    .select(['gmail_thread_id', 'to_emails', 'cc_emails'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', 'in', gmailThreadIds)
    .distinctOn('gmail_thread_id')
    .orderBy('gmail_thread_id')
    .orderBy('internal_date', 'desc')
    .execute();
  const has = (list: unknown) => Array.isArray(list) && list.some((a) => typeof a === 'string' && mine.has(a.toLowerCase()));
  for (const r of rows) if (!has(r.to_emails) && has(r.cc_emails)) out.add(r.gmail_thread_id);
  return out;
}

/** Newest readable text per thread — the reader's full body when a human has
 *  opened it, else the excerpt sync kept (ADR 0110). */
async function newestBodies(
  db: Kysely<DB>,
  userId: string,
  gmailThreadIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (gmailThreadIds.length === 0) return out;
  const bodiesOf = (ids: string[]) =>
    db
      .selectFrom('email_messages')
      .select(['gmail_thread_id', 'body_text', 'body_html', 'body_excerpt', 'internal_date'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', 'in', ids);
  const withBody = (qb: ReturnType<typeof bodiesOf>) =>
    qb.where((eb) =>
      eb.or([eb('body_text', 'is not', null), eb('body_html', 'is not', null), eb('body_excerpt', 'is not', null)]),
    );
  // Only the newest message of each thread is read (and decrypted), not every
  // message of up to 200 threads.
  const newest = await withBody(bodiesOf(gmailThreadIds))
    .distinctOn('gmail_thread_id')
    .orderBy('gmail_thread_id')
    .orderBy('internal_date', 'desc')
    .execute();
  const blank: string[] = [];
  for (const r of newest) {
    const text = bodyForModel({ html: r.body_html, text: r.body_text, excerpt: r.body_excerpt });
    if (text) out.set(r.gmail_thread_id, text);
    else blank.push(r.gmail_thread_id);
  }
  if (blank.length === 0) return out;
  // The newest message showed nothing readable: the newest one that does.
  const rows = await withBody(bodiesOf(blank)).orderBy('internal_date', 'asc').execute();
  // Ascending, so the last write per thread is the newest message.
  for (const r of rows) {
    const text = bodyForModel({ html: r.body_html, text: r.body_text, excerpt: r.body_excerpt });
    if (text) out.set(r.gmail_thread_id, text);
  }
  return out;
}

function buildSnapshotFromPaths(
  userId: string,
  paths: PathAssignment[],
): EmailClassificationSnapshot {
  const { categories, assignments } = buildTreeFromPaths(paths);
  return { version: 1, userId, categories, assignments };
}

/** Classify new/changed threads with the LLM and ingest a merged snapshot.
 *  No-op unless EMAIL_CLASSIFIER=llm. */
export async function runLlmClassifier(db: Kysely<DB>, userId: string): Promise<void> {
  if (env.EMAIL_CLASSIFIER !== 'llm') return;

  const batchSize = Math.min(Math.max(env.EMAIL_CLASSIFIER_BATCH_SIZE, 1), 200);
  const maxDepth = Math.min(Math.max(env.EMAIL_CLASSIFIER_MAX_DEPTH, 1), 8);
  const batch = await selectBatch(db, userId, batchSize);
  if (batch.length === 0) {
    logger.debug(`llm classifier user=${userId} nothing to classify`);
    return;
  }

  // Unmistakable senders route without the LLM; the rest carry Gmail's own
  // category tab as a hint.
  const deterministic: PathAssignment[] = [];
  const needsLlm: BatchThread[] = [];
  for (const t of batch) {
    const path = deterministicPathFor(t.fromEmail);
    // These senders (LinkedIn, job boards, social) are bulk by definition, so
    // the action is as knowable as the category - no reason to spend an LLM
    // call proving that a LinkedIn digest is informational.
    if (path) {
      deterministic.push({
        gmailThreadId: t.gmailThreadId,
        path,
        confidence: 1,
        action: 'informational',
      });
    } else needsLlm.push(t);
  }

  const baseline = await loadBaselinePaths(db, userId);
  // ADR 0267 — the user's own categories and rules: told to the model, then
  // applied to its answer, so they hold even when it does not follow them.
  const { rules, categories: ownCategories } = await listSortRules(db, userId);

  let batchPaths: PathAssignment[] = [];
  // A call that THREW is retried; a call that answered is not, even when the
  // answer was empty. Without that distinction a thread the model declines to
  // classify sits at the head of the re-run queue forever, spending the whole
  // batch budget on the same threads every tick.
  let llmErrored = false;
  if (needsLlm.length > 0) {
    const system = classifySystemPrompt(maxDepth) + sortRulesPromptBlock(rules, ownCategories);
    const userPayload = JSON.stringify({
      threads: needsLlm.map((t) => ({
        gmailThreadId: t.gmailThreadId,
        fromEmail: t.fromEmail,
        subject: cleanSnippet(t.subject),
        snippet: cleanSnippet(t.snippet).slice(0, 280),
        gmailCategory: gmailCategoryOf(t.labelIds),
        // Omitted rather than `false`: the field is a hint, and a key repeated
        // across every thread in the batch is paid for on every pass.
        ...(t.bulk ? { bulk: true } : {}),
        ...(t.ccOnly ? { cc: true } : {}),
        ...(t.body ? { body: t.body.slice(0, BODY_EXCERPT_CHARS) } : {}),
      })),
    });

    try {
      const llm = await getLlmForUser(db, userId, 'email_classify');
      const cost = trackPassCost();
      const startedAt = Date.now();
      const raw = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: userPayload },
        ],
        { temperature: 0, maxTokens: 4096, onUsage: cost.onUsage },
      );
      // Attributed across the batch, not the whole tick: the deterministic
      // routes cost nothing and would flatter the per-thread number.
      cost.report({
        pass: 'classify',
        userId,
        threads: needsLlm.length,
        model: llm.defaultModel,
        ms: Date.now() - startedAt,
      });
      const allowed = new Set(needsLlm.map((t) => t.gmailThreadId));
      batchPaths = parseClassifierResponse(raw, allowed, maxDepth);
      if (batchPaths.length === 0) {
        logger.warn('llm classifier returned no usable assignments', { userId });
      }
    } catch (err) {
      llmErrored = true;
      // Fail-closed for the LLM's share only — deterministic routes below
      // still land, and unclassified threads re-batch next sync.
      logger.warn('llm classifier call failed — keeping previous classification', {
        userId,
        err: (err as Error).message,
      });
    }
  }

  // Before the early return: this pass read these threads whether or not it had
  // anything to say about them.
  if (!llmErrored) await stampPass(db, userId, batch, [...deterministic, ...batchPaths]);

  // An "always" rule decides the category outright; a "never" rule cuts its
  // category off whatever was decided. `cleared` are threads a rule left with
  // no category: their old path must not come back from the baseline.
  let decided = [...deterministic, ...batchPaths];
  const cleared = new Set<string>();
  if (rules.length > 0) {
    const resolve = await categoryPathResolver(db, userId);
    const decidedById = new Map(decided.map((a) => [a.gmailThreadId, a]));
    const baselineById = new Map(baseline.map((a) => [a.gmailThreadId, a]));
    const next: PathAssignment[] = [];
    for (const t of batch) {
      const a = decidedById.get(t.gmailThreadId);
      const prior = baselineById.get(t.gmailThreadId);
      const before = a?.path ?? prior?.path ?? null;
      const after = applySortRules(before, { fromEmail: t.fromEmail, subject: t.subject }, rules, resolve);
      if (after === null) {
        if (before !== null) cleared.add(t.gmailThreadId);
        continue;
      }
      if (a) next.push({ ...a, path: after });
      else if (!before || !samePath(after, before)) {
        next.push({ gmailThreadId: t.gmailThreadId, path: after, confidence: 1, action: prior?.action ?? 'other' });
      }
    }
    decided = next;
  }

  if (decided.length === 0 && cleared.size === 0) return;

  const merged = mergePathAssignments(
    baseline.filter((b) => !cleared.has(b.gmailThreadId)),
    decided,
  );
  const snapshot = buildSnapshotFromPaths(userId, merged);
  const result = await ingestClassification(db, userId, snapshot);
  if ('ok' in result) {
    logger.warn('llm classifier produced an invalid snapshot', { userId, error: result.error });
    return;
  }
  logger.info(
    `llm classifier user=${userId} batch=${batch.length} deterministic=${deterministic.length} categories=${result.categories} assignments=${result.assignments}`,
  );
}

/**
 * Record the classifier generation, and the model's bulk verdict where it gave
 * one. `bulk_inferred` is kept apart from the provider-declared `bulk`
 * (ADR 0110) — different writers, different schedules.
 *
 * Deliberately not inside `ingestClassification`: the snapshot is
 * replace-everything and carries the whole mailbox forward from baseline, so
 * stamping there would mark threads as freshly classified that nobody re-read,
 * and the re-run queue would empty without ever running.
 */
async function stampPass(
  db: Kysely<DB>,
  userId: string,
  batch: BatchThread[],
  assignments: PathAssignment[],
): Promise<void> {
  const verdict = new Map(
    assignments
      .filter((a) => typeof a.bulk === 'boolean')
      .map((a) => [a.gmailThreadId, a.bulk as boolean]),
  );
  // Three groups by what the pass has to say about `bulk` (nothing, yes, no),
  // one UPDATE each, instead of one UPDATE per thread in the batch.
  // `classified_at` too: selectBatch re-picks any thread where it is NULL, so
  // a thread the model answered about with nothing was re-sent every tick.
  const now = new Date().toISOString();
  const stamp = { classifier_version: CLASSIFIER_VERSION, classified_at: now };
  const groups: {
    ids: string[];
    set: { classifier_version: number; classified_at: string; bulk_inferred?: number };
  }[] = [
    { ids: [], set: stamp },
    { ids: [], set: { ...stamp, bulk_inferred: 1 } },
    { ids: [], set: { ...stamp, bulk_inferred: 0 } },
  ];
  for (const t of batch) {
    const bulk = verdict.get(t.gmailThreadId);
    groups[bulk === undefined ? 0 : bulk ? 1 : 2]!.ids.push(t.gmailThreadId);
  }
  for (const g of groups) {
    for (let i = 0; i < g.ids.length; i += 500) {
      await db
        .updateTable('email_threads')
        .set(g.set)
        .where('user_id', '=', userId)
        .where('gmail_thread_id', 'in', g.ids.slice(i, i + 500))
        .execute();
    }
  }
}
