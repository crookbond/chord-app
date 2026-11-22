/**
 * Email classification consumer (ADR 0061). The clustering/tiling ENGINE is
 * external; this module owns the CONTRACT ingest (validate + replace-upsert the
 * landing tables) and the READ side (roll the adjacency tree up into tile
 * counts). We never cluster or generate the tree here.
 */
import { sql, type Kysely } from 'kysely';

import {
  SSE,
  type EmailClassificationIngestResult,
  type EmailClassificationSnapshot,
  type EmailLedgerFact,
  type EmailStateFact,
  type EmailTile,
  type EmailTileArchetype,
  type EmailTileFacts,
  type EmailTileLevel,
  type EmailTilePreview,
  type EmailTimelineFact,
} from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { textInstant } from '../../db/text-instant.js';
import { newId } from '../../utils/ids.js';
import { tzToOffset } from '../../utils/tz.js';
import { sseHub } from '../sse.hub.js';
import { pathHint, resolveArchetype, titlesPath } from './archetype-map.js';
import { emojiForCategory } from './category-emoji.js';
import { CATCH_ALL_LEAVES } from './classifier-tree.js';
import { suggestionFromProposal } from './magics.service.js';
import { newestIsSentSql } from './reply-todos.js';
import {
  buildStateFact,
  capFacts,
  dedupeTimeline,
  dropLandedRows,
  dropPastTimeline,
  extractLedgerFact,
  extractStateStatus,
  flightStateStatus,
  ledgerFromArgs,
  mergeTimeline,
  receiptToLedgerFact,
  stillAhead,
} from './tile-facts.js';

export interface SnapshotValidationError {
  ok: false;
  error: string;
}

/**
 * Validate structural invariants BEFORE touching the DB: unique ids, every
 * parentId resolves to a present node (or null), no cycles, every assignment
 * targets a present category.
 */
export function validateSnapshot(
  snapshot: EmailClassificationSnapshot,
): { ok: true } | SnapshotValidationError {
  const byId = new Map<string, string | null>(); // id -> parentId
  for (const c of snapshot.categories) {
    if (byId.has(c.id)) return { ok: false, error: `duplicate category id: ${c.id}` };
    byId.set(c.id, c.parentId);
  }
  for (const c of snapshot.categories) {
    if (c.parentId !== null && !byId.has(c.parentId)) {
      return { ok: false, error: `category ${c.id} has dangling parentId ${c.parentId}` };
    }
  }
  // Cycle detection: walk each node's parent chain.
  for (const c of snapshot.categories) {
    const seen = new Set<string>();
    let cur: string | null = c.id;
    while (cur !== null) {
      if (seen.has(cur)) return { ok: false, error: `cycle through category ${cur}` };
      seen.add(cur);
      cur = byId.get(cur) ?? null;
    }
  }
  for (const a of snapshot.assignments) {
    if (!byId.has(a.categoryId)) {
      return { ok: false, error: `assignment targets unknown category ${a.categoryId}` };
    }
  }
  return { ok: true };
}

/** Rows per statement when a snapshot is written: well inside Postgres' 65,535 parameter limit. */
const INGEST_CHUNK = 500;

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/** Insert order that satisfies the parent_id self-FK (parents before children). */
function byDepthAsc(a: { depth: number }, b: { depth: number }): number {
  return a.depth - b.depth;
}

/**
 * Storage id for a snapshot-local category id.
 *
 * `email_categories.id` is a GLOBAL primary key, but this ingest deletes only
 * the caller's rows — and every classifier derives the same path-shaped id, so
 * every user produced the identical `mk:newsletters`. The first user to
 * classify owned it; everyone else's ingest died on the primary key, rolled
 * back its whole transaction, and was swallowed by a warn-level catch. Three
 * prod mailboxes — 1,288 threads — sat unclassified for days on that.
 *
 * Namespacing happens HERE rather than where the ids are minted, because this
 * is the one place every classifier passes through. The external engine
 * (ADR 0061 Mode B, `POST /me/email/classification`) invents its own ids and
 * cannot know a Chord user id, so a fix in the tree builder would leave that
 * path just as wedged. Snapshot ids stay user-local; only storage is scoped.
 */
export const storageCategoryId = (userId: string, id: string): string => `${userId}:${id}`;

/**
 * Namespace for this module's transaction-scoped advisory lock. Two-arg
 * `pg_advisory_xact_lock(ns, key)` so a future lock elsewhere in the codebase
 * cannot collide with a `hashtext(userId)` that happens to match.
 */
const ADVISORY_NS_EMAIL_CLASSIFY = 0x656d_636c; // "emcl"

