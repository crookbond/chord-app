/**
 * The emails "next" walks through after opening one from a category in the
 * AI view (Feed, Cards, Sections). The one tapped comes first, then the
 * category's other unread email, newest first. Read email is left out: the
 * point is to get through what is waiting, and the walk ends (back to the
 * view it started from) after the last of them.
 */
export interface CategoryNavThread {
  id: string;
  isUnread: boolean;
  lastMessageAt: string;
}

export function categoryNavOrder(tappedId: string, threads: CategoryNavThread[]): string[] {
  const seen = new Set<string>([tappedId]);
  const rest = threads
    .filter((t) => t.isUnread && !seen.has(t.id))
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
  const out = [tappedId];
  for (const t of rest) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t.id);
  }
  return out;
}
