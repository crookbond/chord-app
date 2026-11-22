import { useEffect, useMemo, useRef } from 'react';
import { createCoalescer, REFETCH_COALESCE_MS, type Coalescer } from '@chord/kernel';

/**
 * A refetch a burst of SSE events runs once (kernel `createCoalescer`).
 * `trigger` for background events, `flush` where the user acted, `cancel` when
 * the screen loses focus. Always calls the newest `fn`, so the coalescer is
 * made once and a pending run is never lost to a re-render.
 */
export function useCoalesced(fn: () => void, delayMs: number = REFETCH_COALESCE_MS): Coalescer {
  const latest = useRef(fn);
  latest.current = fn;
  const c = useMemo(() => createCoalescer(() => latest.current(), delayMs), [delayMs]);
  useEffect(() => () => c.cancel(), [c]);
  return c;
}
