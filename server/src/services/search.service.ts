/**
 * ADR 0059 — unified search across chats, files, and every group-scoped
 * entity, powering the read-only `search` bot tool.
 *
 * Scope follows the ADR 0004 boundary automatically (the caller passes
 * `crossGroup`, derived from `groups.kind === 'personal'`):
 *   - personal 1:1 chat → search every group the user belongs to
 *     (the `/me/*` catchup contract);
 *   - shared group → this group only.
 *
 * Results are trimmed DTOs that carry a human `group` NAME, never a raw
 * `groupId` — cross-group hits would otherwise be dropped by ADR 0032's
 * `scrubCrossGroupLeak` post-filter (which nukes any object whose `groupId`
 * differs from the current group). This mirrors how `find_events` returns
 * cross-group event data safely.
 *
 * Files reuse the ADR 0021 tsvector chunk index for ranked snippets;
 * everything else reuses the existing list services + an in-memory
 * substring filter (demo-scale corpus — same approach as `search_saves`).
 */
import { sql, type Kysely } from 'kysely';
import { hasSearchOperators, parseSearchQuery } from '@chord/kernel';

import type {
  EmailAction,
  SearchEntityType,
  SearchHit,
  SearchResponse,
} from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { instantMs } from '../db/text-instant.js';
import { listAttachmentsForGroup, listAttachmentsForUser } from './attachments.service.js';
import { searchAttachmentChunks } from './attachments.index.js';
import { extractKeywords } from './bot/retrieval.js';
import { literalQueryUsable } from '../utils/keywords.js';
import { resolveCategoryMatch } from './email/classification.service.js';
import { findEmailThreads } from './email/email-search.js';
import { prepareMailQuery, type AskPhoneForRole, type MailFilters, type PersonResolution } from './email/mail-query.js';
import { fuseRanks, semanticFileMatches, semanticThreadMatches } from './search/semantic.js';
import { searchEventsScoped } from './events.service.js';
import { searchListsScoped } from './lists.service.js';
import { inViewOf } from './messages.service.js';
import { listContacts, listMedia, listPlaces } from './personal.service.js';
import { searchSavesScoped } from './saves.service.js';
import { searchTasksScoped } from './tasks.service.js';

/** Categories, singular-keyed, so the tool result reads as JSON the LLM can
 *  summarize per type. `reminders` is tasks with a `remindAt` set. */
export type SearchCategory =
  | 'messages'
  | 'files'
  | 'tasks'
  | 'reminders'
  | 'saves'
  | 'events'
  | 'lists'
  | 'places'
  | 'contacts'
  | 'media'
  /** Mail threads. Personal-scope only, like the user-facing path. */
  | 'emails'
  /** Pending proposals waiting on the user's yes/no. */
  | 'todos';

export interface SearchInput {
  /** Triggering user — the cross-group membership filter. */
  userId: string;
  /** The group the turn came from. Sole scope when `crossGroup` is false. */
  groupId: string;
  /** True in a personal (1:1) chat → search across all the user's groups. */
  crossGroup: boolean;
  query: string;
  /** Restrict to these categories. Omit / empty = all. */
  categories?: SearchCategory[];
  /** Max hits per category. Defaults to 8, hard-capped at 25. */
  perCategory?: number;
  /** ADR 0270: structured mail filters from the bot tool (a person, dates, a kind). */
  mailFilters?: MailFilters;
  /** ADR 0275: ask the user's phone which contacts are a role ("the dentist"). Chat turns only. */
  askPhone?: AskPhoneForRole;
}

/** Every hit carries an in-app `href` (an expo-router path) so the chat can
 *  render it as a tappable card that navigates to the right screen. It's a
 *  plain string — no `groupId` field — so ADR 0032's scrubber leaves it
 *  intact even for cross-group hits from the personal chat. */
interface MessageHit {
  id: string;
  snippet: string;
  from: string;
  group: string;
  createdAt: string;
  href: string;
}
interface FileHit {
  id: string;
  filename: string;
  mimeType: string;
  summary: string | null;
  snippet: string | null;
  group: string;
  href: string;
  /** The email this file arrived with (ADR 0071), when it came by mail. */
  emailSubject?: string;
  emailFrom?: string | null;
  emailHref?: string;
}
interface TaskHit {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  remindAt: string | null;
  group: string;
  href: string;
}
interface SaveHit {
  id: string;
  kind: string;
  title: string;
  url: string | null;
  note: string | null;
  group: string;
  href: string;
}
interface EventHit {
  id: string;
  title: string;
  location: string | null;
  startsAt: string;
  group: string;
  href: string;
}
interface ListHit {
  listId: string;
  listName: string;
  group: string;
  matchedItems: { id: string; text: string; checked: boolean }[];
  href: string;
}
interface PlaceHit {
  id: string;
  name: string;
  note: string | null;
  group: string;
  href: string;
}
interface ContactHit {
  id: string;
  name: string;
  note: string | null;
  group: string;
  href: string;
}
interface MediaHit {
  id: string;
  kind: string;
  title: string;
  note: string | null;
  group: string;
  href: string;
}
interface EmailHit {
  id: string;
  subject: string;
  from: string | null;
  receivedAt: string;
  /** ADR 0086 - what the thread wants from the user, so the bot can answer
   *  "which of these needs a reply" without a second pass. */
  action: EmailAction | null;
  /** The provider's own one-line preview — already selected for matching
   *  (ADR 0110), just never surfaced to a reader before. */
  snippet: string;
  href: string;
  /** The thread's latest sender address (ADR 0270). */
  fromEmail: string | null;
  /** ADR 0276: found by meaning only - none of the query's words are in it. */
  matchedBy?: 'meaning';
}
interface TodoHit {
  id: string;
  title: string;
  group: string;
  href: string;
}

