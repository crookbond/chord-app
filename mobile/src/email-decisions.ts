/**
 * ADR 0083 - client helpers for the Email AI decision shell: subtree walks,
 * decision-count weights, same-kind batching, and local Not-now deferrals.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmailDecision, EmailTile, EmailTilePreview } from '@chord/kernel';

const NOT_NOW_KEY = 'email.decisions.notNow.v1';

/** Map of proposalId → ISO expiry (when the hide should lift). */
type NotNowMap = Record<string, string>;

export async function loadNotNow(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(NOT_NOW_KEY);
    if (!raw) return new Set();
    const map = JSON.parse(raw) as NotNowMap;
    const now = Date.now();
    const live: NotNowMap = {};
    for (const [id, until] of Object.entries(map)) {
      if (Date.parse(until) > now) live[id] = until;
    }
    if (Object.keys(live).length !== Object.keys(map).length) {
      void AsyncStorage.setItem(NOT_NOW_KEY, JSON.stringify(live));
    }
    return new Set(Object.keys(live));
  } catch {
    return new Set();
  }
}

/** Hide a decision until `untilIso` (typically the proposal's 72h expiry). */
export async function deferNotNow(proposalId: string, untilIso: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(NOT_NOW_KEY);
    const map = (raw ? (JSON.parse(raw) as NotNowMap) : {}) ?? {};
    map[proposalId] = untilIso;
    await AsyncStorage.setItem(NOT_NOW_KEY, JSON.stringify(map));
  } catch {
    /* best-effort */
  }
}

