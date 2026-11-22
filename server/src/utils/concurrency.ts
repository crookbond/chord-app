export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  await mapConcurrent(items, limit, fn);
}

/**
 * One run of `fn` per key at a time. A call while a run is going joins ONE
 * follow-up run that starts when the current one settles, so every caller gets
 * a result computed after it called (fresh), and any number of overlapping
 * callers cost at most two runs.
 */
export function coalescePerKey<T>(): (key: string, fn: () => Promise<T>) => Promise<T> {
  const slots = new Map<string, { current: Promise<T>; follow: Promise<T> | null }>();
  const noop = () => undefined;
  const watch = (key: string, p: Promise<T>) => {
    void p.then(noop, noop).then(() => {
      const s = slots.get(key);
      if (s && s.current === p && !s.follow) slots.delete(key);
    });
  };
  return (key, fn) => {
    const slot = slots.get(key);
    if (!slot) {
      const current = fn();
      slots.set(key, { current, follow: null });
      watch(key, current);
      return current;
    }
    slot.follow ??= slot.current.then(noop, noop).then(() => {
      const next = fn();
      slot.current = next;
      slot.follow = null;
      watch(key, next);
      return next;
    });
    return slot.follow;
  };
}
