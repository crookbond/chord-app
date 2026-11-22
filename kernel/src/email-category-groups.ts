/**
 * ADR 0292 — the AI view's email categories grouped under their top-level
 * parent category and folded, so Feed and Cards keep the Map's two levels
 * without listing every subcategory.
 *
 * A group with unread mail lists the subcategories that need the user and
 * folds the rest into one "+ N more" row; a group with nothing in it starts as
 * one header line. Ordering keeps ADR 0266 and 0287: groups holding unread
 * first, the user's own order inside each band, and inside a group the same
 * rule again over its subcategories. Pins stay one flat list of titles: a
 * group is pinned by its parent's title, or, failing that, by its
 * highest-pinned subcategory, so orders saved before grouping still hold.
 */
import { applyUnreadFirstOrder, categoryKey, pinnedAfterMove } from './email-category-order';

export interface CategoryGroup<T> {
  /** The parent category's title (a top-level category is its own parent). */
  key: string;
  /** Subcategories in display order: unread first, then the user's order. */
  items: T[];
  unread: number;
}

export interface GroupOptions<T> {
  titleOf: (item: T) => string;
  /** Top-level category title; null puts the item in a group of its own. */
  parentOf: (item: T) => string | null;
  unreadOf: (item: T) => number;
  pinned: string[];
}

/** Groups in display order. `items` arrives in the view's default order. */
export function groupCategories<T>(items: T[], o: GroupOptions<T>): CategoryGroup<T>[] {
  const byKey = new Map<string, { key: string; items: T[] }>();
  for (const it of items) {
    const key = (o.parentOf(it) ?? o.titleOf(it)).trim();
    const k = categoryKey(key);
    const g = byKey.get(k) ?? { key, items: [] };
    g.items.push(it);
    byKey.set(k, g);
  }
  const rank = new Map(o.pinned.map((t, i) => [categoryKey(t), i] as const));
  const rankOf = (g: { key: string; items: T[] }): number => {
    const own = rank.get(categoryKey(g.key));
    if (own !== undefined) return own;
    let best = Infinity;
    for (const it of g.items) best = Math.min(best, rank.get(categoryKey(o.titleOf(it))) ?? Infinity);
    return best;
  };
  const groups = [...byKey.values()].map((g, order) => ({
    key: g.key,
    items: applyUnreadFirstOrder(g.items, o.titleOf, o.unreadOf, o.pinned),
    unread: g.items.reduce((n, it) => n + Math.max(0, o.unreadOf(it)), 0),
    rank: rankOf(g),
    order,
  }));
  groups.sort(
    (a, b) =>
      Number(b.unread > 0) - Number(a.unread > 0) || a.rank - b.rank || a.order - b.order,
  );
  return groups.map(({ key, items: gi, unread }) => ({ key, items: gi, unread }));
}

function merge(first: string[], rest: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...first, ...rest]) {
    const k = categoryKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
  }
  return out;
}

/** A whole group dragged from `from` to `to` among `groupKeys` (on screen). */
export function pinnedAfterGroupMove(
  groupKeys: string[],
  from: number,
  to: number,
  pinned: string[],
): string[] {
  if (from === to) return pinned.slice();
  return merge(pinnedAfterMove(groupKeys, from, to), pinned);
}

/**
 * A subcategory dragged within its group. Its group, and every group above
 * it, are pinned where they are now (ADR 0266's "at and above"), so moving a
 * card inside a group never moves the group.
 */
export function pinnedAfterChildMove(
  groupKeys: string[],
  groupIndex: number,
  childTitles: string[],
  from: number,
  to: number,
  pinned: string[],
): string[] {
  if (from === to) return pinned.slice();
  return merge(
    [...groupKeys.slice(0, groupIndex + 1), ...pinnedAfterMove(childTitles, from, to)],
    pinned,
  );
}

export interface FoldState {
  /** Groups the user folded or unfolded by hand; else folded iff nothing is active. */
  folded: Record<string, boolean>;
  /** Groups whose "+ N more" row was opened. */
  showAll: string[];
}

export type FoldRow<T> =
  | { kind: 'head'; group: number; key: string; unread: number; size: number; folded: boolean }
  | { kind: 'item'; group: number; child: number; item: T }
  | { kind: 'solo'; group: number; item: T }
  | { kind: 'more'; group: number; key: string; hidden: number }
  | { kind: 'fewer'; group: number; key: string };