/**
 * Replace this user's whole category tree + assignments with the snapshot.
 * Assignments are keyed by Gmail thread id → mapped to local `email_threads.id`;
 * threads not yet synced are skipped (a later sync + re-ingest reconciles).
 */
export async function ingestClassification(
  db: Kysely<DB>,
  userId: string,
  snapshot: EmailClassificationSnapshot,
): Promise<EmailClassificationIngestResult | SnapshotValidationError> {
  const validation = validateSnapshot(snapshot);
  if (!validation.ok) return validation;

  // Map Gmail thread ids → local thread row ids.
  const wantThreadIds = [...new Set(snapshot.assignments.map((a) => a.gmailThreadId))];
  const threadRows = wantThreadIds.length
    ? await db
        .selectFrom('email_threads')
        .select(['id', 'gmail_thread_id'])
        .where('user_id', '=', userId)
        .where('gmail_thread_id', 'in', wantThreadIds)
        .execute()
    : [];
  const localByGmail = new Map(threadRows.map((r) => [r.gmail_thread_id, r.id]));

  const now = new Date().toISOString();
  let assignmentsWritten = 0;
  let skippedUnknownThreads = 0;

  await db.transaction().execute(async (tx) => {
    // Snapshot-replace is delete-then-insert over one user's whole tree, so two
    // of them interleaving produces exactly what prod showed: a
    // `email_categories_pkey` violation when the second inserts a row the first
    // already re-inserted, or `deadlock detected` when they grab the same rows
    // in opposite orders. ADR 0106 scoped the ids per user, which stopped
    // DIFFERENT users colliding; it never claimed anything about one user
    // ingesting twice at once, and `afterSync` was doing that once per mailbox.
    //
    // The coalescer there is the fix for the waste; this is the fix for the
    // invariant. Transaction-scoped so it releases on commit or rollback with
    // no unlock to forget, and `_xact_` specifically because it is the only
    // advisory-lock form that survives transaction-mode pooling (ADR 0038's
    // reason for banning LISTEN/NOTIFY).
    await sql`select pg_advisory_xact_lock(${ADVISORY_NS_EMAIL_CLASSIFY}, hashtext(${userId}))`.execute(
      tx,
    );
    // Replace: drop the user's existing tree + assignments, clear denormalized
    // thread.category_id. (assignments first — category FK cascades, but be explicit.)
    // `classified_at` is kept: it records that a classifier read the thread,
    // and clearing it for threads this snapshot leaves out re-queued them for
    // the LLM on every pass.
    await tx.deleteFrom('email_message_categories').where('user_id', '=', userId).execute();
    await tx.deleteFrom('email_categories').where('user_id', '=', userId).execute();
    await tx
      .updateTable('email_threads')
      .set({ category_id: null, action: null })
      .where('user_id', '=', userId)
      .execute();

    // Written in bulk. This used to insert each category, and then for each
    // assignment run an insert AND an update, one statement at a time inside
    // the transaction: 2N+C sequential round trips per pass, holding a pooled
    // connection and the per-user advisory lock throughout. The snapshot
    // carries the WHOLE mailbox forward from baseline (see llm-classifier), so
    // N is every thread the user has, not the few that just arrived: 18.9
    // updates and 18.9 inserts per sync in the load test, thousands for a real
    // mailbox. Same rows, same result, a few statements.
    const categoryRows = [...snapshot.categories].sort(byDepthAsc).map((c) => ({
      id: storageCategoryId(userId, c.id),
      user_id: userId,
      parent_id: c.parentId === null ? null : storageCategoryId(userId, c.parentId),
      title: c.title,
      depth: c.depth,
      sort_order: c.sortOrder ?? 0,
      color: c.color ?? null,
      icon: c.icon ?? null,
      gmail_label_id: c.gmailLabelId ?? null,
      updated_at: now,
    }));
    // Parents sort before children, so a child never lands in an earlier chunk
    // than its parent; within one statement the self-FK is checked at its end.
    for (const rows of chunked(categoryRows, INGEST_CHUNK)) {
      await tx.insertInto('email_categories').values(rows).execute();
    }

    const assignmentRows: {
      id: string;
      user_id: string;
      thread_id: string;
      category_id: string;
      assigned_at: string;
      confidence: number | null;
    }[] = [];
    // Last assignment for a thread wins, as it did when each one was its own update.
    const threadUpdates = new Map<string, { categoryId: string; action: string }>();
    for (const a of snapshot.assignments) {
      const threadId = localByGmail.get(a.gmailThreadId);
      if (!threadId) {
        skippedUnknownThreads += 1;
        continue;
      }
      const categoryId = storageCategoryId(userId, a.categoryId);
      assignmentRows.push({
        id: newId('emc'),
        user_id: userId,
        thread_id: threadId,
        category_id: categoryId,
        assigned_at: now,
        confidence: a.confidence ?? null,
      });
      // A classifier that predates the action axis sends no `action`; land
      // 'other' rather than null so "classified" and "has an action" stay
      // the same state and the filter never hides a classified thread.
      threadUpdates.set(threadId, { categoryId, action: a.action ?? 'other' });
      assignmentsWritten += 1;
    }
    for (const rows of chunked(assignmentRows, INGEST_CHUNK)) {
      await tx.insertInto('email_message_categories').values(rows).execute();
    }
    for (const rows of chunked([...threadUpdates.entries()], INGEST_CHUNK)) {
      // ADR 0314 — a thread whose newest message is the user's own is not
      // waiting on a reply from them, whatever the model judged.
      await sql`
        update email_threads
        set category_id = v.category_id,
            action = case when v.action = 'reply_needed' and ${newestIsSentSql()}
                          then 'other' else v.action end,
            classified_at = ${now}
        from (values ${sql.join(rows.map(([id, u]) => sql`(${id}, ${u.categoryId}, ${u.action})`))})
          as v(id, category_id, action)
        where email_threads.id = v.id
      `.execute(tx);
    }
  });

  sseHub.broadcastToUser(userId, SSE.emailTilesUpdated, { userId });

  return {
    categories: snapshot.categories.length,
    assignments: assignmentsWritten,
    skippedUnknownThreads,
  };
}

