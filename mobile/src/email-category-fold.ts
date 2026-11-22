/**
 * ADR 0292 — which category groups the user folded or opened in the AI view,
 * remembered on this device (like the view choice) and shared by Feed and
 * Cards, so folding School in one view folds it in the other.
 */
import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FoldState } from '@chord/kernel';

import { useApp } from '@/store';

const EMPTY: FoldState = { folded: {}, showAll: [] };
let cache: { userId: string; state: FoldState } | null = null;
const listeners = new Set<(s: FoldState) => void>();

const keyFor = (userId: string) => `email.categoryFold.${userId}`;

function publish(userId: string, state: FoldState): void {
  cache = { userId, state };
  for (const l of listeners) l(state);
}

export function useCategoryFold(): [FoldState, (next: FoldState) => void] {
  const userId = useApp((s) => s.user?.id) ?? '';
  const [state, setState] = useState<FoldState>(() =>
    cache && cache.userId === userId ? cache.state : EMPTY,
  );

  useEffect(() => {
    listeners.add(setState);
    if (!(cache && cache.userId === userId)) {
      void AsyncStorage.getItem(keyFor(userId))
        .then((raw) => {
          if (!raw || (cache && cache.userId === userId)) return;
          const parsed = JSON.parse(raw) as Partial<FoldState>;
          publish(userId, { folded: parsed.folded ?? {}, showAll: parsed.showAll ?? [] });
        })
        .catch(() => {});
    }
    return () => {
      listeners.delete(setState);
    };
  }, [userId]);

  const set = useCallback(
    (next: FoldState) => {
      publish(userId, next);
      void AsyncStorage.setItem(keyFor(userId), JSON.stringify(next)).catch(() => {});
    },
    [userId],
  );

  return [state, set];
}