export interface SearchResults {
  query: string;
  scope: 'all-groups' | 'this-group';
  /** ADR 0270: how each person in the question was read; `ambiguous` means ask. */
  people?: PersonResolution[];
  messages: MessageHit[];
  files: FileHit[];
  tasks: TaskHit[];
  reminders: TaskHit[];
  saves: SaveHit[];
  events: EventHit[];
  lists: ListHit[];
  places: PlaceHit[];
  contacts: ContactHit[];
  media: MediaHit[];
  emails: EmailHit[];
  todos: TodoHit[];
  totalHits: number;
}

const DEFAULT_PER_CATEGORY = 8;
const MAX_PER_CATEGORY = 25;

/** In-app expo-router destinations per category (ADR 0059). These couple the
 *  service to the mobile route names deliberately — the catchup tabs are the
 *  canonical per-type views and there are no single-entity detail screens.
 *  Messages route to their own group chat (id filled in per hit). */
const HREF = {
  files: '/catchup/files',
  tasks: '/catchup/tasks',
  saves: '/catchup/saves',
  events: '/calendar',
  lists: '/catchup/lists',
  todos: '/catchup/actions',
} as const;

function includesLower(needle: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
}

export { literalQueryUsable } from '../utils/keywords.js';

type SearchableAttachment = Awaited<ReturnType<typeof listAttachmentsForUser>>[number];

/**
 * Search candidates for files: drop rows whose blob is gone (a hit that can't
 * open is worse than no hit), then keep only the NEWEST copy per (scope,
 * filename) — a re-upload after a loss, or the same document arriving twice,
 * must surface once, as the latest version.
 */
function searchableFiles(attachments: SearchableAttachment[]): SearchableAttachment[] {
  const live = attachments.filter((a) => !a.blobMissing);
  const newest = new Map<string, SearchableAttachment>();
  for (const a of live) {
    const scope = a.scope.kind === 'group' ? a.scope.groupId : a.scope.userId;
    const key = `${scope}|${a.filename.toLowerCase()}`;
    const cur = newest.get(key);
    if (!cur || a.createdAt > cur.createdAt) newest.set(key, a);
  }
  const keep = new Set([...newest.values()].map((a) => a.id));
  return live.filter((a) => keep.has(a.id));
}

/** Resolve which group ids to search + a groupId→name map for labelling. */
async function resolveScope(
  db: Kysely<DB>,
  input: SearchInput,
): Promise<{ groupIds: string[]; groupName: (id: string) => string }> {
  let groupIds: string[];
  if (input.crossGroup) {
    const rows = await db
      .selectFrom('group_members')
      .select('group_id')
      .where('user_id', '=', input.userId)
      .execute();
    groupIds = rows.map((r) => r.group_id);
    if (!groupIds.includes(input.groupId)) groupIds.push(input.groupId);
  } else {
    groupIds = [input.groupId];
  }
  const names = groupIds.length
    ? await db
        .selectFrom('groups')
        .select(['id', 'name'])
        .where('id', 'in', groupIds)
        .execute()
    : [];
  const byId = new Map(names.map((g) => [g.id, g.name]));
  return { groupIds, groupName: (id: string) => byId.get(id) ?? 'Unknown group' };
}

