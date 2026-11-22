/**
 * Two small tools for client code that writes something expensive.
 *
 * - `singleFlight`: callers that arrive while a call is in flight share its
 *   promise, so a check-then-create (is there a key? no: make one) runs once
 *   however many callers race it.
 * - `createBatchedWrite`: a write that many changes dirty (the device mail
 *   index, sealed in plain JS on the phone) runs once per batch, at most
 *   `everyMs` after the first change, or at once on `flush()`.
 */
import type { TimerApi } from './refetch-coalesce';

export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const run = fn();
    inFlight = run;
    const clear = () => {
      if (inFlight === run) inFlight = null;
    };
    run.then(clear, clear);
    return run;
  };
}

export interface BatchedWrite {
  /** Something changed: write within `everyMs` (a burst writes once). */
  mark(): void;
  /** Write now if anything is waiting; resolves when written. */
  flush(): Promise<void>;
  /** Forget what is waiting (the data was thrown away). */
  cancel(): void;
  dirty(): boolean;
}

const realTimers: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createBatchedWrite(
  write: () => Promise<void>,
  everyMs: number,
  timers: TimerApi = realTimers,
): BatchedWrite {
  let isDirty = false;
  let handle: unknown = null;
  const stopTimer = () => {
    if (handle !== null) timers.clear(handle);
    handle = null;
  };
  const flush = async () => {
    stopTimer();
    if (!isDirty) return;
    isDirty = false;
    await write();
  };
  return {
    mark() {
      isDirty = true;
      // Not reset by later changes: a steady stream still writes every `everyMs`.
      if (handle === null) {
        handle = timers.set(() => {
          handle = null;
          void flush().catch(() => {});
        }, everyMs);
      }
    },
    flush,
    cancel() {
      stopTimer();
      isDirty = false;
    },
    dirty: () => isDirty,
  };
}

/**
 * One run at a time, and the latest wins: a call while a run is in flight
 * waits for ONE more run after it (however many calls arrive meanwhile), and
 * every waiting caller gets that run's answer. A save that reads its input
 * when it starts (the draft autosave) therefore never has two requests in
 * the air - two creates of one new draft, or an older body landing last.
 */
export function serialRerun<T>(run: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const p = run();
    current = p;
    const done = () => {
      if (current === p) current = null;
    };
    p.then(done, done);
    return p;
  };
  return () => {
    if (!current) return start();
    if (!next) {
      const after = current;
      next = after
        .catch(() => undefined)
        .then(() => {
          next = null;
          return start();
        });
    }
    return next;
  };
}

/**
 * Run `fn` unless a run started with the same gate is still going; then do
 * nothing (resolve undefined). For Send buttons: React state set by the
 * first tap is not visible to a second tap in the same frame, so a
 * state-only "busy" guard sends twice.
 */
export async function runExclusive<T>(gate: { current: boolean }, fn: () => Promise<T>): Promise<T | undefined> {
  if (gate.current) return undefined;
  gate.current = true;
  try {
    return await fn();
  } finally {
    gate.current = false;
  }
}
