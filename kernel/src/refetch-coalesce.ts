/**
 * Turning a burst of "something changed" events into one refetch, and one
 * refetch into no download when nothing changed.
 *
 * One mail sync broadcasts several events (`email.synced`, then an
 * `email.tiles.updated` per thread the sync or the AI passes touched). A
 * screen that refetched on each one re-read the same list five or ten times
 * a tick, all night, for a tab left open on the web.
 */

/** Same window ADR 0218 uses for the thread list's `email.synced` refetch. */
export const REFETCH_COALESCE_MS = 300;

export interface TimerApi {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Coalescer {
  /** An event arrived: run once, `delayMs` after the LAST of a burst. */
  trigger(): void;
  /** Run now (the user acted) and drop any pending trailing run. */
  flush(): void;
  /** Drop a pending run (the screen lost focus, or unmounted). */
  cancel(): void;
  pending(): boolean;
}

export function createCoalescer(
  run: () => void,
  delayMs: number = REFETCH_COALESCE_MS,
  timers: TimerApi = realTimers,
): Coalescer {
  let handle: unknown = null;
  const cancel = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  return {
    trigger() {
      cancel();
      handle = timers.set(() => {
        handle = null;
        run();
      }, delayMs);
    },
    flush() {
      cancel();
      run();
    },
    cancel,
    pending: () => handle !== null,
  };
}

/**
 * Newest request wins: a slower, older answer must not replace a fresher one
 * already shown. `begin()` returns a check that is true only while no later
 * request has begun.
 */
export function createLatestGuard(): { begin(): () => boolean } {
  let seq = 0;
  return {
    begin() {
      const mine = ++seq;
      return () => mine === seq;
    },
  };
}

/**
 * `createLatestGuard` per key (a screen loading several lists at once). Also
 * `invalidate(key)`: a local change made while a load is in flight (a tick)
 * makes that load's older answer stale too.
 */
export function createKeyedLatestGuard<K extends string>(): {
  begin(key: K): () => boolean;
  invalidate(key: K): void;
} {
  const seq = new Map<K, number>();
  const bump = (key: K) => {
    const n = (seq.get(key) ?? 0) + 1;
    seq.set(key, n);
    return n;
  };
  return {
    begin(key) {
      const mine = bump(key);
      return () => seq.get(key) === mine;
    },
    invalidate(key) {
      bump(key);
    },
  };
}

/** What a conditional GET remembers per URL (and per signed-in user). */
export interface ConditionalEntry<T> {
  etag: string;
  body: T;
}

/**
 * The outcome of a conditional GET. A 304 hands back the remembered body (the
 * SAME object, so a React state set with it is a no-op); a 200 replaces the
 * entry when it carries an ETag, and forgets it when it does not.
 */
export function resolveConditional<T>(
  cached: ConditionalEntry<T> | undefined,
  status: number,
  etag: string | null,
  body: T | undefined,
): { body: T; entry: ConditionalEntry<T> | undefined } {
  if (status === 304) {
    if (!cached) throw new Error('304 with nothing cached');
    return { body: cached.body, entry: cached };
  }
  if (body === undefined) throw new Error('response had no body');
  return { body, entry: etag ? { etag, body } : undefined };
}