interface CatRow {
  id: string;
  parent_id: string | null;
  title: string;
  depth: number;
  sort_order: number;
  color: string | null;
  icon: string | null;
}

/** Load the user's category rows + a parentId → children index — the tree
 *  shape every rollup/walk needs, with no assignment-count join for callers
 *  that only walk the tree (e.g. `categorySubtreeIds`, `resolveCategoryMatch`). */
async function loadCategoryNodes(
  db: Kysely<DB>,
  userId: string,
): Promise<{ cats: CatRow[]; childrenOf: Map<string | null, CatRow[]> }> {
  const cats = await db
    .selectFrom('email_categories')
    .select(['id', 'parent_id', 'title', 'depth', 'sort_order', 'color', 'icon'])
    .where('user_id', '=', userId)
    .execute();
  const childrenOf = new Map<string | null, CatRow[]>();
  for (const c of cats) {
    const arr = childrenOf.get(c.parent_id) ?? [];
    arr.push(c);
    childrenOf.set(c.parent_id, arr);
  }
  for (const arr of childrenOf.values()) {
    arr.sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title));
  }
  return { cats, childrenOf };
}

/** Load the user's tree + direct assignment counts, ready for rollup. */
async function loadTree(
  db: Kysely<DB>,
  userId: string,
): Promise<{
  cats: CatRow[];
  childrenOf: Map<string | null, CatRow[]>;
  directCount: Map<string, number>;
}> {
  const { cats, childrenOf } = await loadCategoryNodes(db, userId);
  const counts = await db
    .selectFrom('email_message_categories')
    .innerJoin('email_threads', 'email_threads.id', 'email_message_categories.thread_id')
    .select('email_message_categories.category_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('email_message_categories.user_id', '=', userId)
    .where('email_threads.is_archived', '=', 0)
    .groupBy('email_message_categories.category_id')
    .execute();
  const directCount = new Map<string, number>();
  for (const c of counts) directCount.set(c.category_id, Number(c.n));

  return { cats, childrenOf, directCount };
}

/** Max preview lines carried per tile (magics first, then newest unread). */
const PREVIEWS_PER_TILE = 3;

/** Longest preview snippet carried: about two short sentences. */
const PREVIEW_SNIPPET_MAX = 200;

/**
 * The email's provider snippet cut to a sentence or two: whole sentences
 * while they fit, else cut at a word with an ellipsis. Empty = none.
 */
export function previewSnippet(raw: string | null | undefined): string | undefined {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= PREVIEW_SNIPPET_MAX) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [];
  let out = '';
  for (const sentence of sentences.slice(0, 2)) {
    if ((out + sentence).trim().length > PREVIEW_SNIPPET_MAX) break;
    out += sentence;
  }
  if (out.trim()) return out.trim();
  const cut = text.slice(0, PREVIEW_SNIPPET_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > PREVIEW_SNIPPET_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Internal preview line with its sort instant (stripped before the DTO). */
interface PreviewItem extends EmailTilePreview {
  at: string;
}

/**
 * ADR 0068 — per-category direct attention + magic counts, plus the preview
 * lines behind them: `attention` = threads needing a look (unread OR carrying
 * a pending magic suggestion, counted once); `magic` = pending suggestions
 * (a thread can carry more than one); `previews` = per-category magic titles
 * + newest-unread subjects, merged and capped per subtree in getTiles.
 */
async function loadAttention(
  db: Kysely<DB>,
  userId: string,
): Promise<{
  attention: Map<string, number>;
  /** Unread threads only - `attention` also counts read threads with a
   *  pending suggestion, so it cannot answer "is there unread mail here". */
  unread: Map<string, number>;
  /** Newest thread per category, read or not. */
  latest: Map<string, string>;
  magic: Map<string, number>;
  previews: Map<string, PreviewItem[]>;
}> {
  const attention = new Map<string, number>();
  const unreadCount = new Map<string, number>();
  const latest = new Map<string, string>();
  const magic = new Map<string, number>();
  const previews = new Map<string, PreviewItem[]>();
  const pushPreview = (categoryId: string, item: PreviewItem): void => {
    const arr = previews.get(categoryId) ?? [];
    arr.push(item);
    previews.set(categoryId, arr);
  };

  // The four reads are independent: run together, then folded in the same
  // order as before (preview order depends on it).
  const unreadQ = db
    .selectFrom('email_threads')
    .select('category_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0)
    .where('category_id', 'is not', null)
    .groupBy('category_id')
    .execute();

  // Newest unread subjects per category — the tile-preview filler. Window-
  // ranked so a category whose unread mail is old still gets its lines.
  const ranked = db
    .selectFrom('email_threads')
    .select(['id', 'subject', 'snippet', 'category_id', 'last_message_at'])
    .select(
      sql<number>`row_number() over (partition by category_id order by last_message_at desc)`.as(
        'rn',
      ),
    )
    .where('user_id', '=', userId)
    .where('is_unread', '=', 1)
    .where('is_archived', '=', 0)
    .where('category_id', 'is not', null);
  const newestUnreadQ = db
    .selectFrom(ranked.as('t'))
    .select(['id', 'subject', 'snippet', 'category_id', 'last_message_at'])
    .where('rn', '<=', PREVIEWS_PER_TILE)
    .execute();

  // ADR 0110 — the last resort, and the reason a handled tile does not go
  // blank. Everything above is OPEN work, and acting on an email removes it
  // from all of it at once: the proposal stops being pending and the thread
  // stops being unread in the same gesture. Attention still counts open work
  // only — a dealt-with category should stop shouting, not stop existing.
  const rankedAll = db
    .selectFrom('email_threads')
    .select(['id', 'subject', 'snippet', 'category_id', 'last_message_at'])
    .select(
      sql<number>`row_number() over (partition by category_id order by last_message_at desc)`.as(
        'rn',
      ),
    )
    .where('user_id', '=', userId)
    .where('is_archived', '=', 0)
    .where('category_id', 'is not', null);
  const newestAnyQ = db
    .selectFrom(rankedAll.as('t'))
    .select(['id', 'subject', 'snippet', 'category_id', 'last_message_at'])
    .where('rn', '<=', PREVIEWS_PER_TILE)
    .execute();

  // Email-magic proposals carry provenance `gmail:<threadId>` (ADR 0063) —
  // the only producer of that prefix — so the join back to threads is a
  // string-strip + lookup, no schema link needed.
  const pendingQ = db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'target_group_id', 'provenance', 'created_at'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date().toISOString())
    .where('provenance', 'like', 'gmail:%')
    .execute();

  const [unread, newestUnread, newestAny, pending] = await Promise.all([
    unreadQ,
    newestUnreadQ,
    newestAnyQ,
    pendingQ,
  ]);
  for (const r of unread) {
    attention.set(r.category_id!, Number(r.n));
    unreadCount.set(r.category_id!, Number(r.n));
  }
  for (const t of newestUnread) {
    pushPreview(t.category_id!, {
      kind: 'unread',
      text: t.subject || '(no subject)',
      threadId: t.id,
      snippet: previewSnippet(t.snippet),
      at: t.last_message_at,
    });
  }
  for (const t of newestAny) {
    const seen = latest.get(t.category_id!);
    if (!seen || t.last_message_at > seen) latest.set(t.category_id!, t.last_message_at);
    pushPreview(t.category_id!, {
      kind: 'recent',
      text: t.subject || '(no subject)',
      threadId: t.id,
      snippet: previewSnippet(t.snippet),
      at: t.last_message_at,
    });
  }
  if (pending.length === 0) return { attention, unread: unreadCount, latest, magic, previews };

  const perGmailId = new Map<string, typeof pending>();
  for (const p of pending) {
    const gid = p.provenance!.slice('gmail:'.length);
    const arr = perGmailId.get(gid) ?? [];
    arr.push(p);
    perGmailId.set(gid, arr);
  }
  const threads = await db
    .selectFrom('email_threads')
    .select(['id', 'gmail_thread_id', 'category_id', 'is_unread', 'snippet'])
    .where('user_id', '=', userId)
    .where('is_archived', '=', 0)
    .where('gmail_thread_id', 'in', [...perGmailId.keys()])
    .execute();
  for (const t of threads) {
    if (!t.category_id) continue;
    const proposals = perGmailId.get(t.gmail_thread_id)!;
    magic.set(t.category_id, (magic.get(t.category_id) ?? 0) + proposals.length);
    for (const p of proposals) {
      const suggestion = suggestionFromProposal(p);
      if (suggestion) {
        pushPreview(t.category_id, {
          kind: 'magic',
          text: suggestion.title,
          threadId: t.id,
          snippet: previewSnippet(t.snippet),
          at: p.created_at,
        });
      }
    }
    // Unread threads are already counted; a read thread with a pending
    // suggestion still needs attention — count the thread once.
    if (t.is_unread !== 1) {
      attention.set(t.category_id, (attention.get(t.category_id) ?? 0) + 1);
    }
  }
  return { attention, unread: unreadCount, latest, magic, previews };
}

interface DirectFacts {
  timeline: EmailTimelineFact[];
  state: EmailStateFact[];
  ledger: EmailLedgerFact[];
}

function emptyFacts(): DirectFacts {
  return { timeline: [], state: [], ledger: [] };
}

/** A parent whose own path carries no hint still renders what its converted
 *  descendants resolved to — facts roll up the way counts do. */
function inheritedArchetype(rolled: DirectFacts): EmailTileArchetype | null {
  if (rolled.timeline.length > 0) return 'timeline';
  if (rolled.state.length > 0) return 'state_board';
  if (rolled.ledger.length > 0) return 'ledger';
  return null;
}

/**
 * ADR 0087 — per-category direct facts (not yet rolled up). Timeline from
 * pending event proposals + confirmed gmail-provenance events; state/ledger
 * from fail-closed subject+snippet extract.
 *
 * Scanned only for `hinted` categories: a fact reaches a tile either from its
 * own hinted path or rolled up from a converted descendant, so unhinted
 * categories can't contribute and don't need the read or the regexes.
 */
/**
 * Bounds on what one tiles read decrypts (ADR 0201: every row read here is
 * opened). A mailbox only grows, so "every hinted thread ever" was unbounded;
 * the newest threads within a year carry every fact a tile can show.
 * Email-made events are read only from just before today: a past one is
 * dropped by `stillAhead` anyway.
 */
export const DIRECT_FACTS_MAX_THREADS = 2_000;
export const DIRECT_FACTS_THREAD_DAYS = 365;
export const DIRECT_FACTS_MAX_EVENTS = 500;

async function loadDirectFacts(
  db: Kysely<DB>,
  userId: string,
  hinted: Set<string>,
  nowMs = Date.now(),
): Promise<Map<string, DirectFacts>> {
  const out = new Map<string, DirectFacts>();
  if (hinted.size === 0) return out;
  const bucket = (categoryId: string): DirectFacts => {
    const cur = out.get(categoryId) ?? emptyFacts();
    out.set(categoryId, cur);
    return cur;
  };

  const threads = await db
    .selectFrom('email_threads')
    .select([
      'id',
      'gmail_thread_id',
      'category_id',
      'subject',
      'snippet',
      'from_name',
      'from_email',
      'delivery_json',
      'flight_json',
      'receipt_json',
    ])
    .where('user_id', '=', userId)
    .where('is_archived', '=', 0)
    .where('category_id', 'in', [...hinted])
    .where(
      sql<boolean>`${textInstant('last_message_at')} >= ${new Date(nowMs - DIRECT_FACTS_THREAD_DAYS * 86_400_000).toISOString()}::timestamptz`,
    )
    .orderBy(sql`${textInstant('last_message_at')}`, 'desc')
    .limit(DIRECT_FACTS_MAX_THREADS)
    .execute();
  const threadByGmail = new Map(threads.map((t) => [t.gmail_thread_id, t]));

  const owner = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const utcOffset = owner?.last_tz ? tzToOffset(owner.last_tz) : '+00:00';
  const ledgerFor = (t: (typeof threads)[number]): EmailLedgerFact | null =>
    extractLedgerFact(t.subject, t.snippet, t.from_name, t.from_email, t.id, utcOffset, owner?.last_tz ?? null);

  for (const t of threads) {
    if (!t.category_id) continue;
    const b = bucket(t.category_id);
    // ADR 0135 — a delivery email that states an arrival is a state-board row
    // even when no status WORD appears in it ("your order will arrive
    // Thursday"). The keyword is how we used to detect one; the date is the
    // part worth showing.
    const delivery = t.delivery_json ?? null;
    // ADR 0138 — a flight we parsed out of the mail makes a row on its own,
    // for the same reason a bare ETA does: the identity is the part worth
    // showing, and the keyword was only ever how we noticed.
    const flight = t.flight_json ?? null;
    const status =
      extractStateStatus(t.subject, t.snippet) ??
      flightStateStatus(flight) ??
      (delivery?.etaAt ? 'in_transit' : null);
    if (status) b.state.push(buildStateFact(t.subject || 'Update', status, t.id, delivery, flight));
    const ledger = ledgerFor(t);
    if (ledger) b.ledger.push(ledger);
    // ADR 0160 — a receipt the magics pass read; never owed, so it can only
    // ever add a `paid` row, never override a bill the regex path found.
    const receipt = receiptToLedgerFact(t.receipt_json, t.id, t.from_name ?? 'Receipt');
    if (receipt) b.ledger.push(receipt);
  }

  const pending = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'target_group_id', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('expires_at', '>', new Date(nowMs).toISOString())
    .where('provenance', 'like', 'gmail:%')
    .execute();
  for (const p of pending) {
    const gid = p.provenance!.slice('gmail:'.length);
    const thread = threadByGmail.get(gid);
    if (!thread?.category_id) continue;
    const b = bucket(thread.category_id);
    const suggestion = suggestionFromProposal(p);
    if (suggestion?.kind === 'event' && suggestion.detail) {
      if (stillAhead(suggestion.detail, nowMs, owner?.last_tz ?? null)) {
        b.timeline.push({
          title: suggestion.title,
          at: suggestion.detail,
          threadId: thread.id,
          proposalId: p.id,
        });
      }
    }
    try {
      const args = JSON.parse(p.args_json) as unknown;
      const led = ledgerFromArgs(
        args,
        thread.id,
        ledgerFor(thread)?.merchant ?? thread.from_name ?? 'Charge',
      );
      if (led) b.ledger.push(led);
    } catch {
      /* ignore */
    }
  }

  const events =
    threadByGmail.size === 0
      ? []
      : await db
          .selectFrom('events')
          .select(['title', 'starts_at', 'source_raw_context', 'status'])
          .where('owner_user_id', '=', userId)
          .where('deleted_at', 'is', null)
          .where('source_raw_context', 'like', 'gmail:%')
          // Two days of slack: an all-day or floating start is judged on the
          // owner's local day by stillAhead below, never dropped here.
          .where(
            sql<boolean>`${textInstant('starts_at', owner?.last_tz ?? null)} >= ${new Date(nowMs - 2 * 86_400_000).toISOString()}::timestamptz`,
          )
          .orderBy(sql`${textInstant('starts_at', owner?.last_tz ?? null)}`, 'asc')
          .limit(DIRECT_FACTS_MAX_EVENTS)
          .execute();
  for (const ev of events) {
    if (ev.status === 'cancelled') continue;
    const gid = ev.source_raw_context!.slice('gmail:'.length);
    const thread = threadByGmail.get(gid);
    if (!thread?.category_id) continue;
    if (!stillAhead(ev.starts_at, nowMs, owner?.last_tz ?? null)) continue;
    bucket(thread.category_id).timeline.push({
      title: ev.title,
      at: ev.starts_at,
      threadId: thread.id,
      proposalId: null,
    });
  }

  for (const facts of out.values()) {
    facts.timeline = dedupeTimeline(dropPastTimeline(facts.timeline, nowMs, owner?.last_tz ?? null));
    // ADR 0135 / 0138 — a parcel whose arrival day has gone stops being news,
    // and so does a landed flight. Nobody emails to say either turned up.
    facts.state = dropLandedRows(facts.state, nowMs, owner?.last_tz ?? null);
  }
  return out;
}

/** One tile level: the children of `parentId` (root when null), each with a
 *  subtree-rolled-up thread count. `deep` nests the whole subtree into
 *  `children` so the client can draw the one-rectangle map (ADR 0068). */
export async function getTiles(
  db: Kysely<DB>,
  userId: string,
  parentId: string | null,
  opts?: { deep?: boolean },
): Promise<EmailTileLevel> {
  const [{ cats, childrenOf, directCount }, { attention, unread, latest, magic, previews }] =
    await Promise.all([loadTree(db, userId), loadAttention(db, userId)]);
  const catById = new Map(cats.map((c) => [c.id, c]));
  const hintById = new Map(cats.map((c) => [c.id, pathHint(titlesPath(catById, c.id))]));
  const directFacts = await loadDirectFacts(
    db,
    userId,
    new Set(cats.filter((c) => hintById.get(c.id) !== null).map((c) => c.id)),
  );

  const rollup = (direct: Map<string, number>): ((id: string) => number) => {
    const memo = new Map<string, number>();
    const total = (id: string): number => {
      const cached = memo.get(id);
      if (cached !== undefined) return cached;
      let sum = direct.get(id) ?? 0;
      for (const child of childrenOf.get(id) ?? []) sum += total(child.id);
      memo.set(id, sum);
      return sum;
    };
    return total;
  };
  const subtreeCount = rollup(directCount);
  const subtreeAttention = rollup(attention);
  const subtreeMagic = rollup(magic);
  const subtreeUnread = rollup(unread);
  const latestMemo = new Map<string, string | null>();
  const subtreeLatest = (id: string): string | null => {
    const cached = latestMemo.get(id);
    if (cached !== undefined) return cached;
    let best = latest.get(id) ?? null;
    for (const child of childrenOf.get(id) ?? []) {
      const sub = subtreeLatest(child.id);
      if (sub && (!best || sub > best)) best = sub;
    }
    latestMemo.set(id, best);
    return best;
  };

  // Subtree preview lines: most actionable first, newest first within a kind,
  // capped — so a parent tile surfaces its most actionable descendants.
  const KIND_RANK: Record<EmailTilePreview['kind'], number> = { magic: 0, unread: 1, recent: 2 };
  const previewMemo = new Map<string, PreviewItem[]>();
  const subtreePreview = (id: string): PreviewItem[] => {
    const cached = previewMemo.get(id);
    if (cached) return cached;
    const merged = [...(previews.get(id) ?? [])];
    for (const child of childrenOf.get(id) ?? []) merged.push(...subtreePreview(child.id));
    merged.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.at.localeCompare(a.at));
    // An unread thread is also a recent one, and both lines are its subject —
    // the same text twice is worse than one fewer line. A magic line is NOT a
    // duplicate of either: it carries the suggestion's title, not the subject,
    // so a thread can legitimately contribute one of each.
    const seenSubject = new Set<string>();
    const top: PreviewItem[] = [];
    for (const item of merged) {
      if (item.kind !== 'magic') {
        if (seenSubject.has(item.threadId)) continue;
        seenSubject.add(item.threadId);
      }
      top.push(item);
      if (top.length >= PREVIEWS_PER_TILE) break;
    }
    previewMemo.set(id, top);
    return top;
  };

  const factsMemo = new Map<string, DirectFacts>();
  const subtreeFacts = (id: string): DirectFacts => {
    const cached = factsMemo.get(id);
    if (cached) return cached;
    const own = directFacts.get(id) ?? emptyFacts();
    const ownArch = resolveArchetype(
      hintById.get(id) ?? null,
      own.timeline.length > 0,
      own.state.length > 0,
      own.ledger.length > 0,
    );
    let timeline = ownArch === 'timeline' ? [...own.timeline] : [];
    let state = ownArch === 'state_board' ? [...own.state] : [];
    let ledger = ownArch === 'ledger' ? [...own.ledger] : [];
    for (const child of childrenOf.get(id) ?? []) {
      const sub = subtreeFacts(child.id);
      timeline = mergeTimeline(timeline, sub.timeline);
      state = state.concat(sub.state);
      ledger = ledger.concat(sub.ledger);
    }
    const rolled = { timeline, state, ledger };
    factsMemo.set(id, rolled);
    return rolled;
  };

  const toTile = (c: CatRow, deep: boolean): EmailTile => {
    const preview = subtreePreview(c.id);
    const rolled = subtreeFacts(c.id);
    const archetype =
      resolveArchetype(
        hintById.get(c.id) ?? null,
        rolled.timeline.length > 0,
        rolled.state.length > 0,
        rolled.ledger.length > 0,
      ) ?? inheritedArchetype(rolled);
    let facts: EmailTileFacts | undefined;
    if (archetype === 'timeline') facts = capFacts({ kind: 'timeline', items: rolled.timeline });
    else if (archetype === 'state_board') facts = capFacts({ kind: 'state_board', items: rolled.state });
    else if (archetype === 'ledger') facts = capFacts({ kind: 'ledger', items: rolled.ledger });
    return {
      id: c.id,
      title: c.title,
      count: subtreeCount(c.id),
      attention: subtreeAttention(c.id),
      magicCount: subtreeMagic(c.id),
      unread: subtreeUnread(c.id),
      lastMessageAt: subtreeLatest(c.id),
      hasChildren: (childrenOf.get(c.id)?.length ?? 0) > 0,
      depth: c.depth,
      color: c.color,
      // Classifier-assigned icon wins; otherwise a keyword-matched emoji so
      // tiles too small for their title still read (ADR 0068 addendum).
      icon: c.icon ?? emojiForCategory(c.title),
      ...(preview.length > 0
        ? { preview: preview.map(({ kind, text, threadId, snippet }) => ({
            kind,
            text,
            threadId,
            ...(snippet ? { snippet } : {}),
          })) }
        : {}),
      ...(archetype ? { archetype, facts } : {}),
      ...(deep
        ? { children: (childrenOf.get(c.id) ?? []).map((child) => toTile(child, true)) }
        : {}),
    };
  };

  const levelNodes = childrenOf.get(parentId) ?? [];
  const parentRow = parentId ? cats.find((c) => c.id === parentId) ?? null : null;

  return {
    parent: parentRow ? toTile(parentRow, false) : null,
    tiles: levelNodes.map((c) => toTile(c, opts?.deep === true)),
    // Threads assigned to `parentId` itself (flip-to-list at a leaf); at root,
    // the count of still-unclassified threads so the UI can surface an "Unsorted" pile.
    directThreadCount: parentId
      ? directCount.get(parentId) ?? 0
      : await countUnclassified(db, userId),
  };
}

async function countUnclassified(db: Kysely<DB>, userId: string): Promise<number> {
  const row = await db
    .selectFrom('email_threads')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('category_id', 'is', null)
    .where('is_archived', '=', 0)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/**
 * Case-insensitive match of free-search text against this user's own
 * classifier-assigned category TITLES, at any tree depth — not just leaves.
 * Each path segment is its own category row with its own single-segment
 * title (`classifier-tree.ts`'s `ensurePath`), so a parent's own title is
 * already a real row: matching "friends" against the "Friends & family"
 * parent needs no breadcrumb reconstruction, and its subtree already covers
 * every descendant leaf.
 *
 * Direction matters: this checks whether the CATEGORY TITLE contains the
 * whole query, never the reverse. Matching the other way — a short/generic
 * title like "Mail" being a substring of a long natural-language query —
 * would make an ordinary sentence silently replace text search with a
 * near-arbitrary category. This only fires for the short, name-shaped
 * queries it's meant for ("school", "travel", "school forms").
 *
 * Generic catch-all containers (`CATCH_ALL_LEAVES` — "other", "notes",
 * "misc", ...) are excluded even though they can be real top-level rows
 * (`trimCatchAllLeaf` only ever trims BELOW the top level): a search for
 * "notes" replacing results with someone's entire generic bucket is a worse
 * failure than falling through to keyword search.
 *
 * Multiple matching branches union their subtrees — this is read-only
 * recall, so more genuinely-matching mail is not the write-ambiguity problem
 * ADR 0077/0094/0137 refuse on; there's nothing to refuse here.
 *
 * Returns null when nothing matches (or the query is too short to be worth
 * checking) — the caller's cue to fall through to the unchanged FTS/literal/
 * body-text search. Never throws for an unclassified mailbox: no category
 * rows just means no match, like any other miss.
 */
export async function resolveCategoryMatch(
  db: Kysely<DB>,
  userId: string,
  queryText: string,
): Promise<{ categoryIds: string[]; titles: string[] } | null> {
  const q = queryText.trim().toLowerCase();
  if (q.length < 3) return null;
  const { cats, childrenOf } = await loadCategoryNodes(db, userId);
  const matched = cats.filter((c) => {
    const t = c.title.trim().toLowerCase();
    return !CATCH_ALL_LEAVES.has(t) && t.includes(q);
  });
  if (matched.length === 0) return null;

  const ids = new Set<string>();
  const walk = (id: string): void => {
    ids.add(id);
    for (const child of childrenOf.get(id) ?? []) walk(child.id);
  };
  for (const c of matched) walk(c.id);
  return { categoryIds: [...ids], titles: matched.map((c) => c.title) };
}

/** A category id plus every descendant — the set to filter threads by when the
 *  UI flips a non-leaf node to its thread list. */
export async function categorySubtreeIds(
  db: Kysely<DB>,
  userId: string,
  categoryId: string,
): Promise<string[]> {
  const { childrenOf } = await loadCategoryNodes(db, userId);
  const out: string[] = [];
  const walk = (id: string): void => {
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child.id);
  };
  walk(categoryId);
  return out;
}