export async function searchEverything(
  db: Kysely<DB>,
  input: SearchInput,
): Promise<SearchResults> {
  // Same parse as the user path, so both surfaces read one query the same
  // way (ADR 0085, applied to the query rather than the matching).
  const parsed = parseSearchQuery(input.query);
  // Mail is read through one shared preparation (ADR 0270): operators, the
  // bot's structured filters and plain "emails from Bill" all become a
  // resolved person plus the remaining topic. Only from the personal 1:1,
  // where mail is searched at all.
  const mail = input.crossGroup
    ? await prepareMailQuery(db, input.userId, input.query, input.mailFilters, { askPhone: input.askPhone })
    : null;
  const ops = hasSearchOperators(parsed) || (mail?.narrowed ?? false);
  const q = parsed.text.toLowerCase().trim();
  // Escape LIKE metacharacters for the SQL (messages) path; the in-memory
  // `.includes` filters treat the query literally already.
  // Same tsquery + literal floor the user-facing path uses, so both surfaces
  // agree on what "matches" means (ADR 0085). Below the floor the literal arm
  // is disabled rather than matching almost every row.
  const tsq = toTsQuery(parsed.text);
  const useLiteral = literalQueryUsable(q);
  const qLike = useLiteral ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : ' nomatch ';
  /** Literal substring test, gated by the same floor as the SQL arm. */
  const literal = (...fields: (string | null | undefined)[]): boolean =>
    useLiteral && includesLower(q, ...fields);
  const cap = Math.min(Math.max(input.perCategory ?? DEFAULT_PER_CATEGORY, 1), MAX_PER_CATEGORY);
  // An operator asks something only mail can answer (ADR 0126).
  const want = (c: SearchCategory): boolean =>
    (!ops || c === 'emails') &&
    (!input.categories || input.categories.length === 0 || input.categories.includes(c));
  // ADR 0271: a mail question still finds the files that came with that mail
  // ("the PDF Bill sent") - narrowed to attachments imported from the matching
  // threads (ADR 0071) rather than switched off.
  const wantMailFiles =
    ops && !!mail && (!input.categories || input.categories.length === 0 || input.categories.includes('files'));

  const { groupIds, groupName } = await resolveScope(db, input);

  const results: SearchResults = {
    query: input.query,
    scope: input.crossGroup ? 'all-groups' : 'this-group',
    messages: [],
    files: [],
    tasks: [],
    reminders: [],
    saves: [],
    events: [],
    lists: [],
    places: [],
    contacts: [],
    media: [],
    emails: [],
    todos: [],
    totalHits: 0,
  };

  // Empty query or no accessible groups → nothing to search. Operator-only
  // queries (`label:Family`) are real queries (ADR 0126).
  if ((!q && !ops) || groupIds.length === 0) return results;

  // ── Messages (chats) ──────────────────────────────────────────────
  if (want('messages')) {
    const rows = await db
      .selectFrom('messages')
      .leftJoin('users', 'users.id', 'messages.sender_id')
      .select([
        'messages.id as id',
        'messages.body as body',
        'messages.group_id as groupId',
        'messages.kind as kind',
        'messages.created_at as createdAt',
        'users.display_name as displayName',
        'users.username as username',
      ])
      .where('messages.group_id', 'in', groupIds)
      .where('messages.chord_visible', '=', 1)
      .where(inViewOf(input.userId))
      .where('messages.kind', '!=', 'system')
      .where((eb) =>
        eb.or([
          ...(tsq ? [eb(sql<boolean>`messages.search_tsv @@ to_tsquery('english', ${tsq})`, '=', true)] : []),
          eb(sql<boolean>`lower(messages.body) like ${qLike} escape '\\'`, '=', true),
        ]),
      )
      .orderBy('messages.created_at', 'desc')
      .limit(cap)
      .execute();
    results.messages = rows.map((r) => ({
      id: r.id,
      snippet: snippetAround(r.body, q),
      from: r.kind === 'bot' ? 'Chord' : r.displayName ?? r.username ?? 'Someone',
      group: groupName(r.groupId),
      createdAt: r.createdAt,
      href: `/groups/${r.groupId}`,
    }));
  }

  // ── Files (attachments) — tsvector snippets + filename/summary fallback ─
  if (want('files')) {
    const attachments = searchableFiles(
      input.crossGroup
        ? await listAttachmentsForUser(db, input.userId)
        : await listAttachmentsForGroup(db, input.groupId),
    );
    const byId = new Map(attachments.map((a) => [a.id, a]));
    const ranked = new Map<string, string | null>(); // attachmentId → snippet
    const keywords = extractKeywords(input.query);
    if (keywords.length > 0 && attachments.length > 0) {
      const hits = await searchAttachmentChunks(db, {
        keywords,
        candidateIds: attachments.map((a) => a.id),
        limit: cap * 3,
        ranking: 'weighted',
      });
      for (const h of hits) {
        if (!ranked.has(h.attachmentId)) ranked.set(h.attachmentId, h.snippet);
      }
    }
    // Filename / summary substring fallback so unindexed files still surface.
    for (const a of attachments) {
      if (ranked.has(a.id)) continue;
      if (literal(a.filename, a.summary)) ranked.set(a.id, null);
    }
    // ADR 0276 — files by meaning, blended by rank with the word matches.
    const sem = parsed.text.trim()
      ? await semanticFileMatches(db, input.userId, parsed.text, { among: attachments.map((a) => a.id), limit: cap * 2 })
      : [];
    const order = sem.length ? fuseRanks([[...ranked.keys()], sem.map((h) => h.id)]) : [...ranked.keys()];
    results.files = order.map((id): [string, string | null] => [id, ranked.get(id) ?? null]).slice(0, cap).flatMap(([id, snippet]) => {
      const a = byId.get(id);
      if (!a) return [];
      return [
        {
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          summary: a.summary ?? null,
          snippet,
          group: a.scope.kind === 'group' ? groupName(a.scope.groupId) : 'Private',
          href: HREF.files,
        },
      ];
    });
  }

  // ── Tasks + reminders (reminders = tasks with remindAt set) ────────
  if (want('tasks') || want('reminders')) {
    // Direct SQL, scoped + matched in one query (searchTasksScoped,
    // tasks.service.ts) — not listTasks(ForUser)'s 200-row recency page
    // intersected against an unscoped FTS id set, which threw away a real
    // FTS match that simply wasn't also on that page.
    const taskScope: { groupId: string } | { crossGroupUserId: string } = input.crossGroup
      ? { crossGroupUserId: input.userId }
      : { groupId: input.groupId };
    // A generous pool, not the display cap: the result below still splits
    // into `tasks` vs `reminders` and caps each separately, same as before.
    const matched = q || ops ? await searchTasksScoped(db, taskScope, { tsq, qLike, cap: 200 }) : [];
    const toHit = (t: (typeof matched)[number]): TaskHit => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.dueAt ?? null,
      remindAt: t.remindAt ?? null,
      group: groupName(t.groupId),
      href: HREF.tasks,
    });
    if (want('reminders')) {
      results.reminders = matched.filter((t) => t.remindAt).slice(0, cap).map(toHit);
    }
    if (want('tasks')) {
      results.tasks = matched.filter((t) => !t.remindAt).slice(0, cap).map(toHit);
    }
  }

  // ── Saves ─────────────────────────────────────────────────────────
  if (want('saves')) {
    // Direct SQL, scoped + matched in one query (searchSavesScoped,
    // saves.service.ts) — not listSaves(ForUser) intersected against an
    // unscoped FTS id set (same fix as tasks above).
    const savesScope: { groupId: string } | { crossGroupUserId: string } = input.crossGroup
      ? { crossGroupUserId: input.userId }
      : { groupId: input.groupId };
    const saves = q || ops ? await searchSavesScoped(db, savesScope, { tsq, qLike, cap }) : [];
    results.saves = saves.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      url: s.url ?? null,
      note: s.note ?? null,
      group: groupName(s.groupId),
      href: HREF.saves,
    }));
  }

  // ── Events ────────────────────────────────────────────────────────
  if (want('events')) {
    // Direct SQL, scoped + matched in one query (searchEventsScoped,
    // events.service.ts) — not listEvents(ForUser)'s ascending-from-2020,
    // 500-row page (the bug this whole pass traces back to).
    const eventsScope: { groupId: string } | { ownerUserId: string } = input.crossGroup
      ? { ownerUserId: input.userId }
      : { groupId: input.groupId };
    const events = useLiteral ? await searchEventsScoped(db, eventsScope, qLike, cap) : [];
    results.events = events.map((e) => ({
      id: e.id,
      title: e.title,
      location: e.location ?? null,
      startsAt: e.startsAt,
      group: groupName(e.groupId),
      href: HREF.events,
    }));
  }

  // ── Lists (names + items) ─────────────────────────────────────────
  if (want('lists')) {
    // Direct SQL, scoped + matched in one query (searchListsScoped,
    // lists.service.ts) — not listLists(ForUser)'s 200-row recency page
    // intersected against unscoped FTS id sets for both lists AND
    // list_items (same fix as tasks/saves above).
    const listsScope: { groupId: string } | { crossGroupUserId: string } = input.crossGroup
      ? { crossGroupUserId: input.userId }
      : { groupId: input.groupId };
    const matchedLists = q || ops ? await searchListsScoped(db, listsScope, { tsq, qLike, cap }) : [];
    const hits: ListHit[] = matchedLists.map((list) => ({
      listId: list.id,
      listName: list.name,
      group: groupName(list.groupId),
      matchedItems: list.items.map((it) => ({
        id: it.id,
        text: it.text,
        checked: it.checked,
      })),
      href: HREF.lists,
    }));
    results.lists = hits;
  }

  // ── Places / contacts / media (group-scoped tables; loop over scope) ──
  if (want('places')) {
    const places = (await Promise.all(groupIds.map((gid) => listPlaces(db, gid)))).flat();
    results.places = places
      .filter((p) => literal(p.name, p.area, p.city, p.note, p.tags.join(' ')))
      .slice(0, cap)
      .map((p) => ({
        id: p.id,
        name: p.name,
        note: p.note ?? null,
        group: groupName(p.groupId),
        href: HREF.saves,
      }));
  }
  if (want('contacts')) {
    const contacts = (await Promise.all(groupIds.map((gid) => listContacts(db, gid)))).flat();
    results.contacts = contacts
      .filter((c) => literal(c.name, c.org, c.family, c.note, c.tags.join(' ')))
      .slice(0, cap)
      .map((c) => ({
        id: c.id,
        name: c.name,
        note: c.note ?? null,
        group: groupName(c.groupId),
        href: HREF.saves,
      }));
  }
  if (want('media')) {
    const media = (await Promise.all(groupIds.map((gid) => listMedia(db, gid)))).flat();
    results.media = media
      .filter((m) => literal(m.title, m.note))
      .slice(0, cap)
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        title: m.title,
        note: m.note ?? null,
        group: groupName(m.groupId),
        href: HREF.saves,
      }));
  }

  // Email is personal data with no group of its own, so it is searched ONLY
  // from the personal 1:1 (`crossGroup`). In a shared group the bot answering
  // with a member's private mail would be a scope leak, not a feature.
  if (want('emails') && mail) {
    // A query naming one of the user's own classifier-assigned categories
    // (e.g. "school") is trusted over keyword matching entirely, rather than
    // unioned with it — the classifier already read the mail and decided what
    // it's about, which is exactly the judgment a literal substring/FTS match
    // over subject/snippet/body lacks. No category match falls through to the
    // ordinary rule. Everything else (words, literals, operators) is one
    // implementation shared with the search box (ADR 0201).
    const topic = mail.find.text.toLowerCase().trim();
    const categoryMatch = topic ? await resolveCategoryMatch(db, input.userId, topic) : null;
    results.people = mail.people.length ? mail.people : undefined;
    const keyword = mail.blocked
      ? []
      : await findEmailThreads(db, {
          ...mail.find,
          userId: input.userId,
          categoryIds: categoryMatch?.categoryIds ?? null,
          limit: cap,
          order: 'rank',
        });
    let found = keyword;
    const byMeaning = new Set<string>();
    // ADR 0276 — and by meaning: the topic's closest threads, under the same
    // person / date / kind filters, blended with the keyword list by rank.
    if (!mail.blocked && topic) {
      const among = mail.narrowed
        ? (await findEmailThreads(db, { ...mail.find, text: '', userId: input.userId, limit: 2000, order: 'recent' })).map((r) => r.id)
        : null;
      const sem = await semanticThreadMatches(db, input.userId, mail.find.text, { among, limit: cap * 2 });
      if (sem.length > 0) {
        const semRows = await findEmailThreads(db, {
          ...mail.find,
          text: '',
          userId: input.userId,
          onlyIds: sem.map((h) => h.id),
          limit: sem.length,
          order: 'recent',
        });
        const rows = new Map([...keyword, ...semRows].map((r) => [r.id, r]));
        const wordIds = new Set(keyword.map((r) => r.id));
        const semIds = sem.map((h) => h.id).filter((id) => rows.has(id));
        for (const id of semIds) if (!wordIds.has(id)) byMeaning.add(id);
        found = fuseRanks([keyword.map((r) => r.id), semIds])
          .slice(0, cap)
          .map((id) => rows.get(id)!);
      }
    }
    results.emails = found.map((r) => ({
      id: r.id,
      subject: r.subject || '(no subject)',
      from: r.fromName ?? r.fromEmail,
      receivedAt: r.lastMessageAt,
      action: r.action ?? null,
      snippet: r.snippet ?? '',
      href: `/email/${r.id}`,
      fromEmail: r.fromEmail,
      ...(byMeaning.has(r.id) ? { matchedBy: 'meaning' as const } : {}),
    }));
  }

  if (wantMailFiles && mail && !mail.blocked) {
    const threads = await findEmailThreads(db, {
      ...mail.find,
      text: '',
      userId: input.userId,
      limit: 200,
      order: 'recent',
    });
    const byThread = new Map(threads.map((t) => [t.id, t]));
    const attachments = searchableFiles(await listAttachmentsForUser(db, input.userId)).filter(
      (a) => a.originEmailThreadId && byThread.has(a.originEmailThreadId),
    );
    let chosen = attachments;
    const keywords = extractKeywords(mail.find.text);
    if (keywords.length > 0 && attachments.length > 0) {
      const hits = await searchAttachmentChunks(db, {
        keywords,
        candidateIds: attachments.map((a) => a.id),
        limit: cap * 3,
        ranking: 'weighted',
      });
      const order = [...new Set(hits.map((h) => h.attachmentId))];
      const byId = new Map(attachments.map((a) => [a.id, a]));
      chosen = order.map((id) => byId.get(id)!).filter(Boolean);
    } else {
      chosen = [...attachments].sort((a, b) => instantMs(b.createdAt) - instantMs(a.createdAt));
    }
    results.files = chosen.slice(0, cap).map((a) => {
      const t = byThread.get(a.originEmailThreadId!)!;
      return {
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        summary: a.summary ?? null,
        snippet: null,
        group: 'Private',
        href: HREF.files,
        emailSubject: t.subject || '(no subject)',
        emailFrom: t.fromName ?? t.fromEmail,
        emailHref: `/email/${t.id}`,
      };
    });
  }

  if (want('todos')) {
    const rows = await db
      .selectFrom('proposals')
      .select(['id', 'group_id', 'tool_name', 'args_json', 'created_at'])
      .where('group_id', 'in', groupIds)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    results.todos = rows
      .map((r) => ({
        id: r.id,
        title: proposalLabel(r.tool_name, r.args_json),
        groupId: r.group_id,
      }))
      .filter((t) => literal(t.title))
      .slice(0, cap)
      .map((t) => ({
        id: t.id,
        title: t.title,
        group: groupName(t.groupId),
        href: HREF.todos,
      }));
  }

  results.totalHits =
    results.messages.length +
    results.files.length +
    results.tasks.length +
    results.reminders.length +
    results.saves.length +
    results.events.length +
    results.lists.length +
    results.places.length +
    results.contacts.length +
    results.media.length +
    results.emails.length +
    results.todos.length;

  return results;
}

