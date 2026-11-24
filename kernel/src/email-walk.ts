/**
 * Where the email reader goes next. Two kinds of order reach it:
 *
 * - `list`: the Traditional list as it is. Next is the email below; putting
 *   the last one away shows the one above (ADR 0218).
 * - a walk through what is waiting: a category from the AI view (ADR 0264),
 *   or the list with its Unread filter on. Opening an email reads it, so it
 *   is done: next skips emails already read, and after the last unread one
 *   the walk is over and the reader goes back to where it started. Falling
 *   back to the email above walked back through the ones just read, one
 *   removal at a time.
 *
 * An email archived or trashed here is skipped in every order. The list
 * keeps its row until it next refetches, so once the mailbox confirmed the
 * removal the email came back into the order: the reader returned to it,
 * and trashing it again failed on an IMAP mailbox (it had left the inbox).
 */
export type EmailWalkScope = 'list' | 'unread' | 'category';

export interface EmailWalk {
  ids: readonly string[];
  scope: EmailWalkScope;
  /** Emails read since the walk began (opened here, or read elsewhere). */
  read: ReadonlySet<string>;
  /** Emails archived or trashed here, pending or confirmed. */
  removed?: ReadonlySet<string>;
}

const isWalk = (scope: EmailWalkScope): boolean => scope !== 'list';

function canVisit(walk: EmailWalk, id: string): boolean {
  if (walk.removed?.has(id)) return false;
  return !isWalk(walk.scope) || !walk.read.has(id);
}

/** The next email after `current` in this order; null when there is none. */
export function nextInWalk(walk: EmailWalk, current: string): string | null {
  const i = walk.ids.indexOf(current);
  if (i < 0) return null;
  return walk.ids.slice(i + 1).find((id) => canVisit(walk, id)) ?? null;
}

/** The email before `current` that is still there to go back to. */
export function prevInWalk(walk: EmailWalk, current: string): string | null {
  const i = walk.ids.indexOf(current);
  if (i <= 0) return null;
  return [...walk.ids.slice(0, i)].reverse().find((id) => !walk.removed?.has(id)) ?? null;
}

/**
 * The order to walk when the list republishes itself mid-walk. With Unread on,
 * a refetch leaves out every email read since the walk began, the one on
 * screen included, and an email not in the order has no next: putting it away
 * cleared the reader. Each `keep` id the new order lacks goes back where it
 * was, just before the first email that followed it and is still there.
 */
export function mergeWalkOrder(
  prev: readonly string[],
  next: readonly string[],
  keep: ReadonlySet<string>,
): string[] {
  const inNext = new Set(next);
  const kept = prev.filter((id) => keep.has(id) && !inNext.has(id));
  if (kept.length === 0) return [...next];
  // Each kept id is anchored to the first id after it in `prev` that `next` has.
  const before = new Map<string, string[]>();
  const atEnd: string[] = [];
  const keptSet = new Set(kept);
  for (let i = 0; i < prev.length; i++) {
    const id = prev[i]!;
    if (!keptSet.has(id)) continue;
    const anchor = prev.slice(i + 1).find((later) => inNext.has(later));
    if (anchor) before.set(anchor, [...(before.get(anchor) ?? []), id]);
    else atEnd.push(id);
  }
  const out: string[] = [];
  for (const id of next) out.push(...(before.get(id) ?? []), id);
  return [...out, ...atEnd];
}

/** Where to go once `current` has been archived or trashed; null = back to the list. */
export function afterRemoveTarget(walk: EmailWalk, current: string): string | null {
  const next = nextInWalk(walk, current);
  if (next || isWalk(walk.scope)) return next;
  return prevInWalk(walk, current);
}
