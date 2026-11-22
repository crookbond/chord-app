// Which controls on a screen have a save in flight, one key per control, so a
// button waits only on its own save and never locks the rest of the list.
import { useCallback, useMemo, useRef, useState } from 'react';

export interface BusyKeys {
  /** For rendering: is this control's save running? */
  has: (key: string) => boolean;
  start: (key: string) => void;
  end: (key: string) => void;
  /** The current answer outside a render (e.g. inside an async callback). */
  hasNow: (key: string) => boolean;
}

export function useBusyKeys(): BusyKeys {
  const ref = useRef<Set<string>>(new Set());
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const start = useCallback((key: string) => {
    ref.current.add(key);
    setKeys(new Set(ref.current));
  }, []);
  const end = useCallback((key: string) => {
    ref.current.delete(key);
    setKeys(new Set(ref.current));
  }, []);
  const hasNow = useCallback((key: string) => ref.current.has(key), []);
  return useMemo(() => ({ has: (key: string) => keys.has(key), start, end, hasNow }), [keys, start, end, hasNow]);
}
