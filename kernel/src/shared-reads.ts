/**
 * Identical reads already on the wire share one request: several screens and
 * effects ask for the same list at mount, and each used to cost a round trip.
 * Only while in flight - nothing is kept once it answers.
 *
 * A write ends the sharing. A read asked for after a write must not join one
 * sent before it, or it gets the answer from before the write: putting an
 * email in Trash, then re-reading the list, handed back the list with the
 * email still in it, so it was deleted again and again. `forget` drops the
 * reads on the wire from the table (their own callers still get their answer)
 * so the next read is sent fresh.
 */
export interface SharedReads {
  share<T>(key: string, run: () => Promise<T>): Promise<T>;
  forget(): void;
}

export function createSharedReads(): SharedReads {
  const inFlight = new Map<string, Promise<unknown>>();
  return {
    share<T>(key: string, run: () => Promise<T>): Promise<T> {
      const pending = inFlight.get(key) as Promise<T> | undefined;
      if (pending) return pending;
      const p = run().finally(() => {
        if (inFlight.get(key) === p) inFlight.delete(key);
      });
      inFlight.set(key, p);
      return p;
    },
    forget(): void {
      inFlight.clear();
    },
  };
}
