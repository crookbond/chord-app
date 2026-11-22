/**
 * Tapping the bottom tab you are already on sends that screen back to its
 * starting point (top of the list; the current time on the calendar), as
 * iOS/Android tab bars do. The nav emits; each screen listens for its tab.
 */
import { useEffect, useRef, type RefObject } from 'react';

import type { MainTab } from '@/group-nav';

const listeners = new Map<MainTab, Set<() => void>>();

export function emitTabReselect(tab: MainTab): void {
  for (const fn of listeners.get(tab) ?? []) fn();
}

export function useTabReselect(tab: MainTab, fn: () => void): void {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    const call = () => latest.current();
    let set = listeners.get(tab);
    if (!set) listeners.set(tab, (set = new Set()));
    set.add(call);
    return () => {
      set.delete(call);
    };
  }, [tab]);
}

interface Scrollable {
  scrollTo?: (opts: { x?: number; y?: number; animated?: boolean }) => void;
  scrollToOffset?: (opts: { offset: number; animated?: boolean }) => void;
}

/** Scroll a ScrollView or FlatList to the top when `tab` is tapped again. */
export function useScrollTopOnReselect(
  tab: MainTab,
  ref: RefObject<unknown>,
): void {
  useTabReselect(tab, () => {
    const node = ref.current as Scrollable | null;
    if (!node) return;
    if (node.scrollToOffset) node.scrollToOffset({ offset: 0, animated: true });
    else node.scrollTo?.({ y: 0, animated: true });
  });
}
