/**
 * ADR 0266 — the user's own order for the AI view's email categories. Read
 * once per app run (and again when a view opens, so an order set in chat
 * shows up), shared by Feed and Cards, written back when a card is dragged.
 */
import { useCallback, useEffect, useState } from 'react';
import { pinnedAfterMove } from '@chord/kernel';

import { getEmailCategoryOrder, setEmailCategoryOrder } from '@/api';
import { useApp } from '@/store';

let cache: { userId: string; titles: string[] } | null = null;
const listeners = new Set<(titles: string[]) => void>();

function publish(userId: string, titles: string[]): void {
  cache = { userId, titles };
  for (const l of listeners) l(titles);
}

export function useEmailCategoryOrder(): {
  pinned: string[];
  /** A card dragged from `from` to `to` in `shown` (the order on screen). */
  move: (shown: string[], from: number, to: number) => void;
  /** Save this exact pinned order (ADR 0292's grouped drags compute it). */
  setPinned: (next: string[]) => void;
  /** Back to the system default order (nothing pinned). */
  reset: () => Promise<void>;
} {
  const userId = useApp((s) => s.user?.id) ?? '';
  const [pinned, setPinned] = useState<string[]>(() =>
    cache && cache.userId === userId ? cache.titles : [],
  );

  useEffect(() => {
    listeners.add(setPinned);
    void getEmailCategoryOrder()
      .then((o) => publish(userId, o.titles))
      .catch(() => {});
    return () => {
      listeners.delete(setPinned);
    };
  }, [userId]);

  const save = useCallback(
    (next: string[]) => {
      const before = cache?.userId === userId ? cache.titles : [];
      publish(userId, next);
      // A refused save puts the old order back rather than leaving the
      // screen showing an order the server does not have.
      void setEmailCategoryOrder(next)
        .then((o) => publish(userId, o.titles))
        .catch(() => publish(userId, before));
    },
    [userId],
  );

  const move = useCallback(
    (shown: string[], from: number, to: number) => {
      if (from !== to) save(pinnedAfterMove(shown, from, to));
    },
    [save],
  );

  const reset = useCallback(async () => {
    const before = cache?.userId === userId ? cache.titles : [];
    publish(userId, []);
    try {
      publish(userId, (await setEmailCategoryOrder([])).titles);
    } catch (err) {
      publish(userId, before);
      throw err;
    }
  }, [userId]);

  return { pinned, move, setPinned: save, reset };
}