/** A ~160-char window centred on the first match, so long messages don't
 *  dump their whole body into the tool result. */
function snippetAround(body: string, needleLower: string, radius = 70): string {
  const idx = body.toLowerCase().indexOf(needleLower);
  if (idx < 0 || body.length <= radius * 2) return body.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(body.length, idx + needleLower.length + radius);
  return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
}

// ── ADR 0062 — user-facing FTS search (flat ranked SearchHit list) ──────────
//
// Backed by the migration-020 generated tsvectors + GIN indexes, versus the
// bot-facing `searchEverything` above (in-memory filter). Runs one FTS query
// per entity type (scope- and visibility-gated), then merges + ranks in JS —
// the `UNION ALL`-style the release plan calls for, kept as separate queries so
// each entity's visibility rule stays legible.

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

const HREF_HIT = {
  task: '/catchup/tasks',
  list: '/catchup/lists',
  save: '/catchup/saves',
  file: '/catchup/files',
  todo: '/catchup/actions',
} as const;

const HEADLINE = 'MaxFragments=1, MaxWords=18, MinWords=5, ShortWord=2';

/** Prose → Postgres `to_tsquery` input: keep ≥3-char alnum tokens, prefix-match
 *  and OR them (tolerant recall, same shape as the attachment FTS). */
