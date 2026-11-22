/**
 * ADR 0311 addendum - offline, a saved copy stands in for the server's answer.
 * Kernel has no harness of its own, so the rules are tested here.
 */
import { describe, expect, it } from 'vitest';

import { keyboardOffset, readWithSavedCopy, showSavedThenFresh, type SavedCopyStore } from '@chord/kernel';

class OfflineErr extends Error {}
const isOffline = (e: unknown) => e instanceof OfflineErr;

function memoryStore(): SavedCopyStore & { files: Map<string, unknown>; writes: number } {
  const files = new Map<string, unknown>();
  const s = {
    files,
    writes: 0,
    async read<T>(name: string) {
      return (files.get(name) as { value: T } | undefined) ?? null;
    },
    async write(name: string, value: unknown) {
      s.writes += 1;
      files.set(name, value);
    },
  };
  return s;
}

const flush = () => new Promise((r) => setImmediate(r));

describe('readWithSavedCopy', () => {
  it('offline, the mailbox status saved online comes back, so the compose button has a mailbox', async () => {
    // The reported shape: online the status said a mailbox was connected;
    // offline the read failed, status stayed null and the button vanished.
    const store = memoryStore();
    const last = new Map<string, string>();
    const status = { connected: true, accounts: [{ id: 'a1' }] };
    await readWithSavedCopy('email-status', async () => status, store, isOffline, last);
    await flush();

    const offline = await readWithSavedCopy(
      'email-status',
      async () => {
        throw new OfflineErr('offline');
      },
      store,
      isOffline,
      new Map(),
    );
    expect(offline).toEqual(status);
  });

  it('offline with nothing saved, the original error is thrown', async () => {
    const err = new OfflineErr('offline');
    await expect(
      readWithSavedCopy(
        'email-decisions',
        async () => Promise.reject(err),
        memoryStore(),
        isOffline,
        new Map(),
      ),
    ).rejects.toBe(err);
  });

  it('a refusal from the server is never answered from the copy', async () => {
    const store = memoryStore();
    store.files.set('email-status', { value: { connected: true } });
    const refused = new Error('not signed in');
    await expect(
      readWithSavedCopy(
        'email-status',
        async () => Promise.reject(refused),
        store,
        isOffline,
        new Map(),
      ),
    ).rejects.toBe(refused);
  });

  it('writes only when the answer changed', async () => {
    const store = memoryStore();
    const last = new Map<string, string>();
    await readWithSavedCopy('tiles', async () => ({ n: 1 }), store, isOffline, last);
    await readWithSavedCopy('tiles', async () => ({ n: 1 }), store, isOffline, last);
    await readWithSavedCopy('tiles', async () => ({ n: 2 }), store, isOffline, last);
    await flush();
    expect(store.writes).toBe(2);
    expect(store.files.get('tiles')).toEqual({ value: { n: 2 } });
  });
});

describe('keyboardOffset', () => {
  it('counts the offline strip above the header, or the chat box sits under the keyboard', () => {
    // iPhone with a notch: strip = 47 (status bar) + 3 + 15 + 5 = 70, header 44.
    // Before the fix the screen was padded by 44 alone and lost 70pt.
    expect(keyboardOffset({ headerHeight: 44, aboveHeader: 70 })).toBe(114);
    expect(keyboardOffset({ headerHeight: 91, aboveHeader: 0 })).toBe(91);
  });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('showSavedThenFresh', () => {
  it('a launch shows the saved to-dos at once, then the server answer (no spinner while waiting)', async () => {
    // The reported shape: the phone holds a saved copy, the server is slow.
    // Before, the screen showed a spinner until the server answered.
    const server = deferred<string[]>();
    const shown: Array<[string[], string]> = [];
    const done = showSavedThenFresh({
      readSaved: async () => ['saved task'],
      fetch: () => server.promise,
      show: (v, from) => shown.push([v, from]),
    });
    await flush();
    expect(shown).toEqual([[['saved task'], 'saved']]);
    server.resolve(['fresh task']);
    await expect(done).resolves.toEqual(['fresh task']);
    expect(shown.at(-1)).toEqual([['fresh task'], 'server']);
  });

  it('a saved copy that arrives after the server answer is not shown over it', async () => {
    const saved = deferred<string[] | null>();
    const shown: string[] = [];
    await showSavedThenFresh({
      readSaved: () => saved.promise,
      fetch: async () => ['fresh'],
      show: (v) => shown.push(v[0]),
    });
    saved.resolve(['old']);
    await flush();
    expect(shown).toEqual(['fresh']);
  });

  it('nothing saved shows nothing until the server answers', async () => {
    const shown: string[] = [];
    await showSavedThenFresh({
      readSaved: async () => null,
      fetch: async () => ['fresh'],
      show: (v) => shown.push(v[0]),
    });
    expect(shown).toEqual(['fresh']);
  });

  it('a failed request keeps the saved copy on screen and still reports the error', async () => {
    const server = deferred<string[]>();
    const shown: string[] = [];
    const done = showSavedThenFresh({
      readSaved: async () => ['saved'],
      fetch: () => server.promise,
      show: (v) => shown.push(v[0]),
    });
    await flush();
    server.reject(new Error('500'));
    await expect(done).rejects.toThrow('500');
    expect(shown).toEqual(['saved']);
  });

  it('a store that cannot be read is the same as nothing saved', async () => {
    const shown: string[] = [];
    await showSavedThenFresh({
      readSaved: async () => {
        throw new Error('no key');
      },
      fetch: async () => ['fresh'],
      show: (v) => shown.push(v[0]),
    });
    expect(shown).toEqual(['fresh']);
  });
});
