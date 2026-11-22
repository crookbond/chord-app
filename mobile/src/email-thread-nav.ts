import { create } from 'zustand';
import type {
  EmailAfterRemove,
  EmailThreadDetail,
  EmailThreadSummary,
  EmailWalk,
  EmailWalkScope,
} from '@chord/kernel';

import { removeStoredThreads } from './email-device-store';
import { onSignOut } from './sign-out';

/**
 * The Traditional list's ordered thread ids, published here so the thread
 * reader (opened by id alone via expo-router) can offer prev/next without
 * re-fetching or duplicating the list's own keyset pagination. `loadMore`
 * is the list's own callback, reused as-is - the store never fetches.
 *
 * `removing` holds threads archived/trashed but not yet confirmed by the
 * server. Every write of the list filters them out, so a refetch that raced
 * the removal (a per-thread SSE event, the focus reload) cannot put a row
 * back on screen, and the reader can move on to the next email at once.
 */
/**
 * Whose order `ids` is. `list`: the Traditional list. `unread`: that list with
 * its Unread filter on. `category`: a walk through one category's unread mail,
 * started from the AI view. In both walks "next" skips an email already read,
 * and past the last one the reader goes back to where it started
 * (kernel/src/email-walk.ts).
 */
export type EmailNavScope = EmailWalkScope;

interface EmailThreadNavState {
  ids: string[];
  /**
   * The rows behind `ids`, for the reader's list pane on a wide screen (ADR
   * 0320). Published by whoever published the order, so the pane shows the
   * list the user was actually looking at - its filters, its mailbox, its
   * order - and fetches nothing. Empty when the order came from somewhere
   * with no rows to hand over (a category walk), and the pane then loads its
   * own page.
   */
  rows: EmailThreadSummary[];
  scope: EmailNavScope | null;
  /** Emails read since this order was published: opened in the reader, or
   *  shown read by the list. */
  read: Set<string>;
  markRead: (id: string) => void;
  hasMore: boolean;
  loadMore: (() => Promise<void>) | null;
  removing: Set<string>;
  /** When each thread was last archived/trashed from here (ms) - stamped at
   *  the tap and again when the mailbox CONFIRMED it, so a view drawn from
   *  data fetched before that write landed still leaves it out
   *  (`removedSinceFetch`, kernel/src/email-removals.ts). */
  removedAt: Map<string, number>;
  /** A removal started in the reader that the mailbox refused, for the list to show. */
  removeError: string | null;
  setRemoveError: (msg: string | null) => void;
  setNav: (
    ids: string[],
    hasMore: boolean,
    loadMore: (() => Promise<void>) | null,
    scope?: EmailNavScope,
    readIds?: readonly string[],
    rows?: readonly EmailThreadSummary[],
  ) => void;
  clearNav: () => void;
  startRemoving: (ids: string[]) => void;
  /** `failed` ids come back at once; the rest are re-stamped as confirmed. */
  doneRemoving: (ids: string[], failed?: readonly string[]) => void;
}

export const useEmailThreadNav = create<EmailThreadNavState>((set) => ({
  ids: [],
  rows: [],
  scope: null,
  read: new Set(),
  markRead: (id) =>
    set((s) => (s.read.has(id) ? s : { read: new Set(s.read).add(id) })),
  hasMore: false,
  loadMore: null,
  removing: new Set(),
  removedAt: new Map(),
  removeError: null,
  setRemoveError: (removeError) => set({ removeError }),
  setNav: (ids, hasMore, loadMore, scope = 'list', readIds = [], rows = []) =>
    set((s) => {
      // A different order starts a new walk; the same one republished (a
      // refetch, a page appended) keeps what was read on the way.
      const read = new Set(s.scope === scope ? s.read : []);
      for (const id of readIds) read.add(id);
      return { ids, rows: [...rows], hasMore, loadMore, scope, read };
    }),
  clearNav: () =>
    set({ ids: [], rows: [], hasMore: false, loadMore: null, scope: null, read: new Set() }),
  startRemoving: (ids) =>
    set((s) => {
      const removing = new Set(s.removing);
      for (const id of ids) removing.add(id);
      const now = Date.now();
      const removedAt = new Map([...s.removedAt].filter(([, at]) => now - at < 10 * 60_000));
      for (const id of ids) removedAt.set(id, now);
      return {
        removing,
        removedAt,
        ids: s.ids.filter((id) => !removing.has(id)),
        rows: s.rows.filter((r) => !removing.has(r.id)),
      };
    }),
  doneRemoving: (ids, failed = []) =>
    set((s) => {
      const removing = new Set(s.removing);
      for (const id of ids) removing.delete(id);
      const removedAt = new Map(s.removedAt);
      const now = Date.now();
      for (const id of ids) {
        // A refusal releases the row entirely - it is still in the mailbox,
        // so every view should show it again (ADR 0218).
        if (failed.includes(id)) removedAt.delete(id);
        else removedAt.set(id, now);
      }
      // Confirmed by the mailbox: it leaves the phone's copy too (ADR 0302).
      void removeStoredThreads(ids.filter((id) => !failed.includes(id)));
      return { removing, removedAt };
    }),
}));

/** The order the reader walks, as the kernel's walk rules read it. */
export function currentWalk(
  s: Pick<EmailThreadNavState, 'ids' | 'scope' | 'read' | 'removing' | 'removedAt'>,
): EmailWalk {
  // Confirmed removals stay out too: the list keeps the row until it refetches.
  const removed = new Set([...s.removing, ...s.removedAt.keys()]);
  return { ids: s.ids, scope: s.scope ?? 'list', read: s.read, removed };
}

/**
 * Thread details fetched ahead of the tap (the reader warms the next and
 * previous email), so opening one paints at once while the real open - which
 * runs the read-time pass and marks it read - catches up behind it.
 */
const PREFETCH_TTL_MS = 2 * 60_000;
const prefetched = new Map<string, { detail: EmailThreadDetail; at: number }>();

export function putPrefetchedThread(id: string, detail: EmailThreadDetail): void {
  prefetched.set(id, { detail, at: Date.now() });
  if (prefetched.size > 20) {
    const oldest = [...prefetched.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) prefetched.delete(oldest[0]);
  }
}

export function takePrefetchedThread(id: string): EmailThreadDetail | null {
  const hit = prefetched.get(id);
  if (!hit) return null;
  prefetched.delete(id);
  return Date.now() - hit.at <= PREFETCH_TTL_MS ? hit.detail : null;
}

export function hasPrefetchedThread(id: string): boolean {
  const hit = prefetched.get(id);
  return !!hit && Date.now() - hit.at <= PREFETCH_TTL_MS;
}

/**
 * ADR 0218 - read once per app run and shared by every reader, so moving from
 * one email to the next does not re-ask the server. Settings writes it back.
 */
let afterRemovePref: EmailAfterRemove | null = null;
onSignOut(() => {
  prefetched.clear();
  afterRemovePref = null;
});
export function getAfterRemovePref(): EmailAfterRemove | null {
  return afterRemovePref;
}
export function setAfterRemovePref(v: EmailAfterRemove): void {
  afterRemovePref = v;
}