export function toTsQuery(query: string): string | null {
  const cleaned = extractKeywords(query)
    .map((k) => k.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase())
    .filter((k) => k.length >= 3);
  return cleaned.length ? cleaned.map((k) => `${k}:*`).join(' | ') : null;
}

/** Normalize the `types` query param (`?types=message,task` or repeated
 *  `?types=message&types=task`) into a string[] for `SearchRequest` to validate;
 *  `undefined` when absent (= all types). */
export function parseSearchTypes(raw: unknown): string[] | undefined {
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(String);
  return undefined;
}

export interface SearchHitsInput {
  userId: string;
  groupId: string;
  crossGroup: boolean;
  query: string;
  types?: SearchEntityType[];
  limit?: number;
}

export async function searchHits(
  db: Kysely<DB>,
  input: SearchHitsInput,
): Promise<SearchResponse> {
  const scope: SearchResponse['scope'] = input.crossGroup ? 'all-groups' : 'this-group';
  // ADR 0126 - operators come out of the query before anything reads it, so
  // "from:mom dinner" searches for "dinner" rather than for the literal
  // "from:mom", on both surfaces.
  const parsed = parseSearchQuery(input.query);
  const mail = input.crossGroup ? await prepareMailQuery(db, input.userId, input.query) : null;
  const ops = hasSearchOperators(parsed) || (mail?.narrowed ?? false);
  const raw = parsed.text.toLowerCase().trim();
  const { groupIds, groupName } = await resolveScope(db, input);
  if ((!raw && !ops) || groupIds.length === 0) return { query: input.query, scope, hits: [] };

  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const want = (t: SearchEntityType) =>
    // An operator asks something only mail can answer, so it narrows the
    // search rather than leaving unfiltered tasks beside filtered mail.
    (!ops || t === 'email') &&
    (!input.types || input.types.length === 0 || input.types.includes(t));
  // A query with no FTS-usable tokens ("512", "Q4") used to return nothing at
  // all here. Substituting a sentinel that matches nothing keeps
  // ts_rank_cd/ts_headline valid while the literal arm does the work - the same
  // FTS-OR-literal rule the bot path uses (ADR 0085). When neither arm is
  // usable ("a", stopwords only) there is nothing to search for.
  const tsqReal = toTsQuery(parsed.text);
  const useLiteral = literalQueryUsable(raw);
  if (!tsqReal && !useLiteral && !ops) return { query: input.query, scope, hits: [] };
  const tsq = tsqReal ?? 'zzz_no_fts_match_zzz';
  // A non-matching pattern keeps the OR arm harmless without branching the
  // SQL. The sentinel is 0x01 rather than 0x00 because Postgres refuses a
  // NUL byte in a text parameter, and an ADR 0126 operator with no free
  // text reaches this branch for the first time.
  const qLike = useLiteral ? `%${raw.replace(/[\\%_]/g, '\\$&')}%` : 'nomatch';
  const q = sql<string>`to_tsquery('english', ${tsq})`;
  const hits: SearchHit[] = [];

  // ── Messages ──
  if (want('message')) {
    const rows = await db
      .selectFrom('messages as m')
      .leftJoin('users as u', 'u.id', 'm.sender_id')
      .select([
        'm.id as id',
        'm.group_id as groupId',
        'm.kind as kind',
        'm.created_at as createdAt',
        'u.display_name as displayName',
        'u.username as username',
        sql<number>`ts_rank_cd(m.search_tsv, ${q})`.as('score'),
        sql<string>`ts_headline('english', m.body, ${q}, ${HEADLINE})`.as('snippet'),
      ])
      .where('m.group_id', 'in', groupIds)
      .where('m.chord_visible', '=', 1)
      .where(inViewOf(input.userId, 'm'))
      .where('m.kind', '!=', 'system')
      .where(sql<boolean>`(m.search_tsv @@ ${q} OR lower(m.body) like ${qLike} escape '\\')`)
      .orderBy('score', 'desc')
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .execute();
    for (const r of rows) {
      hits.push({
        entityType: 'message',
        entityId: r.id,
        groupId: r.groupId,
        groupName: groupName(r.groupId),
        title: r.kind === 'bot' ? 'Chord' : r.displayName ?? r.username ?? 'Someone',
        snippet: r.snippet,
        href: `/groups/${r.groupId}`,
        createdAt: r.createdAt,
        score: Number(r.score),
      });
    }
  }

  // ── Tasks (hide archived/superseded) ──
  if (want('task')) {
    const rows = await db
      .selectFrom('tasks as t')
      .select([
        't.id as id',
        't.group_id as groupId',
        't.title as title',
        't.created_at as createdAt',
        sql<number>`ts_rank_cd(t.search_tsv, ${q})`.as('score'),
        sql<string>`ts_headline('english', coalesce(t.title,'') || ' ' || coalesce(t.details,''), ${q}, ${HEADLINE})`.as(
          'snippet',
        ),
      ])
      .where('t.group_id', 'in', groupIds)
      .where('t.status', 'not in', ['archived', 'superseded'])
      .where(sql<boolean>`(t.search_tsv @@ ${q} OR lower(coalesce(t.title,'') || ' ' || coalesce(t.details,'')) like ${qLike} escape '\\')`)
      .orderBy('score', 'desc')
      .orderBy('t.created_at', 'desc')
      .limit(limit)
      .execute();
    for (const r of rows) {
      hits.push({
        entityType: 'task',
        entityId: r.id,
        groupId: r.groupId,
        groupName: groupName(r.groupId),
        title: r.title,
        snippet: r.snippet,
        href: HREF_HIT.task,
        createdAt: r.createdAt,
        score: Number(r.score),
      });
    }
  }

  // ── Saves ──
  if (want('save')) {
    const rows = await db
      .selectFrom('saves as s')
      .select([
        's.id as id',
        's.group_id as groupId',
        's.title as title',
        's.created_at as createdAt',
        sql<number>`ts_rank_cd(s.search_tsv, ${q})`.as('score'),
        sql<string>`ts_headline('english', coalesce(s.title,'') || ' ' || coalesce(s.note,''), ${q}, ${HEADLINE})`.as(
          'snippet',
        ),
      ])
      .where('s.group_id', 'in', groupIds)
      .where(sql<boolean>`(s.search_tsv @@ ${q} OR lower(coalesce(s.title,'') || ' ' || coalesce(s.note,'')) like ${qLike} escape '\\')`)
      .orderBy('score', 'desc')
      .orderBy('s.created_at', 'desc')
      .limit(limit)
      .execute();
    for (const r of rows) {
      hits.push({
        entityType: 'save',
        entityId: r.id,
        groupId: r.groupId,
        groupName: groupName(r.groupId),
        title: r.title,
        snippet: r.snippet,
        href: HREF_HIT.save,
        createdAt: r.createdAt,
        score: Number(r.score),
      });
    }
  }

  // ── Lists (name match, or a matching item's text) ──
  if (want('list')) {
    const rows = await db
      .selectFrom('lists as l')
      .leftJoin('list_items as li', (j) =>
        j
          .onRef('li.list_id', '=', 'l.id')
          .on(sql<boolean>`(li.search_tsv @@ ${q} OR lower(li.text) like ${qLike} escape '\\')`),
      )
      .select([
        'l.id as id',
        'l.group_id as groupId',
        'l.name as name',
        'l.created_at as createdAt',
        sql<number>`greatest(ts_rank_cd(l.search_tsv, ${q}), coalesce(max(ts_rank_cd(li.search_tsv, ${q})), 0))`.as(
          'score',
        ),
        sql<
          string | null
        >`ts_headline('english', coalesce(max(li.text), l.name), ${q}, ${HEADLINE})`.as('snippet'),
      ])
      .where('l.group_id', 'in', groupIds)
      .where(
        sql<boolean>`(l.search_tsv @@ ${q} OR lower(l.name) like ${qLike} escape '\\' OR li.id IS NOT NULL)`,
      )
      // Group by the PK only — Postgres treats the other l.* columns as
      // functionally dependent, so they need not be listed.
      .groupBy('l.id')
      .orderBy('score', 'desc')
      .orderBy('l.created_at', 'desc')
      .limit(limit)
      .execute();
    for (const r of rows) {
      hits.push({
        entityType: 'list',
        entityId: r.id,
        groupId: r.groupId,
        groupName: groupName(r.groupId),
        title: r.name,
        snippet: r.snippet ?? r.name,
        href: HREF_HIT.list,
        createdAt: r.createdAt,
        score: Number(r.score),
      });
    }
  }

  // ── Files — reuse the ADR 0021 attachment chunk index for ranked snippets;
  //    fall back to filename/summary. Scored into the same rough band as the
  //    text entities (normalization is a documented follow-up).
  if (want('file')) {
    const attachments = searchableFiles(
      input.crossGroup
        ? await listAttachmentsForUser(db, input.userId)
        : await listAttachmentsForGroup(db, input.groupId),
    );
    const byId = new Map(attachments.map((a) => [a.id, a]));
    const ranked = new Map<string, string | null>();
    const keywords = extractKeywords(input.query);
    if (keywords.length && attachments.length) {
      const chunkHits = await searchAttachmentChunks(db, {
        keywords,
        candidateIds: attachments.map((a) => a.id),
        limit: limit * 2,
        ranking: 'weighted',
      });
      for (const h of chunkHits) if (!ranked.has(h.attachmentId)) ranked.set(h.attachmentId, h.snippet);
    }
    for (const a of attachments) {
      if (ranked.has(a.id)) continue;
      if (includesLower(input.query.toLowerCase().trim(), a.filename, a.summary)) ranked.set(a.id, null);
    }
    let i = 0;
    for (const [aid, snippet] of ranked) {
      const a = byId.get(aid);
      if (!a) continue;
      hits.push({
        entityType: 'file',
        entityId: a.id,
        groupId: a.scope.kind === 'group' ? a.scope.groupId : input.groupId,
        groupName: a.scope.kind === 'group' ? groupName(a.scope.groupId) : 'Private',
        title: a.filename,
        snippet: snippet ?? a.summary ?? a.filename,
        href: HREF_HIT.file,
        createdAt: a.createdAt,
        score: Math.max(0.05, 0.5 - i * 0.01), // rank-ordered band; see ADR 0062
      });
      i++;
      if (i >= limit) break;
    }
  }

  // ── Email — personal data with no group of its own. Deliberately searched
  //    ONLY from the personal 1:1 scope: surfacing a user's mail inside a
  //    shared group's search would push private content into a shared context,
  //    which is exactly what ADR 0032 exists to prevent. Hits are attributed to
  //    the personal group, which `crossGroup` guarantees is `input.groupId`.
  if (want('email') && mail && !mail.blocked) {
    // Same replace-not-union rule as `searchEverything`: a query naming one
    // of the user's own classifier categories is trusted over keyword
    // matching, not unioned with it.
    const topic = mail.find.text.toLowerCase().trim();
    const categoryMatch = topic.length > 0 ? await resolveCategoryMatch(db, input.userId, topic) : null;
    const rows = await findEmailThreads(db, {
      ...mail.find,
      userId: input.userId,
      categoryIds: categoryMatch?.categoryIds ?? null,
      limit,
      order: 'rank',
      withHeadline: true,
    });
    // A category match is filed there by topic, not by word — the word score and
    // the highlight legitimately say near-nothing for it, which would sink
    // these hits under the cross-entity sort below or past `limit`. Same
    // synthetic rank-ordered band as the `file`/`todo` arms above, which have
    // the same "no natural FTS score" shape.
    const categoryLabel = categoryMatch ? `Filed under "${categoryMatch.titles.join('", "')}"` : '';
    let emailIdx = 0;
    for (const r of rows) {
      hits.push({
        entityType: 'email',
        entityId: r.id,
        groupId: input.groupId,
        groupName: 'Email',
        title: r.subject || r.fromName || r.fromEmail || '(no subject)',
        snippet: categoryMatch ? categoryLabel : r.headline,
        href: `/email/${r.id}`,
        createdAt: r.lastMessageAt,
        score: categoryMatch ? Math.max(0.05, 0.4 - emailIdx * 0.01) : r.score,
      });
      emailIdx++;
    }
  }

  // ── To-dos (pending proposals) — no tsvector: they are bounded (they expire)
  //    and their text lives inside args_json, so a generated column would index
  //    JSON keys alongside the content. An in-memory keyword filter over a small
  //    set is both cheaper and more accurate here.
  if (want('todo')) {
    const rows = await db
      .selectFrom('proposals as p')
      .select(['p.id as id', 'p.group_id as groupId', 'p.tool_name as toolName', 'p.args_json as argsJson', 'p.created_at as createdAt'])
      .where('p.group_id', 'in', groupIds)
      .where('p.status', '=', 'pending')
      .orderBy('p.created_at', 'desc')
      .limit(200)
      .execute();
    const needle = input.query.toLowerCase().trim();
    const keywords = extractKeywords(input.query);
    let i = 0;
    for (const r of rows) {
      const label = proposalLabel(r.toolName, r.argsJson);
      const hay = label.toLowerCase();
      const matched =
        (needle.length > 0 && hay.includes(needle)) || keywords.some((k) => hay.includes(k));
      if (!matched) continue;
      hits.push({
        entityType: 'todo',
        entityId: r.id,
        groupId: r.groupId,
        groupName: groupName(r.groupId),
        title: label,
        snippet: label,
        href: HREF_HIT.todo,
        createdAt: r.createdAt,
        score: Math.max(0.05, 0.5 - i * 0.01), // same rank-ordered band as files
      });
      i++;
      if (i >= limit) break;
    }
  }

  hits.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  return { query: input.query, scope, hits: hits.slice(0, limit) };
}

/** Human label for a pending proposal, pulled out of its tool args. Falls back
 *  to the tool name so an unrecognised proposal is still findable. */
export function proposalLabel(toolName: string, argsJson: string): string {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    for (const key of ['title', 'text', 'name', 'body', 'query']) {
      const v = args[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* fall through to the tool name */
  }
  return toolName.replace(/_/g, ' ');
}