/** Collect every category id under `root` (inclusive). */
export function collectSubtreeIds(root: EmailTile): Set<string> {
  const out = new Set<string>();
  const walk = (t: EmailTile): void => {
    out.add(t.id);
    for (const c of t.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** Find a tile (any depth) in a deep level by id. */
export function findTile(tiles: EmailTile[], id: string): EmailTile | null {
  for (const t of tiles) {
    if (t.id === id) return t;
    const hit = findTile(t.children ?? [], id);
    if (hit) return hit;
  }
  return null;
}

/**
 * Prune tiles (and their descendants, recursively) whose subtree holds no
 * mail at all — a classifier category the tree created but nothing (or
 * nothing left) is filed under. `count` is already a subtree rollup, so a
 * zero there means the WHOLE branch is empty, not just this node; a parent
 * with real mail in some other child keeps its own count unaffected, since
 * the pruned sibling was contributing zero to that rollup anyway. Map is the
 * only consumer — there's no reason to spend treemap space on a tile with
 * nothing in it.
 */
export function nonEmptyTiles(tiles: EmailTile[]): EmailTile[] {
  return tiles
    .filter((t) => t.count > 0)
    .map((t) => (t.children ? { ...t, children: nonEmptyTiles(t.children) } : t));
}

/** One leaf category's recent-mail fallback (ADR 0110). */
export interface CategoryRecent {
  id: string;
  title: string;
  preview: EmailTilePreview[];
  unread: number;
  lastMessageAt: string | null;
}

/**
 * Leaf categories carrying a preview line (ADR 0110's "recent" fallback —
 * the last resort below pending magics and unread subjects, the reason a
 * handled tile does not go blank). Map already reads this straight off its
 * own tile tree; Cards/Sections/Feed are built from `decisions` alone, so a
 * category with zero OPEN decisions dropped out of them entirely instead of
 * falling back to what Map already shows. Leaves only - an ancestor's own
 * `preview` is a subtree roll-up of the same threads its children already
 * carry, and walking both would show a category's recent mail twice.
 */
export function leafRecents(tiles: EmailTile[]): CategoryRecent[] {
  const out: CategoryRecent[] = [];
  const walk = (t: EmailTile): void => {
    const kids = t.children ?? [];
    if (kids.length === 0) {
      if (t.preview && t.preview.length > 0) {
        out.push({
          id: t.id,
          title: t.title,
          preview: t.preview,
          unread: t.unread ?? 0,
          lastMessageAt: t.lastMessageAt ?? null,
        });
      }
      return;
    }
    for (const c of kids) walk(c);
  };
  for (const t of tiles) walk(t);
  return out;
}

/**
 * Each category's top-level parent title (ADR 0292), by id and by title, so
 * Feed and Cards can group a subcategory under it. A top-level category maps
 * to itself; a title used under two parents maps by title to the first.
 */
export function categoryParents(tiles: EmailTile[]): {
  byId: Map<string, string>;
  byTitle: Map<string, string>;
} {
  const byId = new Map<string, string>();
  const byTitle = new Map<string, string>();
  const walk = (t: EmailTile, root: string): void => {
    byId.set(t.id, root);
    const k = t.title.trim().toLowerCase();
    if (!byTitle.has(k)) byTitle.set(k, root);
    for (const c of t.children ?? []) walk(c, root);
  };
  for (const t of tiles) walk(t, t.title);
  return { byId, byTitle };
}

/** Direct decision counts per category id (unsorted omitted). */
export function directDecisionCounts(decisions: EmailDecision[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of decisions) {
    if (!d.categoryId) continue;
    m.set(d.categoryId, (m.get(d.categoryId) ?? 0) + 1);
  }
  return m;
}

/** Roll direct counts up a tile tree so each node includes descendants. */
export function subtreeDecisionCounts(
  tiles: EmailTile[],
  direct: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (t: EmailTile): number => {
    let sum = direct.get(t.id) ?? 0;
    for (const c of t.children ?? []) sum += walk(c);
    out.set(t.id, sum);
    return sum;
  };
  for (const t of tiles) walk(t);
  return out;
}

export interface DecisionBatch {
  key: string;
  kind: 'event' | 'list' | 'task';
  /** Shared list name for list batches; null otherwise. */
  listName: string | null;
  items: EmailDecision[];
}

/**
 * Group decisions for a sheet: events together, tasks together, lists by
 * listName. Task-kind decisions (ADR 0132) were never grouped here — they
 * fell through both filters and vanished from the sheet entirely, so a tile
 * badge could read "1" over an empty "Nothing owed" body.
 */
export function batchDecisions(decisions: EmailDecision[]): DecisionBatch[] {
  const events = decisions.filter((d) => d.kind === 'event');
  const tasks = decisions.filter((d) => d.kind === 'task');
  const lists = decisions.filter((d) => d.kind === 'list');
  const out: DecisionBatch[] = [];
  if (events.length > 0) {
    out.push({ key: 'event', kind: 'event', listName: null, items: events });
  }
  if (tasks.length > 0) {
    out.push({ key: 'task', kind: 'task', listName: null, items: tasks });
  }
  const byList = new Map<string, EmailDecision[]>();
  for (const d of lists) {
    const name = d.detail ?? 'List';
    const arr = byList.get(name) ?? [];
    arr.push(d);
    byList.set(name, arr);
  }
  for (const [name, items] of byList) {
    out.push({ key: `list:${name}`, kind: 'list', listName: name, items });
  }
  return out;
}

/**
 * One unit per feed row (ADR 0146): list items sharing a name still batch
 * (the "Add all to Costco" affordance), but a lone event or task stands on
 * its own — lumping every event, or every task, across every category into
 * one card is right for a per-category sheet and wrong for a flat feed
 * ranked by urgency, since it would erase the very ordering the feed exists
 * to show.
 */
export function feedUnits(decisions: EmailDecision[]): DecisionBatch[] {
  const byList = new Map<string, EmailDecision[]>();
  const out: DecisionBatch[] = [];
  for (const d of decisions) {
    // ADR 0248 - change cards live beside their email, not in the feed.
    if (d.kind === 'change') continue;
    if (d.kind !== 'list') {
      out.push({ key: d.proposalId, kind: d.kind, listName: null, items: [d] });
      continue;
    }
    const name = d.detail ?? 'List';
    const arr = byList.get(name) ?? [];
    arr.push(d);
    byList.set(name, arr);
  }
  for (const [name, items] of byList) {
    out.push({ key: `list:${name}`, kind: 'list', listName: name, items });
  }
  return out;
}

const BOOSTED = /famil|friend|school|kid|child|personal|home/i;
const DAMPED = /newsletter|social|professional|promo|marketing|deal|offer|news/i;

/**
 * Family/school outrank marketing, whether the mail has a due date or not
 * (ADR 0083's tile-area ranking, shared here so the feed's ordering can't
 * drift from the map's).
 */
export function categoryUsefulness(title: string | null | undefined): number {
  const t = title ?? '';
  if (BOOSTED.test(t)) return 1.75;
  if (DAMPED.test(t)) return 0.35;
  return 1;
}

/**
 * `EmailDecision.dueAt` is only ever populated for `event` kind — a task's
 * due date rides `detail` instead (list `detail` is a name, not a date;
 * `Date.parse` on it reliably fails to a NaN this function already filters).
 * Reading `dueAt` alone here would rank every task as undated regardless of
 * its real deadline, which is most of what this function exists to sort.
 */
export function unitDueDate(i: EmailDecision): string | null {
  if (i.kind === 'event') return i.dueAt;
  if (i.kind === 'task') return i.detail;
  return null;
}

/**
 * Earliest due date first; undated units follow, ranked family-first. A due
 * date is the clearest urgency signal there is, so it always outranks a
 * merely-useful category — "renew library card" beats "newsletter roundup"
 * only once nothing in the feed is actually due.
 */
export function sortFeedUnits(units: DecisionBatch[]): DecisionBatch[] {
  const dueOf = (u: DecisionBatch): number => {
    const dates = u.items
      .map((i) => {
        const d = unitDueDate(i);
        return d ? Date.parse(d) : NaN;
      })
      .filter((t) => Number.isFinite(t));
    return dates.length > 0 ? Math.min(...dates) : Infinity;
  };
  const usefulnessOf = (u: DecisionBatch): number => categoryUsefulness(u.items[0]?.categoryTitle);
  return [...units].sort((a, b) => {
    const da = dueOf(a);
    const db = dueOf(b);
    if (da !== db) return da - db;
    if (da !== Infinity) return 0;
    return usefulnessOf(b) - usefulnessOf(a);
  });
}

export interface CategoryGroup {
  title: string;
  count: number;
  units: DecisionBatch[];
}

/**
 * Decisions grouped by their source thread's category, ranked family-first /
 * marketing-last then by how much is open (ADR 0146's "Cards" view). Reads
 * `categoryTitle` straight off the decisions themselves — no tile tree fetch
 * needed, since the feed already carries everything a flat card list wants.
 */
export function groupByCategory(decisions: EmailDecision[]): CategoryGroup[] {
  const byTitle = new Map<string, EmailDecision[]>();
  for (const d of decisions) {
    const title = d.categoryTitle ?? 'Unsorted';
    const arr = byTitle.get(title) ?? [];
    arr.push(d);
    byTitle.set(title, arr);
  }
  return [...byTitle.entries()]
    .map(([title, items]) => ({ title, count: items.length, units: feedUnits(items) }))
    .sort((a, b) => categoryUsefulness(b.title) - categoryUsefulness(a.title) || b.count - a.count);
}

const KIND_LABEL: Record<DecisionBatch['kind'], string> = {
  task: 'To-dos',
  event: 'Events',
  list: 'Lists',
};
const KIND_ORDER: DecisionBatch['kind'][] = ['task', 'event', 'list'];

export interface KindGroup {
  kind: DecisionBatch['kind'];
  label: string;
  units: DecisionBatch[];
}

/**
 * Decisions grouped by kind rather than topic (ADR 0146's "Sections" view).
 * Every open decision is already something Chord found to *do* — there's no
 * "reply needed" or "FYI" bucket among them, since a decision only exists
 * once a magic proposal was staged, not for every classified thread — so
 * this groups by what kind of action it is, not by ADR 0086's action axis.
 */
export function groupByKind(decisions: EmailDecision[]): KindGroup[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    label: KIND_LABEL[kind],
    units: feedUnits(decisions.filter((d) => d.kind === kind)),
  })).filter((g) => g.units.length > 0);
}