/**
 * The rows on screen. A group of one is that one card with no header. A
 * folded group is its header. An open group shows its active subcategories
 * (unread mail or something to decide) and folds the rest into a "+ N more"
 * row; with none active it shows them all, since the user opened it to look.
 */
export function foldRows<T>(
  groups: CategoryGroup<T>[],
  activeOf: (item: T) => boolean,
  state: FoldState,
): FoldRow<T>[] {
  const rows: FoldRow<T>[] = [];
  const showAll = new Set(state.showAll.map(categoryKey));
  groups.forEach((g, gi) => {
    if (g.items.length === 1) {
      rows.push({ kind: 'solo', group: gi, item: g.items[0] });
      return;
    }
    const active = g.items.filter(activeOf);
    const folded = state.folded[categoryKey(g.key)] ?? active.length === 0;
    rows.push({ kind: 'head', group: gi, key: g.key, unread: g.unread, size: g.items.length, folded });
    if (folded) return;
    const all = active.length === 0 || active.length === g.items.length || showAll.has(categoryKey(g.key));
    g.items.forEach((item, child) => {
      if (all || activeOf(item)) rows.push({ kind: 'item', group: gi, child, item });
    });
    if (!all) rows.push({ kind: 'more', group: gi, key: g.key, hidden: g.items.length - active.length });
    else if (active.length > 0 && active.length < g.items.length) rows.push({ kind: 'fewer', group: gi, key: g.key });
  });
  return rows;
}

/** Fold state with one group folded or unfolded by hand. */
export function toggleFold<T>(state: FoldState, rows: FoldRow<T>[], key: string): FoldState {
  const head = rows.find((r) => r.kind === 'head' && categoryKey(r.key) === categoryKey(key));
  const now = head && head.kind === 'head' ? head.folded : false;
  return { ...state, folded: { ...state.folded, [categoryKey(key)]: !now } };
}

/** Fold state with a group's "+ N more" opened (true) or closed. */
export function setShowAll(state: FoldState, key: string, on: boolean): FoldState {
  const k = categoryKey(key);
  const rest = state.showAll.filter((t) => categoryKey(t) !== k);
  return { ...state, showAll: on ? [...rest, k] : rest };
}

/**
 * The new pinned order after a row was dragged from `from` to `to` in the
 * flat row list (`to` counts the other rows above where it landed). A header
 * or a group of one moves its group; a subcategory moves only inside its own
 * group. Anything else, or a drop that changes nothing, returns null.
 */
export function pinnedAfterRowMove<T>(
  rows: FoldRow<T>[],
  groups: CategoryGroup<T>[],
  titleOf: (item: T) => string,
  from: number,
  to: number,
  pinned: string[],
): string[] | null {
  const moved = rows[from];
  if (!moved || from === to) return null;
  const others = rows.filter((_, i) => i !== from);
  const keys = groups.map((g) => g.key);
  if (moved.kind === 'head' || moved.kind === 'solo') {
    const landing = others[to];
    let target: number;
    if (!landing) target = groups.length - 1;
    else if (landing.kind === 'head' || landing.kind === 'solo') target = landing.group;
    else target = landing.group + 1;
    if (target > moved.group) target -= 1;
    target = Math.max(0, Math.min(groups.length - 1, target));
    if (target === moved.group) return null;
    return pinnedAfterGroupMove(keys, moved.group, target, pinned);
  }
  if (moved.kind !== 'item') return null;
  const shown = rows.filter((r) => r.kind === 'item' && r.group === moved.group) as Extract<
    FoldRow<T>,
    { kind: 'item' }
  >[];
  const fromChild = shown.findIndex((r) => r.child === moved.child);
  const before = others.slice(0, to).filter((r) => r.kind === 'item' && r.group === moved.group).length;
  const toChild = Math.max(0, Math.min(shown.length - 1, before));
  if (toChild === fromChild) return null;
  // Only the rows on screen can be reordered; the folded rest keep their place.
  return pinnedAfterChildMove(
    keys,
    moved.group,
    shown.map((r) => titleOf(r.item)),
    fromChild,
    toChild,
    pinned,
  );
}
