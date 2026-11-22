import { describe, expect, it } from 'vitest';

import {
  createCoalescer,
  createKeyedLatestGuard,
  createLatestGuard,
  resolveConditional,
  type TimerApi,
} from '@chord/kernel';

/** A hand-driven clock, so nothing here waits on real time. */
class FakeTimers implements TimerApi {
  now = 0;
  private next = 1;
  private due = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.due.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (h: unknown) => {
    this.due.delete(h as number);
  };
  advance(ms: number): void {
    this.now += ms;
    for (const [id, t] of [...this.due].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= this.now) {
        this.due.delete(id);
        t.fn();
      }
    }
  }
}

describe('createCoalescer', () => {
  // Prod 2026-10-23: one sync tick sent `email.synced` plus an
  // `email.tiles.updated` per touched thread, and the Email screen refetched
  // /me/email/decisions on every one (1,582 requests that day for 91 opens).
  it('turns a burst of ten events into one fetch', () => {
    const timers = new FakeTimers();
    let fetches = 0;
    const c = createCoalescer(() => fetches++, 300, timers);
    for (let i = 0; i < 10; i++) {
      c.trigger();
      timers.advance(20);
    }
    expect(fetches).toBe(0);
    timers.advance(300);
    expect(fetches).toBe(1);
  });

  it('fetches again for a burst that comes later', () => {
    const timers = new FakeTimers();
    let fetches = 0;
    const c = createCoalescer(() => fetches++, 300, timers);
    c.trigger();
    timers.advance(400);
    c.trigger();
    c.trigger();
    timers.advance(400);
    expect(fetches).toBe(2);
  });

  it('flush runs at once and swallows the pending trailing run', () => {
    const timers = new FakeTimers();
    let fetches = 0;
    const c = createCoalescer(() => fetches++, 300, timers);
    c.trigger();
    c.flush();
    expect(fetches).toBe(1);
    timers.advance(1000);
    expect(fetches).toBe(1);
  });

  it('cancel (screen left) drops the pending run', () => {
    const timers = new FakeTimers();
    let fetches = 0;
    const c = createCoalescer(() => fetches++, 300, timers);
    c.trigger();
    expect(c.pending()).toBe(true);
    c.cancel();
    timers.advance(1000);
    expect(fetches).toBe(0);
    expect(c.pending()).toBe(false);
  });
});

describe('createLatestGuard', () => {
  it('lets only the newest request apply its answer', () => {
    const g = createLatestGuard();
    const first = g.begin();
    const second = g.begin();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});

describe('createKeyedLatestGuard', () => {
  // catchup/[tab].tsx loadKey: two loads of 'tasks' in flight (focus, then
  // an SSE refetch); the OLDER answer landed last and overwrote the newer,
  // and a load started before a tick brought the task back unticked.
  it('keeps the newest load per key, and a local change outdates one in flight', async () => {
    const g = createKeyedLatestGuard<'tasks' | 'lists'>();
    let shown = 'none';
    const load = async (answer: string, wait: Promise<void>) => {
      const current = g.begin('tasks');
      await wait;
      if (current()) shown = answer;
    };
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const old = load('old', new Promise((r) => (releaseOld = r)));
    const fresh = load('new', new Promise((r) => (releaseNew = r)));
    const lists = g.begin('lists');
    releaseNew();
    await fresh;
    releaseOld();
    await old;
    expect(shown).toBe('new');
    expect(lists()).toBe(true);

    const beforeTick = g.begin('tasks');
    g.invalidate('tasks');
    expect(beforeTick()).toBe(false);
  });
});

describe('resolveConditional', () => {
  it('a 304 returns the very object already held, so nothing re-renders', () => {
    const body = { decisions: [] };
    const cached = { etag: 'W/"1"', body };
    const out = resolveConditional(cached, 304, null, undefined);
    expect(out.body).toBe(body);
    expect(out.entry).toBe(cached);
  });

  it('a 200 replaces the remembered body', () => {
    const out = resolveConditional({ etag: 'W/"1"', body: 1 }, 200, 'W/"2"', 2);
    expect(out).toEqual({ body: 2, entry: { etag: 'W/"2"', body: 2 } });
  });

  it('a 200 without an ETag forgets the entry', () => {
    const out = resolveConditional({ etag: 'W/"1"', body: 1 }, 200, null, 2);
    expect(out).toEqual({ body: 2, entry: undefined });
  });

  it('a 304 with nothing remembered is an error, not an empty list', () => {
    expect(() => resolveConditional(undefined, 304, null, undefined)).toThrow();
  });
});
