/**
 * Shared "recent mail" fallback for the decision-only AI views (ADR 0110,
 * extended from Map to Cards/Sections/Feed - see the worktree's fix for
 * "these go empty once their last action item is handled"). Map reads its
 * tile tree's own `preview` field directly; the other three views never
 * fetched tile data at all, so a category/kind/feed row disappeared the
 * moment its last pending decision cleared instead of falling back to
 * recent mail the way Map already does.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchPredatesRemoval, removedSinceFetch, type EmailTileLevel } from '@chord/kernel';

import { listEmailTiles, openUserStream, readSavedCopy, type StreamHandle } from '@/api';
import { categoryParents, leafRecents, type CategoryRecent } from '@/email-decisions';
import { useEmailThreadNav } from '@/email-thread-nav';
import { useApp } from '@/store';
import { useCoalesced } from '@/use-coalesced';

/**
 * The last list fetched, kept for this app run. Switching between Feed and
 * Cards (or coming back to the Email tab) mounts a fresh view; without this
 * it drew "Nothing needs you right now" until the tiles fetch landed. Keyed
 * by user, so a sign-in on the same device never paints someone else's mail.
 */
interface Known {
  recents: CategoryRecent[];
  parents: ReturnType<typeof categoryParents>;
  askedAt: number;
}
let lastKnown: (Known & { userId: string }) | null = null;

const NO_PARENTS: ReturnType<typeof categoryParents> = { byId: new Map(), byTitle: new Map() };

export interface EmailRecents {
  recents: CategoryRecent[];
  loaded: boolean;
  /** ADR 0292: a category's top-level parent title, by id or else by title. */
  parentOf: (id: string | null | undefined, title: string) => string | null;
}

export function useEmailRecents(): EmailRecents {
  const userId = useApp((s) => s.user?.id) ?? '';
  const [state, setState] = useState<Known | null>(
    () => (lastKnown && lastKnown.userId === userId ? lastKnown : null),
  );

  // First open of this run: paint the tiles this phone saved last while the
  // fetch below runs. Dated 0, so anything removed since counts as newer and
  // stays hidden; the fetched list always replaces it.
  useEffect(() => {
    if (lastKnown && lastKnown.userId === userId) return;
    let cancelled = false;
    void readSavedCopy<EmailTileLevel>('email-tiles-root-deep').then((level) => {
      if (cancelled || !level) return;
      setState(
        (prev) =>
          prev ?? { recents: leafRecents(level.tiles), parents: categoryParents(level.tiles), askedAt: 0 },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const reload = useCallback(() => {
    const askedAt = Date.now();
    void listEmailTiles(undefined, { deep: true })
      .then((level) => {
        // Focus and the stream can both ask at once; the newest answer wins,
        // or an older one in flight replaces the fresher list behind it.
        if (lastKnown && lastKnown.userId === userId && lastKnown.askedAt > askedAt) return;
        lastKnown = {
          userId,
          recents: leafRecents(level.tiles),
          parents: categoryParents(level.tiles),
          askedAt,
        };
        setState(lastKnown);
      })
      .catch(() => {});
  }, [userId]);

  // One sync tick is a burst of events; the tile tree is fetched once for it.
  const reloadSoon = useCoalesced(reload);

  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      // The stream is closed while another screen is in front, so whatever
      // changed meanwhile (an email trashed from the reader) was not heard.
      reload();
      let handle: StreamHandle | null = null;
      let cancelled = false;
      void openUserStream({
        onEmailSynced: reloadSoon.trigger,
        onEmailTilesUpdated: reloadSoon.trigger,
      })
        .then((h) => {
          if (cancelled) h.close();
          else handle = h;
        })
        // The screen works without live updates; a failed open must not be an
        // unhandled rejection.
        .catch((e) => console.warn('[email-recents] live updates unavailable', e));
      return () => {
        focused.current = false;
        cancelled = true;
        handle?.close();
        reloadSoon.cancel();
      };
    }, [reload, reloadSoon]),
  );

  // An email just archived or trashed from the reader leaves at once, not
  // when the next tiles fetch lands: anything removed at or after these tiles
  // were asked for is left out, confirmations included - the walk's last
  // removals are still mid-flight when returning here refetches.
  const removedAt = useEmailThreadNav((s) => s.removedAt);
  const removing = useEmailThreadNav((s) => s.removing);
  const removals = useMemo(() => ({ removing, removedAt }), [removing, removedAt]);

  // Those rows are filtered out, but the server would now send others in
  // their place, so known-stale data earns one more fetch once the writes
  // land. Coalesced, and only while this view is in front, so walking
  // through a category does not fetch the whole tile tree per email.
  const askedAt = state?.askedAt ?? 0;
  useEffect(() => {
    if (!state || removing.size > 0) return;
    if (!fetchPredatesRemoval(removals, askedAt)) return;
    const t = setTimeout(() => {
      if (focused.current) reload();
    }, 600);
    return () => clearTimeout(t);
  }, [state, removals, removing, askedAt, reload]);

  const parents = state?.parents ?? NO_PARENTS;
  const parentOf = useCallback(
    (id: string | null | undefined, title: string) =>
      (id ? parents.byId.get(id) : undefined) ?? parents.byTitle.get(title.trim().toLowerCase()) ?? null,
    [parents],
  );

  return useMemo(() => {
    if (!state) return { recents: [], loaded: false, parentOf };
    const recents = state.recents
      .map((r) => ({
        ...r,
        preview: r.preview.filter((p) => !removedSinceFetch(removals, state.askedAt, p.threadId)),
      }))
      .filter((r) => r.preview.length > 0);
    return { recents, loaded: true, parentOf };
  }, [state, removals, parentOf]);
}
