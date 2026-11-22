/**
 * ADR 0266 — a user's own order for the email categories in the AI view
 * (Feed and Cards). Categories they pinned come first, in their order;
 * everything else keeps Chord's default order below them.
 */

/** Category titles compare case-insensitively and ignoring outer spaces. */
export function categoryKey(title: string): string {
  return title.trim().toLowerCase();
}

/** Pinned first (in pinned order), the rest after in the order given. */
export function applyCategoryOrder<T>(items: T[], titleOf: (item: T) => string, pinned: string[]): T[] {
  if (pinned.length === 0) return items;
  const rank = new Map(pinned.map((t, i) => [categoryKey(t), i]));
  const top = items
    .filter((it) => rank.has(categoryKey(titleOf(it))))
    .sort((a, b) => rank.get(categoryKey(titleOf(a)))! - rank.get(categoryKey(titleOf(b)))!);
  const rest = items.filter((it) => !rank.has(categoryKey(titleOf(it))));
  return [...top, ...rest];
}

/**
 * Categories holding unread mail first, the user's own order inside each half.
 *
 * `applyCategoryOrder` alone puts a pinned category above an unpinned one
 * holding unread mail, so new mail sat below rows already read through -
 * the one thing an ordering must not do. Unread is therefore the outer
 * band and the user's order governs within it: a pinned category with
 * unread is at the very top, an unpinned one with unread still beats
 * everything read, and once a category is read it falls back to exactly
 * where the user put it.
 *
 * `items` arrives in the view's own default order, which is what the
 * unpinned tail of each band keeps.
 */
export function applyUnreadFirstOrder<T>(
  items: T[],
  titleOf: (item: T) => string,
  unreadOf: (item: T) => number,
  pinned: string[],
): T[] {
  const unread = items.filter((it) => unreadOf(it) > 0);
  if (unread.length === 0 || unread.length === items.length) {
    return applyCategoryOrder(items, titleOf, pinned);
  }
  const read = items.filter((it) => unreadOf(it) <= 0);
  return [
    ...applyCategoryOrder(unread, titleOf, pinned),
    ...applyCategoryOrder(read, titleOf, pinned),
  ];
}

/** "Keep Finance and School on top": these first, then the earlier pins. */
export function pinToTop(current: string[], titles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...titles, ...current]) {
    const k = categoryKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
  }
  return out;
}

/**
 * A card dragged to a new place. Everything at and above where it landed
 * becomes the pinned order, which is what keeps it there: pinning the card
 * alone would put it at the very top, not where it was dropped.
 */
export function pinnedAfterMove(shown: string[], from: number, to: number): string[] {
  if (from < 0 || from >= shown.length) return shown.slice();
  const next = shown.slice();
  const [moved] = next.splice(from, 1);
  const at = Math.max(0, Math.min(to, next.length));
  next.splice(at, 0, moved);
  return next.slice(0, at + 1);
}

export interface DropSlot {
  y: number;
  h: number;
}

/**
 * Where a card dragged `dy` from slot `from` lands: the number of OTHER cards
 * whose middle is above the dragged card's middle. A slot not yet measured
 * counts as not above.
 */
export function dropIndex(slots: (DropSlot | undefined)[], from: number, dy: number): number {
  const self = slots[from];
  if (!self) return from;
  const centre = self.y + self.h / 2 + dy;
  let to = 0;
  slots.forEach((s, i) => {
    if (s && i !== from && s.y + s.h / 2 < centre) to++;
  });
  return to;
}

/** Height of the band at each edge of the view where a drag scrolls it. */
export const EDGE_SCROLL_ZONE = 80;
/** Fastest scroll, in pixels per frame, with the finger at the very edge. */
export const EDGE_SCROLL_MAX = 14;

/**
 * How far to scroll this frame while a card is held `y` pixels below the top
 * of a view `height` tall: up (negative) near the top, down near the bottom,
 * nothing in between. Gentle at the inner edge of the band and quicker the
 * closer the finger gets (and past the edge), so the user steers the speed.
 */
export function edgeScrollStep(y: number, height: number): number {
  if (height <= 0) return 0;
  const zone = Math.min(EDGE_SCROLL_ZONE, height / 4);
  const speed = (depth: number) => {
    const t = Math.min(1, Math.max(0, depth / zone));
    return Math.max(1, Math.round(EDGE_SCROLL_MAX * t * t));
  };
  if (y < zone) return -speed(zone - y);
  if (y > height - zone) return speed(y - (height - zone));
  return 0;
}
