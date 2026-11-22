/**
 * Streams come back after the server ends them (kernel stream-supervisor).
 * Kernel has no harness of its own, so the rules are tested here.
 */
import { describe, expect, it } from 'vitest';

import {
  STREAM_REOPEN_MAX_MS,
  StreamSupervisor,
  streamEndIsFinal,
  streamReopenDelay,
  type StreamTransportHooks,
} from '@chord/kernel';

/** A hand-driven clock and timer queue: nothing here waits real time. */
function rig(opts: { allowed?: () => boolean; failOpens?: number } = {}) {
  let now = 0;
  const timers: { fn: () => void; at: number; ms: number }[] = [];
  const conns: { hooks: StreamTransportHooks; closed: boolean }[] = [];
  let failOpens = opts.failOpens ?? 0;
  const sup = new StreamSupervisor({
    open: async (hooks) => {
      if (failOpens > 0) {
        failOpens--;
        throw new Error('502');
      }
      const c = { hooks, closed: false };
      conns.push(c);
      return { close: () => (c.closed = true) };
    },
    allowed: opts.allowed ?? (() => true),
    schedule: (fn, ms) => {
      const t = { fn, at: now + ms, ms };
      timers.push(t);
      return t;
    },
    cancel: (t) => {
      const i = timers.indexOf(t as (typeof timers)[number]);
      if (i >= 0) timers.splice(i, 1);
    },
    now: () => now,
    random: () => 0.5,
  });
  const fireTimer = async () => {
    const t = timers.shift();
    if (!t) throw new Error('no timer pending');
    now = t.at;
    t.fn();
    // resume() awaits the opener once; let it settle.
    await new Promise((r) => setImmediate(r));
  };
  return {
    sup,
    conns,
    timers,
    fireTimer,
    advance: (ms: number) => (now += ms),
  };
}

describe('StreamSupervisor', () => {
  it('a deploy ending the stream with shutdown reopens it', async () => {
    // The reported shape: web.ts closeAll('shutdown') on every deploy, after
    // which the chat and mail screens stopped getting live updates.
    const r = rig();
    await r.sup.start();
    expect(r.sup.isOpen).toBe(true);
    r.conns[0].hooks.opened();
    r.conns[0].hooks.ended('shutdown');
    expect(r.sup.isOpen).toBe(false);
    expect(r.timers).toHaveLength(1);
    await r.fireTimer();
    expect(r.conns).toHaveLength(2);
    expect(r.sup.isOpen).toBe(true);
  });

  it('a browser EventSource that gave up (closed on a 502) reopens too', async () => {
    const r = rig();
    await r.sup.start();
    r.conns[0].hooks.ended('closed');
    await r.fireTimer();
    expect(r.sup.isOpen).toBe(true);
  });

  it('signed out, not a member, or the group gone: never reopened', async () => {
    for (const reason of ['unauthorized', 'forbidden', 'group_deleted'] as const) {
      const r = rig();
      await r.sup.start();
      r.conns[0].hooks.ended(reason);
      expect(r.timers).toHaveLength(0);
      expect(r.sup.isFinished).toBe(true);
      await r.sup.resume();
      expect(r.conns).toHaveLength(1);
    }
  });

  it('a reopen that keeps failing backs off and keeps trying', async () => {
    const r = rig({ failOpens: 3 });
    await expect(r.sup.start()).rejects.toThrow('502');
    // The first open's failure is the caller's; a resume then retries on its own.
    await r.sup.resume();
    await r.sup.resume();
    expect(r.timers).toHaveLength(1);
    const first = r.timers[0].ms;
    await r.fireTimer();
    expect(r.timers).toHaveLength(0);
    expect(r.sup.isOpen).toBe(true);
    expect(first).toBeGreaterThan(0);
  });

  it('the delay grows on repeated quick ends and starts over after a stable connection', async () => {
    const r = rig();
    await r.sup.start();
    r.conns[0].hooks.opened();
    r.conns[0].hooks.ended('shutdown');
    const d1 = r.timers[0].ms;
    await r.fireTimer();
    r.conns[1].hooks.opened();
    r.conns[1].hooks.ended('shutdown');
    const d2 = r.timers[0].ms;
    expect(d2).toBeGreaterThan(d1);
    await r.fireTimer();
    r.conns[2].hooks.opened();
    r.advance(60_000);
    r.conns[2].hooks.ended('shutdown');
    expect(r.timers[0].ms).toBe(d1);
  });

  it('an end from a connection already parked is ignored', async () => {
    const r = rig();
    await r.sup.start();
    r.sup.park();
    r.conns[0].hooks.ended('shutdown');
    expect(r.timers).toHaveLength(0);
  });

  it('parked (backgrounded, offline) a pending reopen is cancelled, and resume brings it back', async () => {
    let allowed = true;
    const r = rig({ allowed: () => allowed });
    await r.sup.start();
    r.conns[0].hooks.ended('shutdown');
    allowed = false;
    r.sup.park();
    expect(r.timers).toHaveLength(0);
    await r.sup.resume();
    expect(r.sup.isOpen).toBe(false);
    allowed = true;
    await r.sup.resume();
    expect(r.sup.isOpen).toBe(true);
  });

  it('closed by the screen: nothing reopens', async () => {
    const r = rig();
    await r.sup.start();
    r.sup.close();
    expect(r.conns[0].closed).toBe(true);
    r.conns[0].hooks.ended('shutdown');
    await r.sup.resume();
    expect(r.conns).toHaveLength(1);
  });
});

describe('streamReopenDelay', () => {
  it('spreads reconnects and caps them', () => {
    expect(streamReopenDelay(0, () => 0)).toBe(1000);
    expect(streamReopenDelay(0, () => 1)).toBe(3000);
    expect(streamReopenDelay(50, () => 0.5)).toBe(STREAM_REOPEN_MAX_MS);
  });
});

describe('streamEndIsFinal', () => {
  it('only a refusal is final', () => {
    expect(streamEndIsFinal('shutdown')).toBe(false);
    expect(streamEndIsFinal('closed')).toBe(false);
    expect(streamEndIsFinal('unauthorized')).toBe(true);
  });
});