export interface FeedRows {
  /** Flat, earliest-due-first — unchanged from the feed's original shape. */
  dated: DecisionBatch[];
  /** Once nothing is due, default to the same kind-grouped view Sections
   *  already uses rather than a flat list ranked by category alone — a due
   *  date is still the strongest signal there is, so it keeps the dated
   *  units flat and ungrouped; it's only the undated remainder that gets
   *  Sections' structure. */
  undatedGroups: KindGroup[];
}

/**
 * Splits the feed in two: dated decisions stay a flat urgency-ranked list,
 * undated ones fall back to Sections' To-dos/Events/Lists grouping instead
 * of `sortFeedUnits`'s flat family-first/marketing-last ranking - "what's
 * most urgent" has nothing left to say once nothing is due, and "what kind
 * of thing is this" is a more useful default at that point.
 */
export function feedRows(decisions: EmailDecision[]): FeedRows {
  const isDated = (d: EmailDecision): boolean => {
    const due = unitDueDate(d);
    return due !== null && Number.isFinite(Date.parse(due));
  };
  const dated = decisions.filter(isDated);
  const undated = decisions.filter((d) => !isDated(d));
  return {
    dated: sortFeedUnits(feedUnits(dated)),
    undatedGroups: groupByKind(undated),
  };
}

const URGENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const URGENT_CAP = 3;

/**
 * Deadline-ranked decisions due within 7 days; excludes Not-now hides.
 *
 * Reads `unitDueDate`, not `dueAt` directly - `dueAt` is only ever populated
 * for `event` kind (a task's due date rides `detail`), so filtering on it
 * alone silently dropped every dated TASK from the strip regardless of how
 * soon it was due. Tasks are the common case (ADR 0132's own example is a
 * permission slip due Friday), so this wasn't a narrow miss.
 */
export function urgentDecisions(
  decisions: EmailDecision[],
  notNow: Set<string>,
  now = Date.now(),
): EmailDecision[] {
  return decisions
    .filter((d) => {
      if (notNow.has(d.proposalId)) return false;
      const due = unitDueDate(d);
      if (!due) return false;
      const t = Date.parse(due);
      if (!Number.isFinite(t)) return false;
      return t >= now - 12 * 60 * 60_000 && t <= now + URGENT_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(unitDueDate(a)!) - Date.parse(unitDueDate(b)!))
    .slice(0, URGENT_CAP);
}
