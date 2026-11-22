/**
 * ADR 0311 addendum - a read the app shows offline keeps a copy of its last
 * answer, and offline that copy stands in for it. Pure (the store and the
 * fetch are passed in) so it can be tested; `mobile/` has no harness.
 */

export interface SavedCopyStore {
  read<T>(name: string): Promise<{ value: T } | null>;
  write(name: string, value: unknown): Promise<unknown>;
}

/**
 * Ask the server. An answer is saved (only when it changed since the last
 * save) and returned. When the request could not reach the server, the saved
 * copy is returned instead; with no copy, the original error is thrown. Any
 * other error (a refusal, a bug) is thrown untouched: a saved copy must never
 * hide the server saying no.
 */
export async function readWithSavedCopy<T>(
  name: string,
  fetch: () => Promise<T>,
  store: SavedCopyStore,
  isOffline: (err: unknown) => boolean,
  lastSaved: Map<string, string>,
): Promise<T> {
  let value: T;
  try {
    value = await fetch();
  } catch (err) {
    if (!isOffline(err)) throw err;
    const copy = await store.read<T>(name).catch(() => null);
    if (copy) return copy.value;
    throw err;
  }
  const json = JSON.stringify(value);
  if (lastSaved.get(name) !== json) {
    lastSaved.set(name, json);
    void store.write(name, { value }).catch(() => lastSaved.delete(name));
  }
  return value;
}

/**
 * The first screen comes from what this device saved: the saved copy is shown
 * while the server is asked, and the server's answer replaces it. A saved copy
 * read after the server answered is never shown (it would put older data
 * back). A failed request leaves the saved copy on screen, which beats a
 * spinner over an error; the caller still gets the error.
 */
export async function showSavedThenFresh<T>(a: {
  readSaved: () => Promise<T | null>;
  fetch: () => Promise<T>;
  show: (value: T, from: 'saved' | 'server') => void;
}): Promise<T> {
  let answered = false;
  void a.readSaved().then(
    (saved) => {
      if (saved != null && !answered) a.show(saved, 'saved');
    },
    () => {},
  );
  const value = await a.fetch();
  answered = true;
  a.show(value, 'server');
  return value;
}

/**
 * iOS pads a screen for the keyboard by the distance from the top of the
 * window to the screen's top. With the offline strip showing, that is the
 * strip plus the header, not the header alone.
 */
export function keyboardOffset(a: { headerHeight: number; aboveHeader: number }): number {
  return a.headerHeight + Math.max(0, a.aboveHeader);
}
